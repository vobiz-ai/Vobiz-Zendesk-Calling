# Testing

## Automated

```bash
npm ci --prefix backend
npm test               # boots the backend with fetch intercepted; no network, no calls
npm run lint           # every .js parses, every .json is valid
npm run check:secrets  # no credentials or real numbers in the tree
```

`npm test` drives the real backend over HTTP with **no Vobiz values in its
environment**, against two fake accounts (`MA_TEST0001`, `MA_TEST0002`): both
sign in and get distinct endpoints, a wrong token is refused, outbound and
inbound webhooks route to the right account (SIP username, `ParentAuthID`,
dialled number, SIP direct), the 17-digit app id reaches the bind request
exactly, the caller-ID list is paged and filtered, recording links are
account-scoped, and no response or log line ever contains an Auth Token. Plus
the older checks: session gating of the SIP identity, input validation in the
XML, Zendesk credential handling, CORS, and that only **Enable inbound calls**
moves a number. CI runs all three.

## Manual, against a live account

Every call here is real and billed.

1. **Answer URL.** From outside your network:
   `curl -s -X POST "$PUBLIC_BASE/answer" -d "From=sip:x@registrar.vobiz.ai&To=91XXXXXXXXXX&RouteType=sip"`
   must return `<Record …/>` then `<Dial …><Number>`.
2. **Health.** `curl -s localhost:8092/health` shows `publicBase` and how many
   accounts and sessions are signed in.
3. **Sign in.** In Zendesk with `?zcli_apps=true`, open the panel, sign in with
   any Vobiz account's Auth ID and Auth Token, and wait for **READY**. The
   backend log shows the application and endpoint it found or created and
   whether the bind verified.
4. **Outbound.** Call a phone you have with you. The backend logs
   `DIAL RESULT status=… bleg=<uuid>`; an empty `bleg` means the customer leg was
   never created.
5. **Ticket log.** Make the call from an open ticket. A private note appears with
   direction, duration and a recording link. The link plays once the recording
   is ready (usually within a minute).
6. **Inbound.** Click **Enable inbound calls**, then call the selected number
   from another phone. The panel rings with the caller's number (and name, if
   a Zendesk user has that phone number); **Enter** accepts.

| Symptom | Look at |
| --- | --- |
| Panel never reaches READY | Backend log: did the endpoint bind verify? (SIP direct: the username must be the stored one, with its numeric suffix) |
| Call fails instantly, nothing in the backend log | Vobiz cannot reach `PUBLIC_BASE/answer` — re-run check 1 |
| `bleg=(none …)` | Destination unreachable, or the caller ID is not on this account |
| CDR billed 0s | Network/ICE — try another network; STUN must reach `stun.l.google.com:19302` |
| `OPTIONS 204` and no request after it | CORS preflight failed — add your origin to `ALLOWED_ORIGINS` |
