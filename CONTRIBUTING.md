# Contributing

Thanks for taking the time. This is a small project — one Express backend and a
three-location ZAF app — so most changes are quick to make and quick to review.

## Getting set up

Full walkthrough in [docs/install.md](docs/install.md). The short version:

```bash
cd backend && npm install
cp .env.example .env
cp agents.json.example agents.json     # needs a real SIP endpoint
npm start                              # → localhost:8092

cloudflared tunnel --url http://localhost:8092

cd ../zendesk-app
cp zcli.apps.config.json.example zcli.apps.config.json
npx @zendesk/zcli apps:server
```

Then `https://<subdomain>.zendesk.com/agent/dashboard?zcli_apps=true`.

**You need a real Vobiz account to exercise the call path.** There is no mock
telephony backend; a call either happens or it does not.

## Before opening a pull request

```bash
npm run lint          # syntax check across backend and app
npm run check:secrets # no credentials, tokens, or real numbers in the diff
npx @zendesk/zcli apps:validate ./zendesk-app
```

CI runs all three. If you changed the call path, say in the pull request how
you tested it and what the CDR showed.

## Things that will be sent back

**Credentials in a URL that gets stored.** Recording links end up in ticket
bodies, which are exported, searched, and audited forever. Seal them or sign
them. See `sealRecordingToken` in `backend/server.js`.

**Unescaped interpolation into the VXML response.** `/call-answer` returns XML
that the telephony platform *executes*. Everything that goes into it must pass
through `escapeXml`, and routing values must be validated with `isDialable`.

**Re-sending credentials to a different host on failure.** A previous build
retried `/start-call` against a hardcoded fallback host, carrying the agent's
Auth Token with it. Fail loudly instead.

**Anything sensitive in `localStorage`, `sessionStorage`, or a cookie.**

**A working credential in a file named `.example`.** Verify with
`git check-ignore -v <path>`.

**Silent success.** Returning `ok: true` on a failed hangup, or 200 for a
missing recording, makes real failures invisible. Report the real status.

## House style

- No build step, no framework, no bundler. Plain browser JavaScript and a small
  Express server.
- Comments explain **why**, not what. The three worth reading before you edit
  the call path: the customer-dialled-first ordering, the `peerconnection`
  audio binding, and the cold-cache branch in `/call-answer`. Each looks wrong
  until you know the failure it prevents.
- User-facing strings are sentences and say what to do next.
- Keep `docs/backend-contract.md` in step with the routes. If you add, rename,
  or change the shape of a route, update that file in the same pull request.

## Project layout

| Path | Notes |
| --- | --- |
| `backend/server.js` | Routes, the VXML webhook, the recording proxy |
| `backend/zendeskService.js` | Everything that writes into Zendesk |
| `zendesk-app/assets/scripts/app.js` | The softphone. The large one. |
| `zendesk-app/assets/scripts/background.js` | Click-to-dial relay only |
| `zendesk-app/assets/sidebar.html` | Exists solely to resolve ticket context |
| `zendesk-app/manifest.json` | Locations and settings. Settings must be declared here to be readable at runtime. |

## Commit messages

Explain the change and why it was needed. If you fixed a bug, describe the
symptom someone would have seen — that is what makes a changelog useful later.

## Reporting a vulnerability

Do not open an issue. See [SECURITY.md](SECURITY.md).
