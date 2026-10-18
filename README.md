<div align="center">

# Vobiz Calling for Zendesk

**Make and take real phone calls from the Zendesk top bar, see who is calling before you answer, and log every call to a ticket.**

[![CI](https://github.com/vobiz-ai/Vobiz-Zendesk-Calling/actions/workflows/ci.yml/badge.svg)](https://github.com/vobiz-ai/Vobiz-Zendesk-Calling/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-e83c00.svg)](LICENSE)
[![Node 18+](https://img.shields.io/badge/Node-18%2B-339933.svg)](https://nodejs.org)

[Docs page](https://www.vobiz.ai/docs/integrations/zendesk) · [Architecture](docs/architecture.md) · [Backend API](docs/backend-contract.md) · [Security](SECURITY.md)

</div>

---

Vobiz Calling is a Zendesk Support app plus a small Node.js backend that you
host. The app puts a softphone in the Zendesk top bar. Your agents sign in with
their Vobiz account, call customers from the panel or from a ticket, take
inbound calls in the browser, and every call is written back to Zendesk with
its duration and a link to the recording. No desk phone, no desktop software,
and no Zendesk Talk subscription.

## Features

- **Click-to-call.** Dial any number from the panel, or click **Call requester**
  in the ticket sidebar. On Zendesk accounts with Talk Partner Edition,
  clicking a phone number anywhere in Zendesk also dials it.
- **Inbound calls in the browser.** Calls to your Vobiz number ring every agent
  of that Vobiz account who is signed in to the panel.
- **Screen pop.** While a call rings, the panel looks the caller up in Zendesk
  by phone number and shows their name. Answering opens their profile.
- **Call logging.** After every call, a private internal note is added to the
  open ticket, or a new ticket is created, with direction, numbers, duration
  and a recording link.
- **Recordings.** Every call is recorded. Play recordings of calls made or
  taken through the panel, or open the signed, expiring link in the ticket.
- **Caller-ID choice.** Pick which of your Vobiz numbers to call from.
- **Multiple agents.** Each Zendesk agent gets their own SIP endpoint in your
  Vobiz account, set up automatically. No per-agent setting or installation.
- **Two ways to sign in.** With your Vobiz account (Auth ID and Auth Token), or
  directly with an existing SIP endpoint.

## How it works

```
 Zendesk (agent's browser)                    Your backend                 Vobiz
 ┌──────────────────────────────┐  HTTPS   ┌──────────────────┐  REST   ┌─────────────────┐
 │ top bar   softphone panel    │────────▶ │ backend/         │───────▶ │ api.vobiz.ai    │
 │ sidebar   Call requester     │          │ server.js        │ ◀────── │ (webhooks:      │
 │ background click-to-dial     │          └──────────────────┘ answer, │  /answer, ...)  │
 └──────────────┬───────────────┘                               status  └────────┬────────┘
                │            SIP over WebSocket (audio)                         │
                └───────────────────────────────────────────▶ registrar.vobiz.ai ── phone network
```

- The panel runs in the Zendesk top bar. A ticket-sidebar part tells it which
  ticket is open and offers **Call requester**. A background part relays
  Zendesk's click-to-dial event.
- When an agent signs in, the backend checks the Auth ID and Auth Token with
  Vobiz and sets up what it needs inside that Vobiz account.
- The browser registers with Vobiz as a SIP endpoint and carries the call audio
  (WebRTC). Your microphone and speakers are the phone.
- To call out, the browser starts the call. Vobiz asks your backend's `/answer`
  URL what to do, and the backend tells Vobiz to record the call and dial the
  customer from your chosen number.
- For inbound calls, Vobiz asks the same `/answer` URL, and the backend rings
  the signed-in agents of the Vobiz account that owns the number.
- When the call ends, the panel writes the call log to Zendesk.
- Recording audio is fetched from Vobiz by the backend and streamed to the
  agent through a signed link. Your Auth Token never reaches the browser.

## Requirements

| | |
| --- | --- |
| **Vobiz account** | Your **Auth ID** and **Auth Token** from the [Vobiz Console](https://console.vobiz.ai) → **API credentials** (the Auth Token is not your login password). At least one active, voice-enabled phone number, and enough balance for calls. |
| **Zendesk** | Zendesk Support with **admin** access. Trying the app locally with `zcli apps:server` works on any plan, including a trial. Uploading it as a private app for your team needs **Suite Growth** or higher, or **Support Professional** or higher. Zendesk Talk is **not** needed. |
| **A public HTTPS URL** | Vobiz must reach your backend from the internet. Use a tunnel (`cloudflared`, `ngrok`) to try it, and a stable HTTPS hostname in production. |
| **Node.js** | Version 18 or newer. |
| **Browser** | A current Chrome, Edge or Firefox with a working microphone. Allow microphone access when asked. |

Every call is a real call and is charged to your Vobiz balance. An outbound
call has two legs (the agent's browser and the customer), and both are billed.

## Quick start

**1. Clone and install.**

```bash
git clone https://github.com/vobiz-ai/Vobiz-Zendesk-Calling.git
cd Vobiz-Zendesk-Calling
npm install --prefix backend
cp backend/.env.example backend/.env
```

**2. Expose port 8092 over HTTPS.** In a second terminal:

```bash
npm run tunnel        # runs: cloudflared tunnel --url http://localhost:8092
```

Copy the `https://…` URL it prints.

**3. Configure `backend/.env`.** It holds deployment settings only. Never put a
Vobiz Auth ID, Auth Token, SIP password or phone number in it.

```bash
PUBLIC_BASE=https://calling.example.com     # the HTTPS URL from step 2
SIGNING_SECRET=                             # paste the output of: openssl rand -hex 32
```

**4. Start the backend.**

```bash
npm start             # → http://localhost:8092
```

Check that Vobiz can reach it, from outside your network:

```bash
curl -s -X POST "https://calling.example.com/answer" \
  -d "From=sip:test@registrar.vobiz.ai&To=91XXXXXXXXXX&RouteType=sip"
```

You should get XML back. The test caller is not signed in, so it ends with
`<Hangup reason="rejected"/>`. That is expected. An error page or a timeout
means Vobiz cannot reach your backend.

**5. Run the Zendesk app locally.**

```bash
cp zcli.apps.config.json.example zcli.apps.config.json
```

Edit `zcli.apps.config.json`:

```json
{
  "parameters": {
    "backend_url": "https://calling.example.com"
  }
}
```

```bash
npx @zendesk/zcli apps:server
```

Open `https://<your-subdomain>.zendesk.com/agent/dashboard?zcli_apps=true`. The
Vobiz icon appears in the top bar. If the panel stays blank, allow your
browser's local network access prompt for `localhost:4567`.

**6. Sign in and call.** Open the panel, sign in on the **Vobiz account** tab,
wait for **READY**, pick a caller ID and call. See [Sign in](#sign-in) and
[Using it](#using-it).

To install the app for your whole team, see
[Deploying to production](#deploying-to-production).

## Sign in

The panel has two tabs.

### Vobiz account (recommended)

Enter your **Auth ID** (`MA_XXXXXXXX`) and **Auth Token**, then click
**Log in**. The backend checks them with Vobiz. A wrong pair is refused and
nothing is created.

On a successful sign-in, the backend sets up the following in your Vobiz
account. You never create these by hand.

- **One application** named `Zendesk-Calling-Vobiz`, with answer URL
  `<PUBLIC_BASE>/answer` (method POST). If an application with that answer URL
  already exists, it is reused. An application with any other answer URL is
  never changed.
- **One SIP endpoint per Zendesk agent**, attached to that application. The
  panel identifies the agent by their Zendesk user ID, so agents who share a
  Vobiz account each get their own endpoint. Each sign-in sets a fresh random
  SIP password on it. Only that browser session receives the password, and it
  is never written to disk. Signing in again (for example in a second tab)
  signs the older panel of that same agent out.

**Choose a caller ID.** The **Calling from** dropdown lists your account's
active, voice-enabled numbers. Calls go out from the number you pick, and the
backend refuses any number that is not on your account. The panel remembers
your last choice until the backend restarts.

**Enable inbound calls.** Under **Receive calls here**, click
**Enable inbound calls** once. This attaches the selected number to the
`Zendesk-Calling-Vobiz` application, so calls to that number ring the panel.

> A number can be on only one Vobiz application. Enabling inbound **moves the
> number off the application it is on now**. Before you click, the panel shows
> the ID of that application. Signing in alone never moves a number.

### SIP direct

Use this when you want to sign in as one existing SIP endpoint, without
account-wide credentials. Enter the endpoint's **SIP username** and
**SIP password** (Console → Voice → Endpoints), and the number to call from in
**Calling from** (`+91XXXXXXXXXX`), then click **Connect**. The password goes
straight from your browser to Vobiz. The backend never receives it.

Nothing is set up for you in this mode. Before you connect, point the endpoint
and your number at an application whose answer URL is your backend's `/answer`.

**In the Console:**

1. Voice → Applications → create an application with answer URL
   `https://calling.example.com/answer`, method POST.
2. Voice → Endpoints → your endpoint → set its application to that one.
3. Phone Numbers → your number → attach it to the same application.

**Or with the API:**

```bash
# 1. Create the application. Note the app_id in the response.
curl -X POST "https://api.vobiz.ai/api/v1/Account/MA_XXXXXXXX/Application/" \
  -H "X-Auth-ID: MA_XXXXXXXX" -H "X-Auth-Token: $VOBIZ_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"app_name":"Zendesk-Calling-Vobiz","answer_url":"https://calling.example.com/answer","answer_method":"POST"}'

# 2. Attach the endpoint. Copy the app_id exactly as returned, as a string.
curl -X POST "https://api.vobiz.ai/api/v1/Account/MA_XXXXXXXX/Endpoint/<endpoint_id>/" \
  -H "X-Auth-ID: MA_XXXXXXXX" -H "X-Auth-Token: $VOBIZ_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"app_id":"<app_id>"}'

# 3. Attach the number, for inbound calls (%2B is the leading +).
curl -X POST "https://api.vobiz.ai/api/v1/Account/MA_XXXXXXXX/numbers/%2B91XXXXXXXXXX/application" \
  -H "X-Auth-ID: MA_XXXXXXXX" -H "X-Auth-Token: $VOBIZ_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"application_id":"<app_id>"}'
```

In SIP direct mode:

- The number you type is used as the caller ID **and** as the inbound number
  that rings you. Vobiz refuses a caller ID that the endpoint's account does
  not own.
- The caller-ID dropdown, **Enable inbound calls** and the recordings list are
  not available. Calls are still recorded in Vobiz, but ticket notes carry no
  recording link.
- Call logs are always written through your own Zendesk session.
- **Remember username and caller ID** keeps those two in this browser. The
  password is never stored; you type it each time.

## Using it

### Outbound calls

1. Wait for the **READY** badge. **Call** stays disabled until the panel is
   signed in and registered with Vobiz.
2. Type the number in international format (`+91XXXXXXXXXX`) and click
   **Call**, or press Enter. Or open a ticket and click **Call requester** in
   the Vobiz sidebar (it uses the phone number on the requester's profile).
3. Allow microphone access the first time. Click **Hang up** to end the call.

### Inbound calls

Keep the panel signed in and **READY**. When a call arrives, the panel opens,
plays a ring tone, shows a Zendesk notification and the caller's number, and
adds their name if a Zendesk user has that phone number. Click **Accept** or
press **Enter** to answer (this also opens the caller's Zendesk profile). Click
**Decline** or press **Escape** to reject.

A call rings for 30 seconds. If no agent of that account is signed in, the
caller hears "Sorry, no one is available to take your call. Please try again
later." and the call ends.

### Call logging

When a call ends, the panel writes it to Zendesk:

- **Outbound call made while a ticket is open:** a private internal note on
  that ticket.
- **Outbound call with no ticket open, and every inbound call:** a new ticket,
  type *Task*, status *Solved*, with the matched Zendesk user (if any) as the
  requester.

The note starts with `[Vobiz Call Log]` and lists the date, direction, phone
number(s), duration and a **Listen to Call Recording** link.

Who writes it depends on your backend settings:

- **`ZENDESK_SUBDOMAIN`, `ZENDESK_EMAIL` and `ZENDESK_API_TOKEN` set:** the
  backend writes the log as that Zendesk user. If your Zendesk account has Talk
  Partner Edition, the backend writes a Talk voice comment (or voice ticket)
  instead of a plain note.
- **Left blank** (or if the backend write fails): the panel writes the log
  through the signed-in agent's own Zendesk session, so it is attributed to the
  agent.

An optional webhook, `POST /transcription-ready`, appends a transcript to a
ticket as a private note. It is off unless `TRANSCRIPTION_WEBHOOK_SECRET` is
set, and the caller must send `Authorization: Bearer <that secret>`.

### Recordings

Every call is recorded (MP3, up to one hour per call).

- **In the panel:** **Recordings of calls made here** lists up to 10 recent
  recordings of calls this backend handled for your Vobiz account (calls made
  or taken through the panel since the backend last started). Recordings of
  other calls on the same Vobiz account are not shown. Refresh the list with
  the refresh button.
- **In the ticket:** the recording link plays once Vobiz has finished
  processing the file, usually within a minute. Until then it answers "The
  recording is still processing". Ticket links expire after 7 days by default.

## Configuration reference

### Zendesk app settings

Set these in **Admin Center → Apps and integrations → Zendesk Support apps →
Vobiz Calling → Settings**, or in `zcli.apps.config.json` when running locally.

| Setting | Label | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `backend_url` | Backend URL | Yes | — | Public HTTPS base URL of your backend, no trailing slash. `http://localhost` is accepted for local testing only. |
| `registrar_url` | SIP registrar URL | No | `wss://registrar.vobiz.ai:5063/` | The Vobiz SIP-over-WebSocket address. Leave it unless Vobiz support tells you otherwise. |

### Backend environment variables

Set in `backend/.env` (or the process environment).

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `PUBLIC_BASE` | **Yes** | — | Your backend's public HTTPS URL, e.g. `https://calling.example.com`. Vobiz calls `<PUBLIC_BASE>/answer`, `/dial-status` and `/recording-ready`. Sign-in is refused until this is an `https://` URL. |
| `SIGNING_SECRET` | Yes in production | random at each start | Secret that signs recording links. If unset, a new one is made on every restart and older links stop working. Generate with `openssl rand -hex 32`. |
| `PORT` | No | `8092` | Port the backend listens on. |
| `DATA_DIR` | No | `backend/data` | Folder for the Zendesk agent → SIP endpoint map (IDs and usernames only). |
| `VOBIZ_REGISTRAR` | No | `registrar.vobiz.ai` | Vobiz SIP registrar host. |
| `RECORDING_URL_TTL_SECONDS` | No | `300` | How long recording links in the panel stay valid. |
| `TICKET_RECORDING_LINK_TTL_SECONDS` | No | `604800` (7 days) | How long recording links written into tickets stay valid. |
| `ZENDESK_SUBDOMAIN` | No | — | Your Zendesk subdomain, e.g. `acme` for `acme.zendesk.com`. Set all three `ZENDESK_*` values to have the backend write call logs. |
| `ZENDESK_EMAIL` | No | — | Email of the Zendesk user the backend writes as. |
| `ZENDESK_API_TOKEN` | No | — | A Zendesk API token (Admin Center → Apps and integrations → APIs → Zendesk API). |
| `TRANSCRIPTION_WEBHOOK_SECRET` | No | — | Turns on `POST /transcription-ready`; callers must send it as a Bearer token. |
| `ALLOWED_ORIGINS` | No | — | Extra browser origins allowed to call the backend, comma-separated. Zendesk's app origins and localhost are always allowed. |
| `ZENDESK_MARKETPLACE_NAME` | No | — | Sent as `X-Zendesk-Marketplace-Name` on the backend's Zendesk API requests. Only needed for a Zendesk Marketplace listing. |
| `ZENDESK_MARKETPLACE_ORG_ID` | No | — | Sent as `X-Zendesk-Marketplace-Organization-Id`. Marketplace listing only. |
| `ZENDESK_MARKETPLACE_APP_ID` | No | — | Sent as `X-Zendesk-Marketplace-App-Id`. Marketplace listing only. |

## Deploying to production

**The backend**

- Serve it on a **stable HTTPS hostname** (behind a reverse proxy or load
  balancer that terminates TLS). Quick tunnels change hostname on restart.
- Run **exactly one instance**. Sign-ins, Auth Tokens and recent calls are kept
  in memory, so a second instance would not know about agents signed in to the
  first.
- Set **`SIGNING_SECRET`** to a fixed random value so recording links survive
  restarts.
- Put **`DATA_DIR`** on persistent storage so each agent keeps the same SIP
  endpoint across redeploys.
- Run it under a process manager (systemd, pm2, a container restart policy).
  After any restart, agents must sign in again; open panels notice within a
  minute and ask them to.

**The Zendesk app**

1. Build the package from the repository root:

   ```bash
   npm run package     # writes Vobiz-Zendesk-Calling.zip, no Zendesk login needed
   ```

   Or, after `npx @zendesk/zcli login -i`, run
   `npx @zendesk/zcli apps:validate .` and `npx @zendesk/zcli apps:package .`.
   The backend is never included in the package.
2. In Zendesk, go to **Admin Center → Apps and integrations → Zendesk Support
   apps → Upload private app**, and upload the zip.
3. Fill in **Backend URL**, and install.

One installation serves every agent: each agent gets their own SIP endpoint,
keyed by their Zendesk user ID.

## Security and privacy

- **Your Auth Token never leaves the server and is never stored on disk.** It
  is kept in the backend's memory only, never sent back to the browser, never
  logged and never written into a ticket. After sign-in the browser holds only
  an opaque session token (in `sessionStorage`, valid for 12 hours).
- **The SIP password reaches only the signed-in browser.** WebRTC needs it to
  register. It is minted fresh at each sign-in, served only to that session,
  and never stored in the browser. In SIP direct mode it never reaches the
  backend at all.
- **What is stored on disk:** `DATA_DIR/endpoints.json`, mapping each Vobiz
  Auth ID and Zendesk user ID to its SIP endpoint ID and username. No password,
  no token. File mode 0600.
- **What is stored in the browser:** the session token (`sessionStorage`), the
  selected sign-in tab, and, only if you tick **Remember**, the SIP direct
  username and caller ID (`localStorage`).
- **Recording links are signed and expire.** They carry no credentials, are
  tied to one Vobiz account (a link for one account can never play another
  account's audio), and expire after 5 minutes (panel) or 7 days (tickets).
  The backend fetches the audio from Vobiz itself and never fetches a URL
  supplied by the caller.
- **Zendesk credentials are fixed on the server.** The Zendesk subdomain,
  email and API token come only from `backend/.env`.
- **Caller IDs are checked.** In Vobiz account mode, only numbers on that
  account can be used. Every value placed in the call instructions is
  validated and escaped.
- **CORS is restricted** to Zendesk's app origins (`*.apps.zdusercontent.com`,
  `*.zendesk.com`, `*.zdassets.com`), localhost, and `ALLOWED_ORIGINS`.
- **Vobiz webhooks are not signature-checked.** `/answer`, `/dial-status` and
  `/recording-ready` must be public. A forged request can at most add a fake
  entry to the in-memory call list; it cannot obtain credentials or place
  calls to arbitrary numbers.

Report vulnerabilities as described in [SECURITY.md](SECURITY.md), not in a
public issue.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Panel says "Not configured — set the Backend URL" | The Backend URL setting is empty | Fill it in (or `zcli.apps.config.json`) and reload. |
| "Could not read your Zendesk user" | The panel could not read the signed-in Zendesk user | Reload the Zendesk tab. |
| "Backend URL must start with https://" | `backend_url` is plain `http://` and not localhost | Use your backend's HTTPS URL. |
| "Cannot reach the calling backend" | The backend is down, the URL is wrong, or the browser blocked the request | Check `https://<backend>/health` in a browser. For a custom origin, add it to `ALLOWED_ORIGINS`. |
| "Login failed: Vobiz did not accept that Auth ID and Auth Token" | Wrong credentials | Copy both from Console → **API credentials**. The Auth Token is not your login password. |
| "This backend has no public https PUBLIC_BASE" | `PUBLIC_BASE` is empty or not `https://` | Set it to your public HTTPS URL and restart the backend. |
| "Could not find or create the Zendesk calling application" / "Could not set up a SIP endpoint" | Vobiz refused the request; the backend log has the HTTP status | Check the account is active and the Auth Token is current, then sign in again. |
| "No numbers found on this account" | No active, voice-enabled number on the account | Buy or activate a number in the Console, then sign in again. |
| Badge stays on **OFFLINE** or "Registration failed" | Browser cannot register with Vobiz | Allow WebSocket traffic to `registrar.vobiz.ai:5063`. In SIP direct mode, check the username and password in Console → Endpoints. |
| Call fails at once with nothing in the backend log | Vobiz cannot reach `/answer` | Run the `curl` check from the Quick start from outside your network. If your tunnel hostname changed, update `PUBLIC_BASE` and Backend URL, restart, and sign in again. |
| Badge drops to **SIGNED OUT** with "Please sign in again" | The backend restarted, the 12-hour session expired, or you signed in as the same agent elsewhere | Sign in again. The panel checks its session every minute and on every request. |
| Customer's phone never rings; backend log shows `bleg=(none …)` | The destination is unreachable, or the caller ID is not a number on this Vobiz account | Check the number format (`+91XXXXXXXXXX`) and your caller ID. |
| Call connects but nobody hears anything | Microphone blocked, or the network blocks WebRTC media | Allow the microphone for Zendesk. Try another network; STUN (`stun.l.google.com:19302`) must be reachable. |
| Inbound calls never ring the panel | The number is on another application, or no agent is signed in | Click **Enable inbound calls** with that number selected, and keep the panel open and **READY**. |
| Clicking a phone number in Zendesk does nothing | Zendesk's click-to-dial event needs Talk Partner Edition | Use **Call requester** in the ticket sidebar, or type the number in the panel. |
| Outbound calls create a new ticket instead of using the open one | No ticket was open in the agent's current tab when the call started | Open the ticket first, then call (for example with **Call requester**). Inbound calls always create a new ticket. |
| Recording link says "invalid or has expired" | The link is older than its time limit, or `SIGNING_SECRET` changed | Set a fixed `SIGNING_SECRET`. Play the recording from the panel. |
| Recording link says "The calling backend restarted since this link was made" | The backend restarted and nobody from that Vobiz account has signed in since | Sign in to the panel with that account, then open the link again. |
| An agent keeps getting signed out | The same Zendesk agent is signed in to the panel in another tab or browser | Each new sign-in ends that agent's older one. Use one panel at a time. |

## Limitations

- **Sign in again after the backend restarts.** Auth Tokens and sessions live
  in memory only. Sessions also expire after 12 hours. The panel shows
  **SIGNED OUT** when this happens (within a minute, or at once on the next
  request).
- **Run one backend instance.** State is not shared between instances.
- **One panel per agent at a time.** Each Zendesk agent has one SIP endpoint;
  signing in again elsewhere signs the older panel out.
- **The agent is identified by the panel.** The backend binds each session to
  the Zendesk user ID the panel reports, but does not verify it with Zendesk.
  Anyone with the Vobiz Auth ID and Auth Token can sign in as any agent ID.
- **Inbound rings everyone on the account.** All signed-in agents of the Vobiz
  account ring together. There is no queue, routing or per-number assignment.
- **No hold, mute, transfer or conference.**
- **Browser only.** Calls cannot be sent to an agent's mobile or desk phone.
- **Every call is recorded.** Recording cannot be turned off from the app, and
  stops after one hour. Calls are limited to four hours.
- **SIP direct cannot use recordings,** the caller-ID dropdown or
  **Enable inbound calls**, and its ticket notes have no recording link.
- **Click-to-dial on any phone number needs Talk Partner Edition.** On other
  plans, use **Call requester** or the panel.
- **The panel's recordings list forgets on restart.** It lists calls this
  backend handled since it last started (up to its 200 most recent calls).
  Ticket recording links keep working.
- **Private app only.** It is not listed on the Zendesk Marketplace.

## Development

```bash
npm ci --prefix backend
npm test               # backend tests; no network, no real calls
npm run lint           # every .js file parses, every .json file is valid
npm run check:secrets  # no credentials or real phone numbers in the tree
npm run validate:app   # zcli apps:validate (needs zcli login)
```

CI runs the tests, lint, the secret scan and a manifest check on every pull
request. See [CONTRIBUTING.md](CONTRIBUTING.md).

| Path | What it is |
| --- | --- |
| `manifest.json` | Zendesk app manifest: three locations, two settings |
| `assets/index.html`, `assets/scripts/app.js` | The softphone panel (top bar) |
| `assets/sidebar.html`, `assets/scripts/sidebar.js` | Ticket sidebar: open-ticket context and **Call requester** |
| `assets/background.html`, `assets/scripts/background.js` | Relays Zendesk click-to-dial to the panel |
| `translations/en.json` | App name, description and setting labels |
| `backend/server.js` | Sign-in, Vobiz webhooks, recordings, call log endpoints |
| `backend/zendeskService.js` | Writes call logs and transcripts to Zendesk |
| `backend/.env.example` | Every backend setting, with comments |
| `backend/test/` | Backend tests, and panel tests that run `app.js` against a fake DOM |
| `scripts/` | Lint, secret scan and packaging |
| `docs/architecture.md` | How calls flow, in more depth |
| `docs/backend-contract.md` | Every backend route, request and response |

## Support and links

- Vobiz documentation: https://www.vobiz.ai/docs
- This integration's docs page: https://www.vobiz.ai/docs/integrations/zendesk
- Vobiz Console: https://console.vobiz.ai
- Accounts, numbers and billing: [support@vobiz.ai](mailto:support@vobiz.ai)
- Bugs and feature requests: [GitHub issues](https://github.com/vobiz-ai/Vobiz-Zendesk-Calling/issues)

## License

[MIT](LICENSE), © 2026 Vobiz. This is an official Vobiz integration and is not
a Zendesk product. Zendesk and Zendesk Talk are trademarks of Zendesk, Inc.,
used here only to describe compatibility.
