---
"@bongsu/schema": minor
"@bongsu/node": patch
"@bongsu/cloudflare": patch
---

The database schema is written once (`packages/schema`) and generated per database: `migrations/sqlite/` (the existing
0001–0009, unchanged, so current databases need nothing) and `migrations/postgres/`, plus `docs/schema.md` and
`schema.json`. Wrangler, the Node runner and the image now read `migrations/sqlite/`.
