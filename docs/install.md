# Install

- [Requirements](#requirements)
- [1. Configure and run the backend](#1-configure-and-run-the-backend)
- [2. What signing in sets up](#2-what-signing-in-sets-up)
- [3. Expose the backend](#3-expose-the-backend)
- [4. Run the Zendesk app](#4-run-the-zendesk-app)
- [5. Sign in and call](#5-sign-in-and-call)
- [6. Install for the whole account](#6-install-for-the-whole-account)
- [SIP direct: setting up an endpoint by hand](#sip-direct-setting-up-an-endpoint-by-hand)

## Requirements

| | |
| --- | --- |
| Zendesk Support | Admin access to install an app. Any plan that allows private apps. Talk is not needed. |
| Vobiz account | Any account. Each agent signs in with its Auth ID and Auth Token, and needs at least one active voice number — [console.vobiz.ai](https://console.vobiz.ai) |
| Node | 18 or newer |
| A tunnel or host | `cloudflared` or `ngrok` for testing. Vobiz must reach the backend over public HTTPS |

Every test call is a real call and is billed. An outbound call bills two legs.

## 1. Configure and run the backend

```bash
cd backend
npm install
cp .env.example .env
```

`backend/.env` holds deployment settings only. **No Vobiz Auth ID, Auth Token,
SIP credentials or phone number goes in it** — agents sign in with their own
account from the panel.

| Variable | Value |
| --- | --- |
| `PUBLIC_BASE` | The public HTTPS URL from step 3. Sign-in refuses to provision until it is set |
| `SIGNING_SECRET` | `openssl rand -hex 32` — keeps recording links valid across restarts |
| `DATA_DIR` | Optional. Where the agent → endpoint map is kept (default `backend/data`, ids only) |
| `ZENDESK_SUBDOMAIN`, `ZENDESK_EMAIL`, `ZENDESK_API_TOKEN` | Optional. Leave blank and the panel logs calls through the agent's own Zendesk session |

```bash
npm start      # → http://localhost:8092
npm test       # optional: the backend's behaviour and security checks
```

## 2. What signing in sets up

You do not create endpoints or applications by hand. When an agent signs in
with an Auth ID and Auth Token, the backend:

1. Checks the pair with Vobiz (`GET /Account/{auth_id}/numbers`). A wrong pair
   is refused.
2. Finds this integration's application in **that** account — the one whose
   answer URL is `PUBLIC_BASE/answer` — or creates it (`Zendesk-Calling-Vobiz`).
   It never edits an application it did not create.
3. Finds or creates **one SIP endpoint for that agent** in that account, sets a
   fresh random SIP password, and hands it only to that browser session. The
   password is never stored; the next sign-in rotates it.
4. Binds the endpoint to the application and reads it back to confirm.
5. Loads the account's active, voice-enabled numbers for the caller-ID picker.

The Auth Token stays in the backend's memory only. After a backend restart,
agents simply sign in again.

## 3. Expose the backend

Vobiz fetches `/answer` to find out what to do with every call, so it must be
reachable from the public internet.

```bash
cloudflared tunnel --url http://localhost:8092
```

Put the `https://…` URL in `PUBLIC_BASE` and restart the backend. Then check the
answer URL from outside your network, with the shape an outbound call produces:

```bash
curl -s -X POST "https://<your-tunnel>/answer" \
  -d "From=sip:x@registrar.vobiz.ai&To=91XXXXXXXXXX&RouteType=sip"
```

It must return `<Record …/>` followed by `<Dial …><Number>…</Number></Dial>`.
Anything else — a tunnel error page, an ngrok interstitial — and calls fail.

Quick tunnels get a new hostname on every restart. Use a named tunnel or a real
host for anything permanent.

## 4. Run the Zendesk app

From the repository root:

```bash
cp zcli.apps.config.json.example zcli.apps.config.json
```

```json
{
  "parameters": {
    "backend_url": "https://<your-tunnel>",
    "agent_id": "priya"
  }
}
```

`zcli` reads `zcli.apps.config.json`; a file with any other name is ignored.

```bash
npx @zendesk/zcli apps:server
```

Open Zendesk with the local apps server attached:

```text
https://<your-subdomain>.zendesk.com/agent/dashboard?zcli_apps=true
```

The Vobiz icon appears in the top bar. If the panel stays blank, allow the
browser's Local Network Access / insecure-content prompt for `localhost:4567`.

## 5. Sign in and call

1. Open the panel from the top bar.
2. On the **Vobiz account** tab, enter your Vobiz **Auth ID** and **Auth Token**
   (Console → API credentials) and sign in. Any Vobiz account works.
3. Wait for **READY**. The Call button stays disabled until the SIP endpoint is
   registered.
4. Pick the caller ID from the dropdown (your account's active voice numbers),
   type a number in E.164 format, and call — or open a ticket and use
   **Call requester** in the Vobiz sidebar.
5. For inbound, click **Enable inbound calls** once. This attaches the selected
   number to the integration's application — and **moves it off** whatever
   application it was on before (the panel names that application first).
   Calls to that number then ring every agent of that account who is signed in;
   **Enter** accepts, **Escape** declines.

After each call the panel writes a private note to the open ticket, or creates a
ticket, with the direction, duration and a signed recording link. Recording
links are tied to the account: one account's link never plays another's audio.
A link opened after a backend restart asks for someone on that account to sign
in again first.

## 6. Install for the whole account

`zcli apps:server` serves the app only to your browser while it runs. To
install it for everyone, package it:

```bash
npm run package                    # offline; writes Vobiz-Zendesk-Calling.zip
# or, after `npx @zendesk/zcli login -i`:
npx @zendesk/zcli apps:validate .
npx @zendesk/zcli apps:package .   # writes tmp/app-<timestamp>.zip
```

Upload the zip under **Admin Center → Apps and integrations → Zendesk Support
apps → Upload private app** and fill in **Backend URL** and **Agent identity**.
The backend needs a stable HTTPS hostname for this.

## SIP direct: setting up an endpoint by hand

The panel's **SIP direct** tab signs in as one existing endpoint with its own
SIP username and password, plus the caller ID to show. No account credentials
are involved, so recordings, the number list and **Enable inbound calls** are
not available in this mode; the backend only remembers which caller ID (and
inbound number) belongs to that SIP username.

Because nothing is provisioned for you, bind the endpoint and the number to an
application whose answer URL is this backend yourself:

1. **Console:** Voice → Applications → create an application with answer URL
   `https://<your-backend>/answer` (method POST). Then Voice → Endpoints → your
   endpoint → set its application to that one, and Phone Numbers → your number
   → attach it to the same application.
2. **API equivalent:**

```bash
# create the application; note the app_id it returns
curl -X POST "https://api.vobiz.ai/api/v1/Account/<auth_id>/Application/" \
  -H "X-Auth-ID: <auth_id>" -H "X-Auth-Token: <auth_token>" -H "Content-Type: application/json" \
  -d '{"app_name":"Zendesk-Calling-Vobiz","answer_url":"https://<your-backend>/answer","answer_method":"POST"}'

# bind the endpoint (keep the app_id exactly as returned; it is 17 digits)
curl -X POST "https://api.vobiz.ai/api/v1/Account/<auth_id>/Endpoint/<endpoint_id>/" \
  -H "X-Auth-ID: <auth_id>" -H "X-Auth-Token: <auth_token>" -H "Content-Type: application/json" \
  -d '{"app_id":"<app_id>"}'

# attach the number for inbound
curl -X POST "https://api.vobiz.ai/api/v1/Account/<auth_id>/numbers/%2B<number>/application" \
  -H "X-Auth-ID: <auth_id>" -H "X-Auth-Token: <auth_token>" -H "Content-Type: application/json" \
  -d '{"application_id":"<app_id>"}'
```

Vobiz refuses a caller ID that the endpoint's account does not own, so a wrong
number fails the call rather than spoofing it.
