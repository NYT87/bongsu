---
"@bongsu/api": minor
"@bongsu/core": minor
"@bongsu/dashboard": minor
---

A pending invite's link can be copied again from Members (**Copy link**) until it's used, expires or is revoked. The link is kept encrypted with `ENCRYPTION_KEY` (migration 0027 adds `invites.token_enc`); invites made before, or without the key, still show their link once.
