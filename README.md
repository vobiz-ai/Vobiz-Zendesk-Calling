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

Outbound and inbound calls both run in the agent's browser, and both are
recorded.

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

**The browser is the A leg.** For an outbound call the panel sends the SIP
INVITE itself; Vobiz fetches the backend's `/answer`, which returns
`<Record>` then `<Dial><Number>` to reach the customer. Inbound calls to your
number get `<Dial><User>` to the agent's SIP endpoint, and the panel rings. See
[architecture](docs/architecture.md#an-outbound-call-end-to-end).

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
cp .env.example .env                   # Vobiz + SIP endpoint + Zendesk values
npm start                              # → http://localhost:8092

# 2. expose it, so Vobiz can reach the answer webhook
cloudflared tunnel --url http://localhost:8092

# 3. the Zendesk app (from the repository root)
cd ..
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
| `backend/.env.example` | Every backend setting, documented |
| `backend/test/` | Backend behaviour and security regression tests (`npm test`) |
| `manifest.json` | ZAF v2 manifest — three locations, three settings |
| `assets/index.html` | The softphone UI (`top_bar`) |
| `assets/sidebar.html` | Resolves which ticket is open (`ticket_sidebar`) |
| `assets/background.html` | Relays Zendesk's `voice.dialout` click-to-dial |
| `docs/` | Install, architecture, backend contract, testing |

## Configuration

Set in **Zendesk → Admin Center → Apps → Vobiz Calling App → Settings**:

| Setting | Required | Purpose |
| --- | --- | --- |
| `backend_url` | yes | Public HTTPS base URL of your backend |
| `agent_id` | yes | A label for this agent, shown in the panel |
| `registrar_url` | no | Defaults to `wss://registrar.vobiz.ai:5063/` |

Everything else — Vobiz credentials, the SIP endpoint, Zendesk API
credentials — lives in `backend/.env`; see
[`.env.example`](backend/.env.example). The one value worth setting deliberately
is `SIGNING_SECRET`; without it, recording links break on restart.

## Security

- **No credentials in URLs, and none in Zendesk tickets.** Recording links are
  HMAC-signed and expiring; they carry no Vobiz or Zendesk credentials.
- **Credentials stay on the backend.** The Vobiz Auth Token, the SIP password
  and the Zendesk API token are read from `backend/.env`. Signing in exchanges
  the Auth ID and Auth Token for an opaque session token held in
  `sessionStorage`; the SIP identity is served only to a signed-in session.
- **Everything interpolated into VobizXML is validated and escaped.** Caller IDs
  must be numbers the account owns.
- **CORS is scoped** to Zendesk's app origins (`*.apps.zdusercontent.com`,
  `*.zendesk.com`) plus anything listed in `ALLOWED_ORIGINS` — never `*`.
- The webhook routes Vobiz calls (`/answer`, `/dial-status`,
  `/recording-ready`) are necessarily public. Read [SECURITY.md](SECURITY.md)
  before deploying.

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
