# Updating

A new version is a `git pull` and the same deploy you did the first time. On Docker, stopping waits up to 30 seconds for a
scheduled run in progress, so an update doesn't cut a post in half. Back up first if the release changes the database
([Backups and restore](backups.md)).

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
Deploy both, or the scheduler and the app run different versions. `migrations apply` skips the ones already applied. Your secrets stay where they are
([Configuration](configuration.md)); a release that needs a new one says so in its changelog.

## On Docker

```sh
git pull && docker compose --profile https up -d --build
```

The image is built on your machine (`bongsu:local`), so there is nothing to pull from a registry: `--build` makes a
new one and `up -d` replaces the container. Keep the profiles you started with (`--profile postgres`,
`--profile mail`). Migrations run when the container starts, before it serves anything. Without Docker, pull, build
the three packages and start `server.mjs` again ([Self-hosting](self-hosting.md#without-docker)).

## Before an update that drops tables

A release that drops a table says so in its changelog. Migration `0014` drops `labels` and `manual_stats`, two tables an
instance that imported data from an earlier deployment may still hold rows in (nothing in Bongsu reads them). If you want what they hold,
take a backup first (see [Backups and restore](backups.md)): the migration runs on the next deploy (Cloudflare) or
start (Docker) and the rows are gone after it.

## Reading the changelogs

Each change users would notice ships with a Changeset, and the release turns them into `CHANGELOG.md` files:
`packages/core`, `packages/api`, `packages/web` and `apps/cloudflare` each have their own. Read what's new since the
version you run: `git log --oneline` shows the commits, the changelogs say what they mean for you.

- **fix**: a patch, safe to take.
- **feat**: a minor, something new; nothing you have stops working.
- **Breaking**: a commit written `feat(api)!: …` with a `BREAKING CHANGE:` line saying what breaks and how to migrate,
  and a major bump in the changelog. Read that line before you deploy; it is the one place a release asks something of
  you (a renamed variable, a changed endpoint for an agent or script).

## When the app says it's behind

The phone app is installed on the home screen and keeps a saved copy, so it can run older than the deployed one.
**Settings → Version** shows the app's commit and build time; after an update it says "A newer version is deployed"
with **Update now**, which reloads it. That is normal, not an error: [the phone app](the-app.md#offline-and-old-data).

After updating, check `https://<PUBLIC_URL>/health` (`ok: true`, all tables present, no missing secrets) and look at
the dashboard's Overview.
