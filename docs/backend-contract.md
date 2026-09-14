# Backend API contract

Every route `backend/server.js` exposes. Use this to replace the backend with
your own implementation, or to understand what the app expects.

Routes fall into two groups:

- **Browser routes** — called by the Zendesk app.
- **Webhooks** — called by the Vobiz platform. These must be reachable from the
  public internet.

> **None of these routes are authenticated.** See
> [SECURITY.md](../SECURITY.md#the-backend-is-unauthenticated) before exposing
> this beyond a development tunnel.

## Conventions

Base URL is the app's `backend_url` setting. Bodies are JSON unless stated.
Vobiz credentials may be supplied three ways, in order of precedence:

1. the request body or query string (`authId` / `authToken`),
2. the `X-Auth-ID` / `X-Auth-Token` headers,
3. `VOBIZ_AUTH_ID` / `VOBIZ_AUTH_TOKEN` in the backend environment.

The app uses the first. The third exists for unattended testing.

---

## Browser routes

### `GET /agent/:agentId`

The SIP identity the softphone registers with. Looked up in `agents.json`.

```json
{
  "name": "Priya Sharma",
  "sipUser": "agent-priya1187694299145202883643",
  "sipPassword": "…",
  "displayName": "Priya Sharma"
}
```

`sipUser` may be a bare username or `user@domain`. The app builds
`sip:{sipUser}@registrar.vobiz.ai` when no domain is present.

Unknown IDs fall back to a synthesised agent rather than 404ing, which is
convenient in development and a footgun in production — a typo silently routes
a call to the wrong endpoint.

### `GET /numbers`

Phone numbers on the account. Proxies the Vobiz numbers API and **caches the
result in memory**, which `/call-answer` later relies on to tell your own DIDs
from external numbers.

```
GET /numbers?authId=MA_XXXXXXXX&authToken=…
```

```json
{ "numbers": ["+911140848108", "+911140848109"], "source": "vobiz_api", "count": 2 }
```

| Status | Meaning |
| --- | --- |
| 200 | Numbers returned |
| 400 | Credentials missing |
| 5xx | Vobiz unreachable |

### `POST /start-call`

Places an outbound call. Dials the **customer** first; the agent is bridged in
when `/call-answer` is fetched. See
[architecture](architecture.md#an-outbound-call-end-to-end).

```json
{
  "to": "+919876543210",
  "agentId": "priya",
  "fromNumber": "+911140848108",
  "authId": "MA_XXXXXXXX",
  "authToken": "…",
  "inboundNumber": ""
}
```

Returns the Vobiz response unchanged:

```json
{ "api_id": "bf2cf586-…", "message": "call queued", "request_uuid": "e6b09bec-…" }
```

Keep `request_uuid` — it is the call's identity for hangup, recording, and
logging.

`inboundNumber` is optional. Supply a phone number to bridge the call to that
phone instead of the browser.

### `POST /hangup-call`

Terminates a live call through the REST API.

```json
{ "callUuid": "e6b09bec-…", "authId": "MA_XXXXXXXX", "authToken": "…" }
```

```json
{ "ok": true, "result": { … } }
```

Returns a non-2xx with `{ "ok": false, "error": … }` if Vobiz rejects it. Do
not treat a 200 as proof the call ended without checking `ok`.

Omitting `callUuid` is a no-op success — the browser's SIP `BYE` already handled
the hangup.

### `POST /sync-call`

Writes a call log into Zendesk, and mints the recording link.

```json
{
  "subdomain": "yourcompany",
  "email": "agent@yourcompany.com",
  "apiToken": "…",
  "ticketId": 12345,
  "fromNumber": "+911140848108",
  "toNumber": "+919876543210",
  "duration": 96,
  "callDirection": "Outbound",
  "notes": "Customer asked about billing.",
  "requesterId": 987,
  "callUuid": "e6b09bec-…",
  "authId": "MA_XXXXXXXX",
  "authToken": "…"
}
```

```json
{ "success": true, "mode": "standard_api", "ticketId": 12345, "data": { … } }
```

`mode` reports which strategy succeeded — the Talk Partner Edition path or the
standard Tickets API.

If `callUuid`, `authId` and `authToken` are all present, the comment includes a
recording link of the form `/play-recording?token=…`. **The credentials are
sealed into that token, never placed in the URL.**

Omit `ticketId` to create a new ticket instead of commenting on one.

### `GET /play-recording`

Streams a recording. Two ways to call it:

```
GET /play-recording?token=<sealed token>              ← preferred
GET /play-recording?callUuid=…&authId=…&authToken=…   ← development only
```

The token form is what `/sync-call` writes into tickets. The credential form
exists for local testing and should never appear in a URL that gets stored.

| Status | Meaning |
| --- | --- |
| 200 | Audio, with the upstream content type |
| 400 | Neither a token nor credentials supplied |
| 403 | Token invalid, tampered with, or expired |
| 404 | No recording for that call |

Tokens expire after `RECORDING_TOKEN_TTL_MS` (default 30 days) and are sealed
with `RECORDING_TOKEN_SECRET`. Restarting without that secret set invalidates
every link previously issued.

### `POST /transcription-ready`

Appends an AI transcript to a ticket as a private comment.

```json
{
  "subdomain": "yourcompany",
  "email": "agent@yourcompany.com",
  "apiToken": "…",
  "ticketId": 12345,
  "transcript": "Agent: Good morning…",
  "callId": "e6b09bec-…"
}
```

```json
{ "success": true, "ticketId": 12345, "data": { … } }
```

---

## Webhooks

Called by Vobiz, not by the browser. **These must be publicly reachable.**

### `GET|POST /call-answer`

The heart of the call flow. Vobiz fetches this when the customer answers, and
executes whatever XML comes back.

| Parameter | Purpose |
| --- | --- |
| `agentId` | Which agent to bridge to |
| `fromNumber` | Caller ID for the second leg |
| `inboundNumber` | If a dialable external number, bridge to that phone instead of the browser |

Returns `text/xml`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial record="true" redirect="false" callerId="+911140848108">
    <User>agent-priya1187694299145202883643</User>
  </Dial>
</Response>
```

`<User>` bridges to the registered WebRTC endpoint; `<Number>` bridges to a
phone. Every interpolated value is XML-escaped, and `callerId` is emitted only
when the value is dialable — this endpoint's output is executed by the
platform, so unescaped input here is a call-flow injection.

---

## Implementing your own backend

The minimum for outbound calling with browser audio:

1. `GET /agent/:agentId` — return a SIP identity.
2. `POST /start-call` — dial the customer, pointing `answer_url` at your own
   `/call-answer`.
3. `GET /call-answer` — return `<Dial><User>…</User></Dial>`.

`/numbers`, `/hangup-call`, `/sync-call`, `/play-recording` and
`/transcription-ready` add number selection, REST hangup, ticket logging and
recording playback respectively. The app degrades without them rather than
breaking.

If you implement `/play-recording`, do not accept credentials in the query
string of a URL you then store somewhere durable. Seal them, or sign a
short-lived URL.
