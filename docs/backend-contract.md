# Backend API contract

Every route `backend/server.js` exposes. Use it to replace the backend with your
own implementation, or to understand what the app expects. `backend/test/`
exercises most of these over HTTP.

Two groups:

- **Webhooks** — called by Vobiz. Public, form-encoded (`application/x-www-form-urlencoded`), never behind a session.
- **Browser routes** — called by the Zendesk app with `Authorization: Bearer <session token>` where marked **session**. JSON bodies.

The backend is bound to one Vobiz account, one caller ID and one SIP endpoint
through `backend/.env`.

---

## Webhooks (Vobiz → backend)

### `GET|POST /answer` (also `/inbound-answer`)

The answer URL of the Vobiz application the SIP endpoint and the DID are
attached to. One handler, two directions, decided by `From`:

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

The caller ID is, in order: an `X-VH-Caller-ID` SIP header from the panel, the
number chosen in the panel, `VOBIZ_FROM_NUMBER`. `To` and the caller ID must be
plain phone numbers, otherwise the call is rejected with
`<Hangup reason="rejected"/>`.

**Inbound** — `From` is a phone number. Returns the same `<Record>`, then
`<Dial callerId="{dialled DID in E.164}" …><User>sip:{VOBIZ_SIP_USER}@registrar.vobiz.ai</User></Dial>`.
`callerId` must be a number the account owns; the dialled DID is.

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

`{ "agentId", "authId", "authToken" }` → `{ "token", "numbers", "selected", "authId" }`.
401 unless `authId` / `authToken` match `.env`.

### `GET /session` · `POST /logout`

Session state for the bearer token, and sign-out.

### `POST /login-sip`

SIP-direct sign-in: `{ "sipUser", "callerId" }`. Records which caller ID that
SIP user dials out as. 400 unless `callerId` is a number on this account.

### `GET /agent` — **session**

```json
{ "displayName": "priya (Vobiz)", "sipUser": "zendeskagent1187…@registrar.vobiz.ai",
  "registrarUrl": "wss://registrar.vobiz.ai:5063/", "sipPassword": "…" }
```

### `GET /numbers` · `POST /select-number` — **session**

The account's numbers, and choose the outbound caller ID (`{ "number" }`; must
be on the account).

### `POST /setup` — **session**

Finds or creates the Vobiz application whose answer URL is
`{PUBLIC_BASE}/answer` and binds `VOBIZ_SIP_USER` to it. Called on sign-in.

### `POST /setup-inbound` — **session**

`/setup`, plus attaches `VOBIZ_FROM_NUMBER` to the application
(`POST /numbers/{e164}/application`). This **detaches the number from any other
application**.

### `GET /call-record?to=<number>` — **session**

The most recent call to or from that number, polled after hangup:

```json
{ "found": true, "callUuid": "…", "direction": "Outbound", "from": "+91…", "to": "91…",
  "duration": 34, "dialStatus": "completed", "bLegUuid": "…", "recordingId": null,
  "recordingUrl": "{PUBLIC_BASE}/play-recording?callUuid=…&exp=…&sig=…" }
```

### `GET /recordings?limit=15` — **session**

`{ "objects": [{ "recording_id", "call_uuid", "add_time", "rounded_recording_duration", "playUrl" }] }`.
`playUrl` is a signed `/recording-audio/…` link valid for
`RECORDING_URL_TTL_SECONDS`.

### `GET /recording-audio/:recordingId?exp=&sig=`

Streams one recording. 403 without a valid, unexpired signature.

### `GET /play-recording?callUuid=&exp=&sig=`

The link written into ticket comments. Signed over the call UUID, valid for
`TICKET_RECORDING_LINK_TTL_SECONDS`. Streams only a recording whose
`call_uuid` matches; 404 while it is still processing.

### `POST /sync-call` — **session**

`{ "ticketId", "toNumber", "duration", "callDirection", "notes", "requesterId", "callUuid" }`.
Writes the call to Zendesk with the credentials in `.env` (comment on the
ticket, or a new ticket), including the signed recording link. 400 when Zendesk
credentials are not configured, in which case the panel writes through the
agent's own Zendesk session instead.

### `POST /transcription-ready`

Off unless `TRANSCRIPTION_WEBHOOK_SECRET` is set. Requires
`Authorization: Bearer <secret>`. `{ "ticketId", "transcript", "callId" }`
appends the transcript as a private comment.

### `GET /health`

Resolved configuration: account ID, caller ID, SIP URI, public base, Zendesk
subdomain, session and call counts. No secrets.
