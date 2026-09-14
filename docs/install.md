# Installation

End-to-end setup, from an empty machine to a working call. Budget about
thirty minutes the first time.

- [Before you start](#before-you-start)
- [1. Create a SIP endpoint per agent](#1-create-a-sip-endpoint-per-agent)
- [2. Run the backend](#2-run-the-backend)
- [3. Expose the backend](#3-expose-the-backend)
- [4. Run the Zendesk app](#4-run-the-zendesk-app)
- [5. Place a test call](#5-place-a-test-call)
- [Installing permanently](#installing-permanently)
- [Troubleshooting](#troubleshooting)

## Before you start

| You need | Why |
| --- | --- |
| **Zendesk Support**, admin access | To install the app |
| **Vobiz account** with a phone number | To place calls. [console.vobiz.ai](https://console.vobiz.ai) |
| **Node 18+** | Runs the backend |
| A tunnel — `cloudflared` or `ngrok` | Vobiz must reach your answer webhook from the public internet |

Have your Vobiz **Auth ID** and **Auth Token** to hand. Both are on the Console
dashboard under **API credentials**.

> **A note on cost.** Every test places a real call and bills your Vobiz
> balance. Two legs are billed on an outbound call — the customer's and the
> agent's.

## 1. Create a SIP endpoint per agent

The softphone registers to Vobiz as a SIP endpoint. Each agent needs their own,
or calls ring the wrong person.

Create one in the Vobiz Console under **Voice → Endpoints**, or via the API:

```bash
curl -X POST "https://api.vobiz.ai/api/v1/Account/$VOBIZ_AUTH_ID/Endpoint/" \
  -H "X-Auth-ID: $VOBIZ_AUTH_ID" \
  -H "X-Auth-Token: $VOBIZ_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"username":"agent-priya","password":"<a strong password>","alias":"Priya"}'
```

```json
{
  "alias": "Priya",
  "endpoint_id": "375555448816999",
  "username": "agent-priya1187694299145202883643"
}
```

Two things to notice:

1. **Vobiz appends a numeric suffix** to the username you asked for. Use the
   value it returns, not the one you sent.
2. **The password is never returned again.** Record it now.

Then map it in `backend/agents.json`:

```bash
cd backend
cp agents.json.example agents.json
```

```json
{
  "priya": {
    "name": "Priya Sharma",
    "sipUser": "agent-priya1187694299145202883643",
    "sipPassword": "<the password you chose>",
    "displayName": "Priya Sharma"
  }
}
```

The key — `priya` — is what you put in the app's `agent_id` setting.

> `agents.json` holds SIP passwords and is gitignored. Keep it that way.

## 2. Run the backend

```bash
cd backend
npm install
cp .env.example .env
npm start
```

```
[backend] listening on http://localhost:8092
```

Open `.env` and set at least `RECORDING_TOKEN_SECRET`:

```bash
openssl rand -hex 32
```

Without it, recording links written into tickets stop resolving after a
restart. Everything else in `.env` can stay blank — agents sign in through the
app and their credentials are sent per request.

Check it:

```bash
curl http://localhost:8092/agent/priya
# {"name":"Priya Sharma","sipUser":"agent-priya118…","sipPassword":"…"}
```

## 3. Expose the backend

When a customer answers, Vobiz fetches your `/call-answer` webhook to find out
what to do next. That URL must be reachable from the public internet, so
`localhost` alone will not work.

```bash
cloudflared tunnel --url http://localhost:8092
```

```
https://your-tunnel.example.com
```

Confirm it reaches you, and returns XML:

```bash
curl "https://<your-tunnel>/call-answer?agentId=priya"
```

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial record="true" redirect="false">
    <User>agent-priya1187694299145202883643</User>
  </Dial>
</Response>
```

> Quick tunnels get a **new hostname every restart**, and the old one is
> recycled to someone else. Fine for development; for anything permanent, use a
> named tunnel or a real host.

## 4. Run the Zendesk app

```bash
cd ../zendesk-app
cp zcli.apps.config.json.example zcli.apps.config.json
```

Set `backend_url` to the tunnel URL and `agent_id` to your key in
`agents.json`:

```json
{
  "parameters": {
    "backend_url": "https://your-tunnel.example.com",
    "agent_id": "priya"
  }
}
```

> The filename matters. `zcli` reads **`zcli.apps.config.json`**; a file named
> `zcli.json` is silently ignored and you will be prompted for the values
> instead.

Serve it:

```bash
npx @zendesk/zcli apps:server
```

```
Apps server is running on http://localhost:4567 🚀
```

Open Zendesk with the apps server attached:

```
https://<your-subdomain>.zendesk.com/agent/dashboard?zcli_apps=true
```

The Vobiz softphone appears in the **top bar**.

> If nothing loads, your browser may be blocking requests to `localhost:4567`.
> Chrome asks for Local Network Access permission — allow it.

## 5. Place a test call

1. Open the softphone from the top bar.
2. Enter your Vobiz **Auth ID** and **Auth Token** and sign in.
3. Pick the number to call from.
4. Wait for the status line to read **Registered** — calling stays disabled
   until the SIP endpoint is up.
5. Type a number and press **Call**.

What should happen:

| Stage | What you see |
| --- | --- |
| Dialling | The customer's phone rings |
| They answer | They hear a moment of ringback while you are bridged in |
| Bridged | Your browser rings; audio connects both ways |
| Hang up | **End Call**, then **Log Call** writes it to the open ticket |

Confirm it landed in Vobiz:

```bash
curl -H "X-Auth-ID: $VOBIZ_AUTH_ID" -H "X-Auth-Token: $VOBIZ_AUTH_TOKEN" \
  "https://api.vobiz.ai/api/v1/Account/$VOBIZ_AUTH_ID/Call/?limit=1"
```

A `hangup_cause_name` of **`End Of XML Instructions`** means Vobiz fetched and
ran your webhook but had nothing to bridge to — almost always an unregistered
SIP endpoint. See [troubleshooting](#troubleshooting).

## Installing permanently

`zcli apps:server` only serves the app to *your* browser, for as long as it
runs. To install it for the whole account:

```bash
cd zendesk-app
npx @zendesk/zcli apps:package
```

Upload the resulting zip in **Admin Center → Apps and integrations →
Zendesk Support apps → Upload private app**, then fill in the settings from the
table in the [README](../README.md#configuration).

You will also need a stable `backend_url` — a quick tunnel is not good enough,
because its hostname changes on every restart.

> **Packaging needs two files this repo does not ship:** `assets/logo-small.png`
> (required by Zendesk) and a top-bar icon named `assets/icon_top_bar.svg`.
> Add your own branding before packaging.

## Troubleshooting

### The softphone says "Registration failed"

The SIP credentials are wrong or missing. Check what the backend is serving:

```bash
curl http://localhost:8092/agent/<your agent_id>
```

If `sipPassword` is absent, the `agents.json` entry is incomplete. If the
username does not match what Vobiz returned when you created the endpoint —
including its numeric suffix — registration will be rejected.

### The customer answers and hears silence, then the call drops

Your SIP endpoint was not registered when the call bridged, so there was
nothing on the other end. The CDR will show `End Of XML Instructions`.

Keep the softphone open and registered before dialling. The Call button is
disabled until registration succeeds, precisely to prevent this.

### The call never connects and nothing appears in the backend log

Vobiz could not reach your webhook. Verify from *outside* your network:

```bash
curl "https://<your-tunnel>/call-answer?agentId=priya"
```

If the tunnel has restarted, its hostname changed — update `backend_url` in the
app settings and `zcli.apps.config.json`.

### Call logs create a new ticket instead of using the open one

The `ticket_sidebar` location is how the app learns which ticket you are
viewing. Make sure you are on a ticket page, and that the app installed all
three locations.

### "This recording link is invalid or has expired"

Either the link is older than `RECORDING_TOKEN_TTL_MS` (30 days by default), or
the backend restarted without `RECORDING_TOKEN_SECRET` set, which regenerates
the key and invalidates every link ever issued. Set it in `.env`.

### Calls ring the wrong agent

Two agents share an `agent_id`. Each needs their own key in `agents.json` and
their own SIP endpoint.
