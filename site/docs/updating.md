# Updating

A new version is the same deploy you did the first time, from a newer release. For a patch, that is all there is to it
([On Cloudflare](#on-cloudflare), [On Docker](#on-docker)). For anything bigger (a release with a migration, or one whose
changelog asks something of you), take the careful route: read the changelogs, back up, rehearse on a copy, update in a
quiet window, and know the way back.

## The careful route

### 1. Read what changes

[Read the changelogs](#reading-the-changelogs) since the version you run. Look for three things: a **migration**
(new SQL files in `migrations/`, which run on the next deploy or start), a **table that is dropped** (the changelog says
so; its rows are gone after the update) and a **breaking change** (a `BREAKING CHANGE:` line that says what to do).

### 2. Back up

Take a backup right before updating, even if you have nightly ones ([Backups and restore](backups.md)):

- **Cloudflare**, from `apps/cloudflare`: `pnpm exec wrangler d1 export bongsu --remote --output backup.sql`.
- **Docker** (SQLite): `docker compose exec bongsu node server.mjs backup /data/backup-$(date +%F).db`, then
  `docker compose cp bongsu:/data/backup-$(date +%F).db .` to have it outside the container.
- **Postgres**: `docker compose exec -T postgres pg_dump -U bongsu bongsu > backup.sql`.

Keep your secrets (`ENCRYPTION_KEY` above all) with the backup: a restore can't read the connections without them.

### 3. Rehearse on a copy

Run the new version on a copy of the backup, without schedules, and check it migrates and answers. **`DRY_RUN=1` alone
is not enough for a copy**: it stops publishing, but the other schedules still act outside the copy (they move posted
media on Drive, send the daily digest and push notifications to your real devices, renew Instagram tokens). A
rehearsal runs no schedules at all.

**On Docker** (SQLite), with the backup from step 2 in the current directory and the new image (`bongsu:local` after
`git pull && docker compose build`, or `ghcr.io/nyt87/bongsu:<version>`):

```sh
docker volume create bongsu-rehearsal
docker run --rm -v bongsu-rehearsal:/data -v "$PWD":/restore:ro --entrypoint sh <image> \
  -c 'cp /restore/backup-2026-11-03.db /data/bongsu.db'
docker run --rm -d --name bongsu-rehearsal -v bongsu-rehearsal:/data -p 127.0.0.1:8788:8787 \
  --env-file .env -e SCHEDULES=off -e DRY_RUN=1 -e DATABASE_URL= <image>
docker logs bongsu-rehearsal              # "migrations: …", "schedules off", "dry run true"
curl -s localhost:8788/health             # ok: true, every table, no missing secrets
docker stop bongsu-rehearsal && docker volume rm bongsu-rehearsal
```

`-e DATABASE_URL=` keeps the copy on its own SQLite file even if your `.env` points at Postgres; with Postgres, restore
the dump into a scratch database and set `DATABASE_URL` to that one instead.

**On Cloudflare**, locally: the web Worker on your machine runs no schedules (the cron is the other Worker). From
`apps/cloudflare`, after `git pull`, `pnpm install` and `pnpm build`:

```sh
pnpm exec wrangler d1 execute bongsu --local --persist-to .rehearsal --file backup.sql
pnpm exec wrangler d1 migrations apply bongsu --local --persist-to .rehearsal   # only the new ones
pnpm exec wrangler dev --persist-to .rehearsal --port 8788
```

The export holds the record of applied migrations, so `migrations apply` runs only the release's new ones; check
`http://localhost:8788/health` lists the tables and open `http://localhost:8788/dashboard`. Without a `.dev.vars` the
secrets show as missing; that is expected here. Passkeys don't work on `localhost` (they belong to your hostname),
so the rehearsal shows that the copy migrates and serves, not a sign-in. Remove `.rehearsal/` afterwards.

### 4. Pick a quiet window

Update when nothing is due for a few hours: look at **Queue** or **Calendar** in the app, or `bongsu queue --days 1`
([The command line](cli.md)). To be sure nothing goes out mid-update, use **Settings → Publishing → Pause
everything** first, in each workspace (a pause holds only its own), and **Resume with passkey** after checking: items
that came due in between go out on resume, if they are less than 6 hours late
([Pausing everything](the-app.md#pausing-everything-and-resuming)).

### 5. Update and check

Deploy as below ([Cloudflare](#on-cloudflare), [Docker](#on-docker)), then check `https://<PUBLIC_URL>/health`
(`ok: true`, every table, no missing secrets) and the dashboard's Overview, and resume if you paused.

### 6. The way back

Migrations only go forward: going back means the previous version **and** the database from before.

- **Cloudflare:** `pnpm exec wrangler rollback` and `pnpm exec wrangler rollback -c wrangler.cron.toml` put both Workers
  back on their previous versions (`wrangler deployments list` shows them). If the release migrated the database,
  restore it too: `pnpm exec wrangler d1 time-travel restore bongsu --timestamp=<before the update>` (D1 keeps 30 days
  on the paid plan, 7 on the free one), or load `backup.sql` into an empty database ([Backups and restore](backups.md)).
- **Docker:** set `BONGSU_IMAGE` back to the version you ran (or `git checkout` its tag and build), restore the
  backup ([Backups and restore](backups.md#docker-sqlite)) and start again.

Restoring the database loses what was written since the backup (new approvals, posted records), so roll back soon,
and only when the new version can't be fixed forward: a release without a migration can go back on the code alone.

## On Cloudflare

From the repository, with `wrangler` logged in:

```sh
git pull
pnpm install
cd apps/cloudflare
pnpm exec wrangler d1 migrations apply bongsu --remote
cd ../..
pnpm build               # the phone app and the dashboard
cd apps/cloudflare
pnpm run deploy          # both Workers
```

`pnpm run deploy` is `wrangler deploy && wrangler deploy -c wrangler.cron.toml`: the web Worker and the cron Worker.
Deploy both, or the scheduler and the app run different versions. `migrations apply` skips the ones already applied.
Your secrets stay where they are ([Configuration](configuration.md)); a release that needs a new one says so in its
changelog.

## On Docker

Built from your checkout:

```sh
git pull && docker compose --profile https up -d --build
```

With the published image (`BONGSU_IMAGE` in `.env`, [Self-hosting](self-hosting.md#2-start)): set it to the new
version (or keep `latest`), then

```sh
docker compose pull bongsu && docker compose --profile https up -d
```

Either way `up -d` replaces the container. Keep the profiles you started with (`--profile postgres`, `--profile
mail`). Stopping waits up to 30 seconds for a scheduled run in progress, so an update doesn't cut a post in half, and
the migrations run when the container starts, before it serves anything. Without Docker, pull, build the three
packages and start `server.mjs` again ([Self-hosting](self-hosting.md#without-docker)).

## Before an update that drops tables

A release that drops a table says so in its changelog. Migration `0014` drops `labels` and `manual_stats`, and `0015`
drops `reports` (the old performance reviews): tables an instance that imported data from an earlier deployment may
still hold rows in (nothing in Bongsu reads them). If you want what they hold, take a backup first (above): the
migration runs on the next deploy (Cloudflare) or start (Docker) and the rows are gone after it.

## Reading the changelogs

Each change users would notice ships with a Changeset, and the release turns them into `CHANGELOG.md` files (one per
package, `packages/core`, `packages/api`, `packages/web`, `apps/cloudflare` and the others) and a GitHub release per
package version. Read what's new since the version you run: `git log --oneline` shows the commits, the changelogs say
what they mean for you.

- **fix**: a patch, safe to take.
- **feat**: a minor, something new; nothing you have stops working.
- **Breaking**: a commit written `feat(api)!: …` with a `BREAKING CHANGE:` line saying what breaks and how to migrate,
  and a major bump in the changelog. Read that line before you deploy; it is the one place a release asks something of
  you (a renamed variable, a changed endpoint for an agent or script).

## When the app says it's behind

The phone app is installed on the home screen and keeps a saved copy, so it can run older than the deployed one.
**Settings → Version** shows the app's commit and build time; after an update it says "A newer version is deployed"
with **Update now**, which reloads it. That is normal, not an error: [the phone app](the-app.md#offline-and-old-data).
