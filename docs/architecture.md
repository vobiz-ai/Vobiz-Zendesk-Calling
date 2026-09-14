# Architecture

How the pieces fit, and why some of the odd-looking decisions are the way they
are. Read this before changing the call path.

- [Three app locations, three jobs](#three-app-locations-three-jobs)
- [An outbound call, end to end](#an-outbound-call-end-to-end)
- [An inbound call](#an-inbound-call)
- [Bridging to a phone instead of the browser](#bridging-to-a-phone-instead-of-the-browser)
- [Binding inbound audio](#binding-inbound-audio)
- [How a call reaches a ticket](#how-a-call-reaches-a-ticket)
- [Recording links](#recording-links)
- [Where credentials live](#where-credentials-live)

## Three app locations, three jobs

A ZAF app can run in several places at once. Each instance is a **separate
iframe with its own JavaScript context** — they share no variables, and talk
only through ZAF messaging.

| Location | File | Job |
| --- | --- | --- |
| `top_bar` | `assets/index.html` | The softphone. SIP registration, dialpad, call UI, logging. |
| `background` | `assets/background.html` | Invisible. Listens for Zendesk's `voice.dialout` and relays it. |
| `ticket_sidebar` | `assets/sidebar.html` | Reports which ticket the agent is on. |

The `ticket_sidebar` instance exists for one reason: **ZAF exposes `ticket.id`
only to an instance that is in ticket context.** The top bar has none — it is
global. Without a sidebar instance, `findCurrentTicketId()` can never resolve a
ticket, and every call log creates a brand-new ticket instead of commenting on
the one the agent is looking at.

### Click-to-dial

Zendesk emits `voice.dialout` when an agent clicks a phone number. That event
only reaches the `background` instance, which then finds the `top_bar` instance
and forwards the number to it:

```js
// background.js
client.on('voice.dialout', event => {
  getTopBarClient().then(topBar => {
    topBar.invoke('popover', 'show');                  // slide the panel open
    topBar.trigger('cti.triggerDialer', {              // custom app-internal event
      number: event.number, userId: event.userId, ticketId: event.ticketId
    });
  });
});
```

`cti.triggerDialer` is **our own event name**, not a Zendesk API. It is the
message we send between our two instances. `voice.dialout` is the real Zendesk
event, and it only fires on accounts with Talk Partner Edition enabled — on
other plans the manual dialpad still works.

## An outbound call, end to end

```
 agent clicks Call
        │
        ├─► POST {backend}/start-call  {to, agentId, authId, authToken, fromNumber}
        │
        │   backend ──► POST api.vobiz.ai/.../Call/  {from, to, answer_url, record}
        │                     │
        │                     ▼
        │            Vobiz dials the CUSTOMER
        │                     │
        │              customer answers
        │                     │
        │                     ▼
        │   Vobiz ──► GET  {tunnel}/call-answer?agentId=…   (the webhook)
        │                     │
        │              backend returns VXML:
        │              <Dial record="true"><User>agent-priya…</User></Dial>
        │                     │
        │                     ▼
        │            Vobiz dials INTO the browser's registered SIP endpoint
        │                     │
        └─────────────► JsSIP `newRTCSession` → auto-answer → audio flows
```

**The order cannot be reversed.** The Vobiz REST API cannot originate a call to
a registered WebRTC endpoint — it returns `Endpoint Not Registered`. So the
customer is dialled first and the agent is bridged in second.

The visible consequence: **the customer hears a second or two of ringback after
they answer**, while the agent's browser leg is being set up. That is expected
behaviour, not a bug, and it is worth telling agents so they do not hang up.

### Diagnosing from the CDR

`hangup_cause_name` tells you where a call stopped:

| Value | Meaning |
| --- | --- |
| `Normal Hangup` | The call completed. |
| `End Of XML Instructions` | Vobiz fetched and executed the webhook, but the `<Dial>` had nothing to reach — usually an unregistered SIP endpoint. |
| `No Answer` / `Busy` | The customer leg never connected; the webhook was never fetched. |

## An inbound call

A call to one of your Vobiz numbers hits the same `/call-answer` webhook, which
branches on the `inboundNumber` query parameter:

- **Not dialable, or one of your own account DIDs** → bridge to the agent's
  WebRTC endpoint with `<User>`.
- **A dialable external number** → bridge to that phone with `<Number>`.

There is a subtlety in that branch. Deciding "is this one of our own DIDs"
requires the account's number list, which is cached in memory the first time
`/numbers` is called. Straight after a restart the cache is empty, and an
account DID would be misread as an external number — causing the platform to
dial its own inbound number and loop. The code therefore treats an **unwarmed
cache as "route to the agent"**, which is always safe.

## Bridging to a phone instead of the browser

The `<Number>` branch above is a fully working path to route calls to an
agent's mobile or desk phone instead of the browser. The backend supports it
today; the app has no UI for it.

This matters for the Indian market in particular, where agents commonly take
calls on a mobile rather than a headset. It also sidesteps every browser
concern at once — microphone permissions, WebRTC, and the undocumented
Content-Security-Policy applied to app iframes.

Adding it is a UI change plus threading `inboundNumber` through `/start-call`.

## Binding inbound audio

Worth knowing before touching the SIP code.

For an **incoming** session, JsSIP has not created the `RTCPeerConnection` yet —
`session.connection` is `null` until the call is answered. Dereferencing it
inside the `newRTCSession` handler throws, and because the throw happens inside
that handler it aborts **before `.answer()` runs**. The symptom is nasty and
misleading: the browser silently never picks up, Vobiz rings the endpoint until
it times out, and the customer is never connected.

Bind through the `peerconnection` event instead:

```js
session.on('peerconnection', e => bindTrack(e.peerconnection));
bindTrack(session.connection);   // no-op on the incoming path
```

## How a call reaches a ticket

There is no Zendesk "call" object available to a normal app, so calls are
recorded as ordinary tickets and comments.

```
agent presses Log Call
        │
        ├─ activeTicketId ← the ticket the agent clicked from,
        │                   else whatever ticket_sidebar reports
        │
        ├─ POST {backend}/sync-call
        │       │
        │       ├─ Talk Partner Edition path, if credentials allow   ─┐
        │       └─ standard Tickets API:                              │
        │            PUT  /api/v2/tickets/{id}.json   (private comment)
        │            POST /api/v2/tickets.json        (new ticket)
        │
        └─ on failure, the app writes it through the agent's own
           Zendesk session with client.request(...)
```

The fallback is the better path in one respect worth understanding: writing
through `client.request` attributes the comment to **the agent**, whereas the
backend path attributes everything to a single shared API user.

### Caller lookup

Screen pop is a ZAF search from the browser:

```js
client.request(`/api/v2/search.json?query=${encodeURIComponent(`type:user phone:${cleanPhone}`)}`)
client.invoke('routeTo', 'user', resolvedUser.id);   // the screen pop itself
```

The query must be URL-encoded — it contains a space and colons.

## Recording links

A recording link is written into a ticket, where it is readable by every agent,
every export, and every audit log, forever. It therefore cannot carry
credentials.

```
/sync-call        seals {authId, authToken, callUuid, exp}
                  with AES-256-GCM  →  opaque token
                          │
                  the ticket gets:  {backend}/play-recording?token=…
                          │
/play-recording   opens the token, fetches the audio from Vobiz with the
                  credentials inside it, and streams it back
```

The key comes from `RECORDING_TOKEN_SECRET`. If that is unset, a random key is
generated at boot — links then work until the next restart and no further. The
backend warns about this on startup.

A missing recording returns **404**, not a 200 with an HTML page, so an
`<audio>` element can tell the difference.

## Where credentials live

| Credential | Where it lives | Notes |
| --- | --- | --- |
| Vobiz Auth ID / Token | The agent's browser session | Sent per request. Never stored server-side, never in a ticket. |
| SIP password | `backend/agents.json` | Server-side only, gitignored. |
| Recording token key | `RECORDING_TOKEN_SECRET` | Encrypts credentials into recording links. |
| Zendesk API token | Zendesk app setting, marked `secure` | Optional. Only if the backend writes logs itself. |

The deliberate trade-off: **agents type their Vobiz credentials into the
panel.** That keeps one shared account token out of the app, but it does mean
the credentials pass through the backend on each request. The backend must
therefore be trusted and reachable only over HTTPS — see
[SECURITY.md](../SECURITY.md).
