---
"@bongsu/core": minor
"@bongsu/api": patch
"@bongsu/node": minor
"@bongsu/schema": patch
---

Postgres: on Node and Docker, `DATABASE_URL=postgres://…` runs Bongsu on Postgres (the compose file's `postgres`
profile starts one); the tables come from `migrations/postgres/`, seed rows included. The app's SQL now works on both:
the database-specific bits live in `core/sql.ts`, and the queries Postgres rejected (untyped `IS NULL` parameters,
ambiguous names in upserts, the reserved `window`) are fixed.
