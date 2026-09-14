# Changelog

All notable changes to this project are documented here. This project follows
[Semantic Versioning](https://semver.org/).

## [1.0.0] — 2026-09-14

First public release.

### Added
- Softphone in the Zendesk top bar: SIP registration over WebRTC, dialpad,
  DTMF, active-call view, and call notes.
- Click-to-dial from any phone number in Zendesk, relayed from Zendesk's
  `voice.dialout` event through a background instance to the softphone.
- Screen pop — inbound calls are looked up by number and the matching Zendesk
  user is offered for one-click navigation.
- Call logging to the ticket the agent is viewing, with direction, duration and
  notes, plus a fallback that writes through the agent's own Zendesk session.
- Recording playback from the ticket.
- Optional transcript webhook that appends an AI transcript as a private
  comment.
- `ticket_sidebar` location, so the app can resolve which ticket is open.
- Zero-configuration mock-free local development: backend, tunnel, and
  `zcli apps:server`, documented end to end in `docs/install.md`.

### Security
- **Recording links no longer carry API credentials.** They previously embedded
  `?authId=…&authToken=…` in a URL written into the ticket body, publishing the
  account's Vobiz token to every agent, every ticket export, and every audit
  log, permanently. Credentials are now sealed into an expiring AES-256-GCM
  token; only the backend can open it.
- **Fixed XML injection in the call-flow webhook.** `fromNumber` and
  `inboundNumber` were interpolated into the VXML response unescaped. Because
  the platform *executes* that XML, a crafted caller ID could inject arbitrary
  verbs into a live call. All values are now escaped, and routing values must
  be dialable.
- **Removed a credential-leaking retry.** On a network failure the app re-sent
  the agent's Auth ID and Token to a hardcoded quick-tunnel hostname. Those
  hostnames are recycled, so the credentials would go to whoever held the name
  next. The retry is gone; failures now surface to the agent.
- **Fixed reflected XSS** in the "no recording available" page, which echoed an
  attacker-supplied call UUID into HTML unescaped.

### Fixed
- **Every call log created a new ticket** instead of commenting on the open one.
  The app looked for a `ticket_sidebar` instance to resolve ticket context, but
  the manifest never declared that location, so the lookup always returned
  null. The location now exists.
- **Click-to-dial discarded its ticket context.** The handler recorded the
  ticket the agent clicked from, then immediately overwrote it. The ticket is
  now pinned for the duration of the call.
- **The `agent_id` setting was ignored** — read from settings, then overwritten
  with a hardcoded `"test-agent"` in two places, making multi-agent deployment
  impossible.
- **A `localhost` backend URL was silently rejected** and replaced with a
  hardcoded fallback host, so local development targeted the wrong server.
- **`zendesk_email` was never sent** to `/sync-call`, so backend-side Zendesk
  authentication always went out with no `Authorization` header.
- **Call logs recorded the agent ID as a phone number**, putting the literal
  string `"test-agent"` in the from/to fields.
- **A call dialled right after an inbound call was logged as inbound.**
- **`/hangup-call` always returned `ok: true`**, including on failure, so a
  failed hangup looked successful while the call stayed up and billing.
- **A missing recording returned HTTP 200** with an HTML page, so an `<audio>`
  element could not tell that there was no media.
- **Inbound DID routing could loop** when the account-numbers cache was cold
  after a restart, causing the platform to dial its own inbound number.
- The ZAF user-search query was not URL-encoded, despite containing a space and
  colons.

### Configuration
- `zendesk_subdomain`, `zendesk_email` and `zendesk_api_token` are now declared
  in the manifest, so they are actually settable. They previously existed only
  in files ZAF does not read, and were always `undefined` at runtime. The API
  token is marked `secure`.
- Added `RECORDING_TOKEN_SECRET` and `RECORDING_TOKEN_TTL_MS`.
- Shipped `agents.json.example` and `zcli.apps.config.json.example`; the real
  files are gitignored because they carry SIP passwords and API tokens.
- `zcli` configuration uses the filename `zcli.apps.config.json`. A file named
  `zcli.json` is ignored by the tooling.

### Known limitations
- The backend's routes are unauthenticated — see [SECURITY.md](SECURITY.md).
- No hold, mute, transfer, or conference.
- Talk Partner Edition call objects are not used; logs go through the standard
  Tickets API.
- Packaging for a permanent install needs `assets/logo-small.png` and
  `assets/icon_top_bar.svg`, which are not shipped.
