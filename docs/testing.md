# Testing

## Automated

```bash
npm ci --prefix backend
npm test               # boots the backend with fetch intercepted; no network, no calls
npm run lint           # every .js parses, every .json is valid
npm run check:secrets  # no credentials or real numbers in the tree
```

`npm test` drives the real backend over HTTP: the answer XML in both
directions, session gating of the SIP identity, signed recording links, input
validation in the XML, Zendesk credential handling, CORS, and what `/setup` and
`/setup-inbound` change on the account. CI runs all three.

## Manual, against a live account

Every call here is real and billed.

1. **Answer URL.** From outside your network:
   `curl -s -X POST "$PUBLIC_BASE/answer" -d "From=sip:x@registrar.vobiz.ai&To=91XXXXXXXXXX&RouteType=sip"`
   must return `<Record …/>` then `<Dial …><Number>`.
2. **Health.** `curl -s localhost:8092/health` shows your account, caller ID,
   SIP user and `publicBase`.
3. **Sign in.** In Zendesk with `?zcli_apps=true`, open the panel, sign in, and
   wait for **READY**.
4. **Outbound.** Call a phone you have with you. The backend logs
   `DIAL RESULT status=… bleg=<uuid>`; an empty `bleg` means the customer leg was
   never created.
5. **Ticket log.** Make the call from an open ticket. A private note appears with
   direction, duration and a recording link. The link plays once the recording
   is ready (usually within a minute).
6. **Inbound.** Click **Enable inbound calls**, then call `VOBIZ_FROM_NUMBER`
   from another phone. The panel rings with the caller's number (and name, if
   a Zendesk user has that phone number); **Enter** accepts.

| Symptom | Look at |
| --- | --- |
| Panel never reaches READY | SIP username must be the stored one, with its numeric suffix |
| Call fails instantly, nothing in the backend log | Vobiz cannot reach `PUBLIC_BASE/answer` — re-run check 1 |
| `bleg=(none …)` | Destination unreachable, or the caller ID is not on this account |
| CDR billed 0s | Network/ICE — try another network; STUN must reach `stun.l.google.com:19302` |
| `OPTIONS 204` and no request after it | CORS preflight failed — add your origin to `ALLOWED_ORIGINS` |
