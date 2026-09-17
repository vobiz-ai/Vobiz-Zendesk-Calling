<div align="center">

# Vobiz Calling for Zendesk

**A softphone in your Zendesk top bar. Agents take and place real phone calls, see who is calling before they answer, and every call is logged to the ticket.**

[![CI](https://github.com/vobiz-ai/Vobiz-Zendesk-Calling/actions/workflows/ci.yml/badge.svg)](https://github.com/vobiz-ai/Vobiz-Zendesk-Calling/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-e83c00.svg)](LICENSE)
[![Zendesk ZAF v2](https://img.shields.io/badge/Zendesk-ZAF%20v2-03363d.svg)](https://developer.zendesk.com/documentation/apps/)
[![Node 18+](https://img.shields.io/badge/Node-18%2B-339933.svg)](https://nodejs.org)

[Install](docs/install.md) · [Testing](docs/testing.md) · [Architecture](docs/architecture.md) · [Backend contract](docs/backend-contract.md) · [Open issues](ISSUES.md) · [Marketplace](MARKETPLACE.md)

</div>

---

## What it does

| | |
| --- | --- |
| **Click-to-call** | Click any phone number in Zendesk and the softphone opens and dials. |
| **Screen pop** | An inbound call looks the caller up by number and shows who they are before you answer. |
| **Call logging** | Every call is written to the ticket the agent is viewing, with direction, duration, and notes. |
| **Recordings** | Playable from the ticket, behind an expiring link that never carries your API credentials. |
| **Transcripts** | An optional webhook appends an AI transcript to the ticket as a private comment. |
| **Browser audio** | Calls run over WebRTC in the tab. No desk phone, no desktop app. |

**Verified end to end on 17 September 2026** on a live account: outbound
connected and billed, session recordings delivered, and inbound PSTN → browser
connected too — B leg answered, 12 seconds billed, confirmed in the CDR rather
than the UI. Inbound had been blocked platform-side for the two weeks before
that; read [`ISSUES.md`](ISSUES.md) #1 before relying on it.

## How it fits together

```
                    ┌──────────────────────────────────────────────┐
   Zendesk          │  top_bar        the softphone (this repo)    │
   agent browser    │  ticket_sidebar resolves the open ticket     │
                    │  background     relays Zendesk click-to-dial │
                    └───────┬──────────────────────────┬───────────┘
                            │ HTTPS                    │ SIP over WebSocket
                            ▼                          ▼
                    ┌───────────────┐        wss://registrar.vobiz.ai:5063
                    │    backend    │                  │
                    │  (this repo)  │                  │
                    └───────┬───────┘                  │
                            │ REST + webhooks          │
                            ▼                          ▼
                    ┌──────────────────────────────────────────────┐
                    │        Vobiz voice platform / PSTN           │
                    └──────────────────────────────────────────────┘
```

The browser carries the **audio**; the backend carries the **credentials**. Your
Vobiz Auth Token is never exposed to a third party, and never written into a
Zendesk ticket.

**Outbound call order is load-bearing.** The backend dials the *customer* first,
then bridges the agent's registered browser in via `<Dial><User>`. The reverse
does not work — the Vobiz REST API cannot originate a call to a registered
WebRTC endpoint. This is also why the person you call hears a couple of seconds
of ringback after answering. See [architecture](docs/architecture.md#an-outbound-call-end-to-end).

## Quick start

Requires **Node 18+**, a [Zendesk](https://www.zendesk.com) account with admin
access, and a [Vobiz](https://console.vobiz.ai) account with at least one phone
number.

```bash
git clone https://github.com/vobiz-ai/Vobiz-Zendesk-Calling.git
cd Vobiz-Zendesk-Calling

# 1. backend
cd backend
npm install
cp .env.example .env
cp agents.json.example agents.json     # add a SIP endpoint per agent
npm start                              # → http://localhost:8092

# 2. expose it, so Vobiz can reach the answer webhook
cloudflared tunnel --url http://localhost:8092

# 3. the Zendesk app
cd ../zendesk-app
cp zcli.apps.config.json.example zcli.apps.config.json   # paste the tunnel URL
npx @zendesk/zcli apps:server
```

Then open Zendesk with the apps server attached:

```
https://<your-subdomain>.zendesk.com/agent/dashboard?zcli_apps=true
```

The softphone appears in the top bar. Full walkthrough, including creating the
SIP endpoints: **[docs/install.md](docs/install.md)**.

## Repository layout

| Path | What it is |
| --- | --- |
| `backend/server.js` | The bridge: call control, the Vobiz answer webhook, the recording proxy |
| `backend/zendeskService.js` | Writes call logs and transcripts into Zendesk |
| `backend/agents.json.example` | Template mapping agent identities to SIP endpoints |
| `zendesk-app/manifest.json` | ZAF v2 manifest — three locations, five settings |
| `zendesk-app/assets/index.html` | The softphone UI (`top_bar`) |
| `zendesk-app/assets/sidebar.html` | Resolves which ticket is open (`ticket_sidebar`) |
| `zendesk-app/assets/background.html` | Relays Zendesk's `voice.dialout` click-to-dial |
| `docs/` | Install, architecture, backend contract, testing |

## Configuration

Set in **Zendesk → Admin Center → Apps → Vobiz Calling App → Settings**:

| Setting | Required | Purpose |
| --- | --- | --- |
| `backend_url` | yes | Public HTTPS base URL of your backend |
| `agent_id` | yes | Which entry in `agents.json` this agent is. **One per agent.** |
| `zendesk_subdomain` | no | Only if the backend writes call logs instead of the app |
| `zendesk_email` | no | Paired with the API token |
| `zendesk_api_token` | no | Stored as a **secure** setting |

Backend environment lives in `backend/.env` — see
[`.env.example`](backend/.env.example). The one value worth setting deliberately
is `RECORDING_TOKEN_SECRET`; without it, recording links break on restart.

## Security

- **No credentials in the browser's URL bar, and none in Zendesk tickets.**
  Recording links carry an AES-256-GCM sealed token with an expiry, not your
  Auth Token.
- **The VXML webhook escapes everything** it interpolates. Caller-ID values are
  validated as dialable before they reach the call flow.
- **Agent credentials are never stored server-side.** They are sent per request
  and held only in the agent's own browser session.

Known gaps are listed honestly in [SECURITY.md](SECURITY.md) — most importantly,
**the backend's endpoints are unauthenticated**, so it must not be exposed to
the public internet beyond the webhook paths Vobiz needs. Read that file before
deploying.

To report a vulnerability: [SECURITY.md](SECURITY.md). Please do not open a
public issue.

## Known limitations

- **No hold, mute, transfer, or conference.** The UI has no controls for them.
- **Talk Partner Edition is not used.** Call logs are written through the
  standard Tickets API, so this works on any Zendesk Support plan, but calls do
  not appear in Zendesk's native Talk reporting.
- **Browser calling only.** Calls cannot be routed to an agent's mobile or desk
  phone, though the backend's VXML already supports it —
  see [architecture](docs/architecture.md#bridging-to-a-phone-instead-of-the-browser).
- **Private app only.** Not published to the Zendesk Marketplace.

## Maintenance and licence

Built and maintained by **Vobiz**. Contributions welcome —
see [CONTRIBUTING.md](CONTRIBUTING.md).

Licensed under the [MIT Licence](LICENSE), © 2026 Vobiz. This is an official
Vobiz integration and is not a Zendesk product; Zendesk and Zendesk Talk are
trademarks of Zendesk, Inc., used here only to describe compatibility.

For anything about the Vobiz platform itself — accounts, numbers, billing —
email [support@vobiz.ai](mailto:support@vobiz.ai) or read the
[Vobiz documentation](https://www.vobiz.ai/docs).
