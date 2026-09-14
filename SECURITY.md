# Security policy

## Reporting a vulnerability

Email **security@vobiz.ai** (or **support@vobiz.ai**). Please do not open a
public issue for a security problem.

Include what you found, how to reproduce it, and what an attacker could do with
it. We will acknowledge your report and keep you updated.

## What this software protects, and what it does not

Be clear-eyed about this before deploying. The list below is honest rather than
reassuring.

### What is handled

**Credentials never reach a Zendesk ticket.** A recording link written into a
ticket is readable by every agent, every export, and every audit log,
permanently. Links therefore carry an AES-256-GCM sealed token with an expiry —
not your Vobiz Auth Token.

**The call-flow webhook escapes its inputs.** `/call-answer` returns XML that
the telephony platform *executes*. Every interpolated value is escaped, and the
caller ID is emitted only when it is a dialable number. Unescaped input here
would let a caller inject arbitrary verbs into a live call flow.

**Credentials are not stored at rest.** Agents sign in through the panel; their
Vobiz credentials are sent per request and held in their own browser session.
The backend keeps no session store.

**Failures are reported honestly.** A failed hangup returns a non-2xx, and a
missing recording returns 404 rather than a 200 carrying an HTML page.

### What is NOT handled

#### The backend is unauthenticated

**Every route is open.** There is no API key, no bearer token, no signature
check. Identity is whatever `agentId` the caller sends, and that value is
guessable.

Anyone who can reach the backend can:

- read an agent's SIP credentials from `GET /agent/:agentId` and register as
  them,
- place calls billed to any account whose credentials they also have,
- write comments and create tickets via `/sync-call`, if the backend holds
  Zendesk credentials.

Mitigate by keeping the backend **off the public internet**, except for the
webhook paths Vobiz must reach (`/call-answer`). Put it behind your VPN, an
allowlist, or a reverse proxy that authenticates everything else.

A production deployment should add per-agent authentication. Pull requests
welcome.

#### CORS is wide open

`Access-Control-Allow-Origin: *`. Combined with the above, any web page an agent
visits can call this backend. Scope it to your Zendesk subdomain before
deploying.

#### SIP passwords are served to the browser

The softphone registers with a real SIP password, which means the backend must
hand it to the browser in cleartext over `GET /agent/:agentId`. Short-lived
credentials would be better; the Vobiz endpoint API does not currently offer
them.

#### Agent credentials pass through the backend

Agents type their Vobiz Auth ID and Token into the panel, which posts them to
the backend on each request. Serve the backend over HTTPS only, and treat it as
a system that handles credentials.

#### Quick tunnels are not a deployment

`trycloudflare.com` and similar hostnames are **recycled**. A link pointing at
an expired tunnel resolves to whoever holds that name next. Never leave a quick
tunnel in a Zendesk app setting beyond development.

## Hardening checklist

Before running this against real customers:

- [ ] Add authentication to every backend route
- [ ] Scope CORS to your Zendesk subdomain
- [ ] Set `RECORDING_TOKEN_SECRET` to a stable, secret value
- [ ] Serve the backend over HTTPS with a stable hostname
- [ ] Give every agent their own `agent_id` and SIP endpoint
- [ ] Confirm `backend/agents.json` and `backend/.env` are gitignored
- [ ] Rotate any credential that has appeared in a shell history, a log, or a
      screenshot

## A note on `.env.example`

This repository ships `backend/.env.example` with **every value blank**, and
`.gitignore` is written so that `.env` is ignored while `.env.example` is
tracked.

That distinction is easy to get wrong. A pattern of `*.env` does **not** match
`.env.example`, because that filename ends in `.example`. If you add config
files, verify with:

```bash
git check-ignore -v backend/.env          # should be ignored
git check-ignore -v backend/.env.example  # should NOT be ignored
```

Never put a working credential in a file named `.example`.
