# Databases

Bongsu keeps everything except media in one database: the plan, texts, approvals, accounts, connections and
settings. Its schema is written once, without any database's SQL, in `packages/schema`, and each database's SQL is
generated from it. Every table and column is listed in [schema.md](schema.md).

## Which database

| You run Bongsu on | Database | Status |
|---|---|---|
| Cloudflare ([deploy-cloudflare.md](../site/docs/deploy-cloudflare.md)) | D1 (SQLite) | supported |
| Docker or Node ([self-hosting.md](../site/docs/self-hosting.md)) | SQLite, one file on a volume | supported |
| Docker or Node | Postgres (`DATABASE_URL`, or the compose file's `postgres` profile) | supported |
| Cloudflare | Postgres through Hyperdrive | not yet |

SQLite is the simple choice: one file, nothing to run. Postgres suits an instance you already back up with your other
databases, or one with many workspaces.

## Backups

- **D1:** `pnpm exec wrangler d1 export bongsu --remote --output backup.sql` (in `apps/cloudflare`).
- **SQLite on Docker or Node:** `node server.mjs backup <file>`, a consistent copy while Bongsu runs
  ([self-hosting.md](../site/docs/self-hosting.md#backups)).
- **Postgres:** `pg_dump`, e.g. `docker compose exec postgres pg_dump -U bongsu bongsu > backup.sql`.

## Moving between databases

`node server.mjs export <file>` writes every table to one JSON file (neutral: the same on every database), and
`node server.mjs import <file>` loads it into a fresh database. They work on whichever database the settings point
at (`DATABASE_PATH`, or `DATABASE_URL` for Postgres). An import is all or nothing, refuses a database that already has
data, and refuses an export made for another schema version: update both sides to the same Bongsu first.

The export holds everything but the media (which stays in its store), including encrypted credentials: keep the same
`ENCRYPTION_KEY` (and `MEDIA_SIGNING_KEY`) on the new instance, and treat the file like a backup.

### SQLite to Postgres (Docker)

```sh
docker compose exec bongsu node server.mjs export /data/bongsu-export.json
docker compose down
# in .env: POSTGRES_PASSWORD=…  DATABASE_URL=postgres://bongsu:…@postgres:5432/bongsu
docker compose --profile postgres up -d postgres
docker compose --profile postgres run --rm bongsu node server.mjs import /data/bongsu-export.json
docker compose --profile https --profile postgres up -d
```

The `bongsu-data` volume keeps the SQLite file and the export: remove them once the new instance is checked.

### D1 (Cloudflare) to Postgres

D1's own export is SQL for SQLite, so it goes through a SQLite file first:

```sh
# 1. on Cloudflare: pause publishing in the app, then
cd apps/cloudflare && pnpm exec wrangler d1 export bongsu --remote --output d1.sql
# 2. with the Node build (pnpm --filter @bongsu/node build), from apps/node:
DATABASE_PATH=from-d1.db node dist/server.mjs load-sql d1.sql      # a new SQLite file from the dump
DATABASE_PATH=from-d1.db node dist/server.mjs export bongsu-export.json
DATABASE_URL=postgres://… node dist/server.mjs import bongsu-export.json
```

Then start the new instance with the same secrets (`ENCRYPTION_KEY`, `MEDIA_SIGNING_KEY`, the VAPID pair) and the
public URL people's passkeys were made for (`PUBLIC_URL`, `RP_ID`): passkeys are tied to that hostname, so a new
hostname means adding the devices again. Resume publishing on the new instance only.

## How the schema is built

- `packages/schema/src/migrations/`: the neutral migrations. The first, `0009_baseline`, is the schema the
  hand-written SQLite migrations `migrations/sqlite/0001…0009` built; each later one is a list of neutral steps
  (create a table, add a column, create an index…).
- `pnpm --filter @bongsu/schema generate` writes `migrations/sqlite/` and `migrations/postgres/` (each database's
  migrations, applied by wrangler and the Node runner), [schema.md](schema.md) and `packages/schema/schema.json` (the
  same as data, for other tools). A test fails when a generated file is out of date.
- `bongsu schema --dialect sqlite|postgres` prints the DDL for a fresh database from the same source (for example
  `bongsu schema --dialect postgres | psql "$DATABASE_URL"`).
- Another test builds a SQLite database from `migrations/sqlite/` and another from the generated DDL and compares
  them column by column, so the neutral schema matches what existing databases already have.

### Changing the schema

1. Add `packages/schema/src/migrations/NNNN_<name>.ts` with its steps and list it in `index.ts`.
2. Run `pnpm --filter @bongsu/schema generate` and commit the generated files.
3. Never edit a released migration: add another.

### Writing SQL that works on every database

The code's SQL stays in what SQLite and Postgres share; `packages/core/test/portable-sql.test.ts` fails on the usual
mistakes:

- No SQLite-only functions (`unixepoch()`, `json_each`, `strftime`…): what differs lives in `packages/core/src/sql.ts`
  (`jsonList` for "IN a list of values", `tableNames`).
- A parameter only tested with `IS NULL` needs a type: `CAST(?2 AS TEXT) IS NULL OR …`.
- In `ON CONFLICT … DO UPDATE`, name the table's column (`rate_limits.n + 1`, `WHERE settings.value < ?1`): Postgres
  finds a bare name ambiguous.
- Reserved words as column names are quoted (`"window"`).

The Db conformance cases (`packages/core/src/db-conformance.ts`) run on D1, SQLite and PGlite, and the Node app's main
paths run on PGlite too (`apps/node/test/postgres.test.ts`).

### Adding a database

A dialect (`packages/schema/src/sqlite.ts` and `postgres.ts` are the examples: a type map, how `NOW` is written, how
names are quoted) plus a `Db` adapter (`packages/core/src/db.ts`), checked with the Db conformance suite
(`packages/core/src/db-conformance.ts`).
