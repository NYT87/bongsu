# Backups and restore

Everything but media lives in one database: the plan, texts, approvals, accounts, connections and settings. Back that
up, keep the media where it already is, and keep your secrets somewhere safe. The database side in detail is in
[Databases](../../docs/databases.md).

## What a backup holds, and what it doesn't

- **Holds:** the plan and its texts, approvals, posted records, accounts, connections (the credentials encrypted),
  settings, keys and passkeys.
- **Doesn't hold the secrets.** Credentials in the database are encrypted with `ENCRYPTION_KEY`: a restore without the
  same `ENCRYPTION_KEY` (and `MEDIA_SIGNING_KEY`, the VAPID pair) can't read them. Keep the values from
  `wrangler secret put` or your `.env` in a password manager ([Configuration](configuration.md)).
- **Doesn't hold the media.** See below.
- **Passkeys** belong to a hostname: a restored instance on the same `PUBLIC_URL` and `RP_ID` keeps working; on a new
  hostname, add the devices again.

## Cloudflare (D1)

From `apps/cloudflare`:

```sh
pnpm exec wrangler d1 export bongsu --remote --output backup.sql
```

That is SQL for SQLite. To restore, create an empty D1 database, load the dump into it, and point both wrangler files
at it:

```sh
pnpm exec wrangler d1 execute <database> --remote --file=backup.sql
```

To move to Docker instead, make a SQLite file with the Node build (`pnpm --filter @bongsu/node build`), from `apps/node`:

```sh
DATABASE_PATH=bongsu.db node dist/server.mjs load-sql backup.sql
```

`load-sql` only makes a new database: it refuses a file that exists. Put the file into the volume as the `node` user
(see the Docker restore below, with your file in place of the backup).

## Docker (SQLite)

The database is one file in the `bongsu-data` volume. A consistent copy, safe while Bongsu runs:

```sh
docker compose exec bongsu node server.mjs backup /data/backup-$(date +%F).db
docker compose cp bongsu:/data/backup-$(date +%F).db .
```

To restore, with the copy in the current directory (the container runs as `node`, so copy inside it to keep the
ownership; the `$PWD` mount is read-only):

```sh
docker compose stop bongsu
docker compose run --rm -v "$PWD":/restore:ro bongsu sh -c \
  'cp /restore/backup-2026-10-31.db /data/bongsu.db && rm -f /data/bongsu.db-wal /data/bongsu.db-shm'
docker compose up -d
```

(Use `--profile https` on `up` if you started with it.) Without Docker, the same commands run as
`node dist/server.mjs backup <file>`, `export <file>` and `import <file>` from `apps/node`, with `DATABASE_PATH` set.

## Postgres

```sh
docker compose exec -T postgres pg_dump -U bongsu bongsu > backup.sql
```

Restore the dump into an empty database, then start Bongsu (it migrates at start):

```sh
docker compose --profile postgres up -d postgres
docker compose exec -T postgres psql -U bongsu bongsu < backup.sql
docker compose --profile postgres up -d
```

## A copy that moves between databases

`node server.mjs export <file>` writes every table as JSON, the same on every database, and `import <file>` loads it
into a fresh one (it refuses a database with data in it, and an export made by another version: update both sides
first):

```sh
docker compose exec bongsu node server.mjs export /data/bongsu-export.json
```

The file holds the encrypted credentials: treat it like a backup. The moves from SQLite or D1 to Postgres are written
out in [Databases](../../docs/databases.md).

## The plan as a file

`bongsu export --format csv --texts > plan.csv` writes every plan item. It is for reading and scripts, not a backup:
it holds no approvals, accounts or connections ([The command line](cli.md)).

## Media

The media stores keep the files; the database only references them (which stores are set up, with their keys and
grants, is in the database backup, encrypted with `ENCRYPTION_KEY`).

- **Drive:** the files are already Drive's own copy; Bongsu only reads them and moves posted ones to
  `UPLOADS/_posted/` ([Google Drive](drive.md)).
- **A bucket:** the files are the bucket's; turn on its versioning or replication if you want copies
  ([S3-compatible buckets](s3.md)).
- **This server's disk** (`MEDIA_DIR`): back up the directory, on Docker the `bongsu-media` volume
  (`docker compose cp bongsu:/media .` copies it out).

## Test a restore

A backup you haven't restored is a guess. Once, restore into a scratch copy (`DATABASE_PATH=test.db`, a different
`PORT`) and open it. The copy holds your live connections, so start it with `SCHEDULES=off` (it serves and runs no
schedules) and `DRY_RUN=1`: without them it would publish the same posts as the real instance.
