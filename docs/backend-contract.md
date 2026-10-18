# Backend API contract

Every route `backend/server.js` exposes. Use it to replace the backend with your
own implementation, or to understand what the app expects. `backend/test/`
exercises most of these over HTTP.

Two groups:

- **Webhooks** — called by Vobiz. Public, form-encoded (`application/x-www-form-urlencoded`), never behind a session.
- **Browser routes** — called by the Zendesk app with `Authorization: Bearer <session token>` where marked **session**. JSON bodies.

The backend works with **any Vobiz account**. Nothing account-specific is in
`backend/.env`: an agent signs in with an Auth ID and Auth Token, and the
backend provisions an application and a per-agent SIP endpoint inside that
account. The Auth Token is kept in memory only, keyed by Auth ID, and is never
returned to the browser, logged or written to disk.

---

## Webhooks (Vobiz → backend)

### `GET|POST /answer` (also `/inbound-answer`)

The answer URL of this integration's Vobiz application, in every account that
signs in. One handler, two directions, decided by `From`:

**Outbound** — `From` is a `sip:` URI (or `RouteType=sip`): the browser sent the
INVITE. Returns:

```xml
<Response>
  <Record fileFormat="mp3" recordSession="true" maxLength="3600" playBeep="false"
          redirect="false" callbackUrl="{PUBLIC_BASE}/recording-ready" callbackMethod="POST"/>
  <Dial callerId="{caller ID}" timeout="30" timeLimit="14400"
        action="{PUBLIC_BASE}/dial-status" method="POST" redirect="false">
    <Number>{To}</Number>
  </Dial>
</Response>
```

The SIP username in `From` identifies the agent, and through it the account.
The caller ID is the `X-VH-Caller-ID` SIP header from the panel (top-level
param, possibly prefixed `SIPHeader_`) when it is a strict E.164 number — and,
for an account sign-in, one of that account's own numbers — otherwise the number
the agent chose in the panel (account mode) or typed (SIP direct). An unknown
SIP username, or a `To`/caller ID that is not a plain phone number, gets
`<Hangup reason="rejected"/>`.

**Inbound** — `From` is a phone number. The account is the webhook's
`ParentAuthID`; if that is absent (or nobody from it is signed in here), the
account whose number list contains the dialled `To`; failing that, SIP-direct
agents who typed that number. Returns the same `<Record>`, then
`<Dial callerId="{dialled DID in E.164}" …>` with one
`<User>sip:{agent endpoint}@registrar.vobiz.ai</User>` per signed-in agent of
that account (simultaneous ring). `0XXXXXXXXXX` becomes `+91XXXXXXXXXX`;
anything else without `+` gets one. No match → `<Speak>` + `<Hangup/>` and a log
line.

**`Event=Hangup`** — returns an empty `<Response></Response>`.

### `GET|POST /dial-status`

The `<Dial action>` target. Records `DialStatus`, `DialHangupCause`,
`DialBLegUUID` and `DialBLegDuration` against the A-leg `CallUUID`. An empty
`DialBLegUUID` means no customer leg was ever created.

### `GET|POST /recording-ready`

The `<Record callbackUrl>` target. Records `RecordingID` and
`RecordingDuration` against the call.

---

## Browser routes

### `POST /login`

`{ "agentId", "authId", "authToken" }` → `{ "token", "numbers", "numberApps", "selected", "appId", "authId", "sipUser", "bound" }`.

1. Verifies the pair with `GET /Account/{authId}/numbers?page=N&per_page=100`
   (paged until `total`). Non-2xx → **401**.
2. Find-or-create the application whose `answer_url` is `{PUBLIC_BASE}/answer`
   (never edits one it did not create).
3. Find-or-create one endpoint per `(authId, agentId)` — from
   `{DATA_DIR}/endpoints.json` (ids and usernames only, mode 0600), else by its
   exact alias — then sets a fresh random SIP password on it
   (`POST /Endpoint/{id}/ {"password"}`). The stored username is always read
   back with `GET /Endpoint/{id}/`, because Vobiz rewrites it on create.
