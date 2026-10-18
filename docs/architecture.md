# Architecture

The browser is the A leg: the panel places the call itself, and the backend
only tells Vobiz where to connect it.

## An outbound call, end to end

1. The agent clicks **Call**, or clicks a number in Zendesk.
2. **The panel sends the SIP INVITE itself**, over WebSocket to the registrar.
3. Vobiz fetches the answer URL of the application this SIP endpoint is bound
   to — the backend's `/answer`.
4. The backend replies `<Record recordSession>` followed by
   `<Dial callerId=… action=… redirect="false"><Number>`.
5. Vobiz dials the customer and bridges the two legs.
6. `/dial-status` receives the result; `/recording-ready` receives the file.

The order cannot be reversed: originating to the customer over the REST API and
then bridging the browser in with `<Dial><User>` does not connect.

## An inbound call

A PSTN caller reaches a DID pointed at the same `/answer`. `From` is a plain
number rather than a `sip:` URI, so the backend answers with `<Dial><User>`
naming the agent's SIP endpoint, with `callerName` set to the real caller. The
panel rings, looks the caller up in Zendesk, and the agent accepts (Enter) or
declines (Escape).

`callerId` is mandatory here. Omit it and Vobiz derives it from the A leg —
which on an inbound call is the *caller's* number, not one this account owns —
so B-leg creation is refused silently and the browser never rings. The backend
uses the DID that was actually dialled, normalised to E.164.


## Why the browser must be the A leg

Bridging *into* a registered WebRTC endpoint from an outbound REST call fails
platform-side: the customer answers, hears ringback, then "the agent could not
be reached". Dialling *out* of a registered endpoint is not affected, which is
why the panel sends the INVITE and the backend answers with `<Dial><Number>`.

## Binding inbound audio

For an **incoming** session JsSIP has not built the `RTCPeerConnection` yet —
`session.connection` is `null` until the call is answered. Dereferencing it
inside the `newRTCSession` handler throws, and because the throw happens inside
that handler it aborts before `.answer()` runs: the browser silently never picks
up, Vobiz rings until it times out, and the far end is never connected.

```js
session.on("peerconnection", e => bindTrack(e.peerconnection));
bindTrack(session.connection);   // no-op on the incoming path
```

## Three client settings that are not optional

| Setting | Symptom without it |
| --- | --- |
| `session_timers: false` | `422 Session Interval Too Small`, surfaced as the opaque cause "SIP Failure Code", and **no CDR at all** |
| `pcConfig.iceServers` | host-only candidates, "Incompatible SDP", CDR billed `0s` |
| space-free `user_agent` | Vobiz interpolates it unescaped into a gateway URI; JsSIP's default `JsSIP 3.10.1` contains a space |

## What the app writes back to Zendesk

| Capability | How |
| --- | --- |
| Screen pop | `GET /api/v2/search.json?query=type:user phone:…` while ringing, then `routeTo` the user on answer |
| Ticket context | A `ticket_sidebar` instance — `top_bar` has no page context of its own |
| Call log | A private comment on the open ticket, or a new solved ticket |
| Recording | A short-lived HMAC-signed link, minted server-side |
