# Security policy

## Reporting a vulnerability

Email **security@vobiz.ai** (or **support@vobiz.ai**). Please do not open a
public issue for a security problem.

Include what you found, how to reproduce it, and what an attacker could do with
it. We will acknowledge your report and keep you updated.

## What this software protects, and what it does not

### What is handled

**Credentials live on the backend.** The Vobiz Auth Token, the SIP endpoint
password and the Zendesk API token are read from `backend/.env`. Signing in to
the panel checks the agent's Auth ID and Auth Token against that file and
returns an opaque session token, held in `sessionStorage`. Nothing the browser
holds can be replayed against the Vobiz API.

**The SIP identity is behind the session.** `GET /agent` returns the SIP
username and password only to a signed-in session. There is no per-agent-id
variant.

**Recording links carry no credentials.** Links are HMAC-SHA256 signed with
`SIGNING_SECRET` and expire: `RECORDING_URL_TTL_SECONDS` (default 5 minutes)
for links in the panel, `TICKET_RECORDING_LINK_TTL_SECONDS` (default 7 days)
for links written into ticket comments. The audio is fetched from Vobiz
server-side. No route accepts a caller-supplied URL.

**Zendesk credentials cannot be redirected.** The Zendesk subdomain, email and
token come only from `.env`, and the subdomain is validated as a bare label
before it is placed in a URL.

**The answer webhook validates and escapes its inputs.** `/answer` returns XML
that Vobiz executes. Destinations and caller IDs must be plain phone numbers;
a caller ID chosen in the panel must be a number the account owns; every
interpolated value is XML-escaped.

**CORS is scoped.** Only Zendesk's app origins (`*.apps.zdusercontent.com`,
`*.zendesk.com`, `*.zdassets.com`), localhost, and origins listed in
`ALLOWED_ORIGINS` receive an `Access-Control-Allow-Origin` header. Never `*`.

**Nothing changes on your Vobiz account at boot.** `POST /setup` (run when an
agent signs in) creates the application and binds the SIP endpoint.
`POST /setup-inbound` (the panel's **Enable inbound calls** button) additionally
attaches `VOBIZ_FROM_NUMBER` to that application — which detaches it from any
other application.

These behaviours are covered by `backend/test/` and run in CI.

### What is NOT handled

**Vobiz webhooks are not signature-checked.** `/answer`, `/dial-status` and
`/recording-ready` must be reachable by Vobiz and accept any caller. Someone who
knows the backend URL can post fake call events into the in-memory call ledger
(which only affects call-log metadata), but cannot obtain credentials or place
calls through them.

**One backend, one Vobiz account, one SIP endpoint.** Every agent who signs in
to a backend registers as the same SIP endpoint. For several agents, run one
backend per agent or extend the backend with per-agent endpoints.

**The SIP password reaches the browser.** WebRTC registration needs it. It is
served only to a signed-in session, over HTTPS, and is never stored in
`localStorage`. The SIP-direct sign-in option remembers the username and caller
ID only, never the password.

**Session state is in memory.** Restarting the backend signs everyone out.

**Quick tunnels are not a deployment.** `trycloudflare.com` and similar
hostnames are recycled. A setting pointing at an expired tunnel resolves to
whoever holds that name next. Use a named tunnel or a real host for anything
beyond a local test.

## Hardening checklist

Before running this against real customers:

- [ ] Serve the backend over HTTPS on a stable hostname
- [ ] Set `SIGNING_SECRET` to a stable random value (`openssl rand -hex 32`)
- [ ] Keep `backend/.env` and `zcli.apps.config.json` out of version control
      (both are gitignored)
- [ ] Leave `TRANSCRIPTION_WEBHOOK_SECRET` blank unless you use that webhook
- [ ] Restrict `ALLOWED_ORIGINS` to what you actually need
- [ ] Rotate any credential that has appeared in a shell history, a log, or a
      screenshot
