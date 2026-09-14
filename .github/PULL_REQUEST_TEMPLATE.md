## What this changes

<!-- What changed and why. Link the issue it closes, if there is one. -->

## How it was tested

<!-- If you touched the call path, say what you did and what the CDR showed. -->

- [ ] `npm run lint` passes
- [ ] `npm run check:secrets` passes
- [ ] `zcli apps:validate ./zendesk-app` passes
- [ ] Tested against a real Zendesk account and a real call, or explained why not

## Checklist

- [ ] One fix or one feature
- [ ] `docs/backend-contract.md` updated if a route changed
- [ ] `CHANGELOG.md` updated, describing the symptom a user would have seen
- [ ] No credentials, SIP passwords, tunnel hostnames, or real phone numbers in the diff
- [ ] Anything interpolated into the VXML response goes through `escapeXml`
