# Install

- [Requirements](#requirements)
- [1. Create a SIP endpoint](#1-create-a-sip-endpoint)
- [2. Configure and run the backend](#2-configure-and-run-the-backend)
- [3. Expose the backend](#3-expose-the-backend)
- [4. Run the Zendesk app](#4-run-the-zendesk-app)
- [5. Sign in and call](#5-sign-in-and-call)
- [6. Install for the whole account](#6-install-for-the-whole-account)

## Requirements

| | |
| --- | --- |
| Zendesk Support | Admin access to install an app. Any plan that allows private apps. Talk is not needed. |
| Vobiz account | Auth ID, Auth Token, and at least one number — [console.vobiz.ai](https://console.vobiz.ai) |
| Node | 18 or newer |
| A tunnel or host | `cloudflared` or `ngrok` for testing. Vobiz must reach the backend over public HTTPS |

Every test call is a real call and is billed. An outbound call bills two legs.

## 1. Create a SIP endpoint

The panel registers to Vobiz as a SIP endpoint. Create one in the console under
**Voice → Endpoints**, or via the API:

```bash
curl -X POST "https://api.vobiz.ai/api/v1/Account/$VOBIZ_AUTH_ID/Endpoint/" \
  -H "X-Auth-ID: $VOBIZ_AUTH_ID" \
  -H "X-Auth-Token: $VOBIZ_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"username":"zendeskagent","password":"<a strong password>","alias":"Zendesk"}'
```

```json
{ "alias": "Zendesk", "endpoint_id": "375555448816999", "username": "zendeskagent1187694299145202883643" }
```

1. **Vobiz appends a numeric suffix** to the username. Use the value it returns.
2. **The password is never returned again.** Record it now.

Use a separate endpoint for this integration. An endpoint is bound to one Vobiz
application at a time, so sharing it with another integration breaks one of them.

## 2. Configure and run the backend

```bash
cd backend
npm install
cp .env.example .env
```

Fill in `backend/.env`:

| Variable | Value |
| --- | --- |
| `VOBIZ_AUTH_ID`, `VOBIZ_AUTH_TOKEN` | Console → API credentials |
| `VOBIZ_FROM_NUMBER` | A number on the account, E.164 (`+91…`) |
| `VOBIZ_SIP_USER`, `VOBIZ_SIP_PASSWORD` | The stored username and password from step 1 |
| `PUBLIC_BASE` | The public HTTPS URL from step 3 |
| `SIGNING_SECRET` | `openssl rand -hex 32` — keeps recording links valid across restarts |
| `ZENDESK_SUBDOMAIN`, `ZENDESK_EMAIL`, `ZENDESK_API_TOKEN` | Optional. Leave blank and the panel logs calls through the agent's own Zendesk session |

```bash
npm start      # → http://localhost:8092
npm test       # optional: the backend's behaviour and security checks
```

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
2. Enter the Vobiz **Auth ID** and **Auth Token** (the same account as
   `backend/.env`) and sign in. Signing in binds the SIP endpoint to a Vobiz
   application whose answer URL is `PUBLIC_BASE/answer`.
3. Wait for **READY**. The Call button stays disabled until the SIP endpoint is
   registered.
4. Pick the caller ID, type a number in E.164 format, and call — or open a
   ticket and use **Call** in the Vobiz sidebar.
5. For inbound, click **Enable inbound calls** once. This attaches
   `VOBIZ_FROM_NUMBER` to the application — and detaches it from whatever
   application it was attached to before. Calls to that number then ring the
   panel; **Enter** accepts, **Escape** declines.

After each call the panel writes a private note to the open ticket, or creates a
ticket, with the direction, duration and a signed recording link.

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
