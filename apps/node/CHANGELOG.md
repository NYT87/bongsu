# @bongsu/node

## 0.2.0

### Minor Changes

- 839cc12: Docker: a multi-stage, non-root image with the SQLite file on a volume and a health check on `/health`;
  `docker-compose.yml` with optional Caddy (HTTPS, profile `https`) and Mailpit (profile `mail`); `.env.example`;
  `node server.mjs backup <file>` for a consistent copy while it runs. Guide: `site/docs/self-hosting.md`.
- 839cc12: Moving an instance between databases: `node server.mjs export <file>` writes every table to neutral JSON, `import
  <file>` loads it into a fresh SQLite or Postgres database (all or nothing, same schema version only), and `load-sql
  <dump>` turns a `wrangler d1 export` into a SQLite file to export from. Walkthroughs for SQLite → Postgres and D1 →
  Postgres in docs/databases.md.
- 6b61b80: How many publishing jobs a run advances is now a setting, `JOBS_PER_TICK`: Cloudflare keeps 4 (the free plan's subrequest limit), Node and Docker default to 20 since they have no such limit, and either can set it (up to 100). The configuration guide explains how items due at the same minute go out.
- 839cc12: Bongsu runs on Node: `apps/node` serves the app, the dashboard and the APIs, runs the three schedules with node-cron
  and keeps everything in one SQLite file (migrations applied at start). New: a `local` media store (a directory,
  `MEDIA_STORE=local`, `MEDIA_DIR`) and an `smtp` mailer on Node. The schedules now live in one place
  (`core/schedules.ts`), shared with the Cloudflare cron Worker; `/health` asks only for the secrets the media store in
  use needs.
- 839cc12: Postgres: on Node and Docker, `DATABASE_URL=postgres://…` runs Bongsu on Postgres (the compose file's `postgres`
  profile starts one); the tables come from `migrations/postgres/`, seed rows included. The app's SQL now works on both:
  the database-specific bits live in `core/sql.ts`, and the queries Postgres rejected (untyped `IS NULL` parameters,
  ambiguous names in upserts, the reserved `window`) are fixed.

### Patch Changes

- 839cc12: The database schema is written once (`packages/schema`) and generated per database: `migrations/sqlite/` (the existing
  0001–0009, unchanged, so current databases need nothing) and `migrations/postgres/`, plus `docs/schema.md` and
  `schema.json`. Wrangler, the Node runner and the image now read `migrations/sqlite/`.
- 839cc12: Updates nodemailer to 10.1.7 for its security fixes (the `smtp` mailer).
- Updated dependencies [839cc12]
- Updated dependencies [839cc12]
- Updated dependencies [839cc12]
- Updated dependencies [839cc12]
- Updated dependencies [839cc12]
- Updated dependencies [839cc12]
- Updated dependencies [839cc12]
- Updated dependencies [839cc12]
- Updated dependencies [839cc12]
- Updated dependencies [839cc12]
- Updated dependencies [839cc12]
- Updated dependencies [839cc12]
- Updated dependencies [839cc12]
- Updated dependencies [839cc12]
- Updated dependencies [839cc12]
- Updated dependencies [6b61b80]
- Updated dependencies [839cc12]
- Updated dependencies [839cc12]
- Updated dependencies [839cc12]
- Updated dependencies [839cc12]
- Updated dependencies [839cc12]
- Updated dependencies [839cc12]
- Updated dependencies [839cc12]
- Updated dependencies [839cc12]
- Updated dependencies [839cc12]
- Updated dependencies [839cc12]
- Updated dependencies [839cc12]
- Updated dependencies [839cc12]
- Updated dependencies [839cc12]
- Updated dependencies [839cc12]
- Updated dependencies [839cc12]
- Updated dependencies [839cc12]
- Updated dependencies [0af344f]
- Updated dependencies [839cc12]
- Updated dependencies [839cc12]
- Updated dependencies [839cc12]
- Updated dependencies [839cc12]
  - @bongsu/core@0.2.0
  - @bongsu/api@0.2.0
  - @bongsu/schema@0.2.0