4. Binds it with `POST /Endpoint/{id}/ {"app_id":"<id>"}`, verifies with a GET,
   and if not bound retries once with the documented
   `{"application": <integer>}`. App ids are 17 digits, so they are kept as
   strings and spliced into the body text, never passed through a JS number.

`numbers` are the account's numbers with `status` `active` and
`voice_enabled` not false — the caller-ID dropdown. `numberApps` maps each to
the application it is on now. Default selection is the agent's last choice.

### `GET /session` · `POST /logout`

Session state for the bearer token (no credentials), and sign-out.

### `POST /login-sip`

SIP-direct sign-in, no account credentials: `{ "sipUser", "callerId" }`.
Records `sipUser → caller ID`; that number is also the inbound number that
rings this agent. 400 unless `callerId` is a plain E.164 number; 409 if the SIP
user is an endpoint signed in through an account. Ownership is enforced by
Vobiz itself at dial time. The endpoint and DID must already be on an
application whose answer URL is this backend (see the README, "SIP direct").

### `GET /agent` — **session**

This agent's own endpoint, with the password minted at this sign-in:

```json
{ "displayName": "priya (Vobiz)", "sipUser": "zdpriya…@registrar.vobiz.ai",
  "registrarUrl": "wss://registrar.vobiz.ai:5063/", "sipPassword": "…" }
```

### `GET /numbers` · `POST /select-number` — **session**

The caller-ID list (with `numberApps`), and choose the outbound caller ID
(`{ "number" }`; 400 unless it is in that list).

### `POST /setup-inbound` — **session**

The panel's **Enable inbound calls**. Attaches the selected number to the
integration's application (`POST /numbers/%2B{digits}/application`
`{"application_id":"<id>"}`). This **moves the number off any other
application**; the response names it as `previousAppId`. Never done at sign-in.

### `GET /call-record?to=<number>` — **session**

The most recent call to or from that number in the session's account, polled
after hangup:

```json
{ "found": true, "callUuid": "…", "direction": "Outbound", "from": "+91…", "to": "91…",
  "duration": 34, "dialStatus": "completed", "bLegUuid": "…", "recordingId": null,
  "recordingUrl": "{PUBLIC_BASE}/play-recording?authId=…&callUuid=…&exp=…&sig=…" }
```

### `GET /recordings?limit=15` — **session**

`{ "objects": [{ "recording_id", "call_uuid", "add_time", "rounded_recording_duration", "playUrl" }] }`.
`playUrl` is a signed `/recording-audio/…` link valid for
`RECORDING_URL_TTL_SECONDS`.

### `GET /recording-audio/:recordingId?authId=&exp=&sig=`

Streams one recording with that account's credentials. The HMAC covers the
Auth ID and the recording id, so changing `authId` breaks it: 403 without a
valid, unexpired signature.

### `GET /play-recording?authId=&callUuid=&exp=&sig=`

The link written into ticket comments. Signed over the Auth ID and the call
UUID, valid for `TICKET_RECORDING_LINK_TTL_SECONDS`. Streams only a recording
whose `call_uuid` matches; 404 while it is still processing.

Both return **409** with "sign in again" when the backend has restarted and
nobody from that account has signed in since: the token is held in memory
only.

### `POST /sync-call` — **session**

`{ "ticketId", "toNumber", "duration", "callDirection", "notes", "requesterId", "callUuid" }`.
Writes the call to Zendesk with the Zendesk credentials in `.env` (comment on the
ticket, or a new ticket), including the signed recording link. 400 when Zendesk
credentials are not configured, in which case the panel writes through the
agent's own Zendesk session instead.

### `POST /transcription-ready`

Off unless `TRANSCRIPTION_WEBHOOK_SECRET` is set. Requires
`Authorization: Bearer <secret>`. `{ "ticketId", "transcript", "callId" }`
appends the transcript as a private comment.

### `GET /health`

Public base, Zendesk subdomain, and counts of signed-in accounts, sessions and
recent calls. No account ids, no secrets.
