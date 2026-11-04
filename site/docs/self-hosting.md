# Self-hosting with Docker (or Node)

Bongsu runs on any server with Docker: one container serves the app, the dashboard and the APIs and runs the
schedules, with everything in one SQLite file. It's the same code as the Cloudflare deployment
([deploy-cloudflare.md](deploy-cloudflare.md)); only the runtime differs (`apps/node`).

## What you need

- A server with Docker and Docker Compose.
- **A public HTTPS address**: passkeys only work over HTTPS, and Instagram downloads each post's media from it. A
  domain pointing at the server is enough: the compose file's `https` profile runs Caddy, which gets the certificate.
- The OAuth apps for the platforms you connect, as for Cloudflare ([instagram-graph.md](instagram-graph.md),
  [youtube.md](youtube.md)).

## 1. Settings

```sh
git clone https://github.com/NYT87/bongsu.git && cd bongsu
cp .env.example .env
```

Fill in `.env` ([configuration.md](configuration.md) explains each setting; the names are the Cloudflare ones):

- `PUBLIC_URL` (`https://bongsu.example.com`) and `DOMAIN` (`bongsu.example.com`) for Caddy.
- `SETUP_TOKEN`, `MEDIA_SIGNING_KEY`, `ENCRYPTION_KEY`: long random strings (`openssl rand -hex 32` each).
- `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` for push notifications (`npx web-push generate-vapid-keys`).
- Optional: `BONGSU_APP_NAME` and `BONGSU_THEME_COLOR` give the app your own name and colour, applied when the image is
  built ([configuration.md](configuration.md#branding)).
- `DRY_RUN=1` to start: every step runs and notifies, nothing is published.

## 2. Start

```sh
docker compose --profile https up -d --build
```

This builds the image from your checkout. To run a published release instead, set `BONGSU_IMAGE` in `.env` to
`ghcr.io/nyt87/bongsu:<version>` (`0.2`, `0.2.0` or `latest`, for amd64 and arm64), then:

```sh
docker compose pull bongsu
docker compose --profile https up -d
```

The published image has the default name and colours: branding (`BONGSU_APP_NAME`, `BONGSU_THEME_COLOR`) needs your
own build.

The first start creates the database (`bongsu-data` volume) and applies the migrations; every later start applies
new ones. Check `https://<DOMAIN>/health` (`ok: true`, no missing secrets): Docker's health check uses it too
(`docker compose ps` shows `healthy`).

Without the `https` profile, Bongsu listens on port 8787 (`BONGSU_PORT` to change it), for your own reverse proxy.

Then open `https://<DOMAIN>/dashboard` and sign up with the `SETUP_TOKEN`: you become the instance admin and create the
first workspace, and from there it's the same as on Cloudflare (Get started, OAuth apps, connections, devices).

## Postgres (optional)

By default the database is one SQLite file in the `bongsu-data` volume, which is plenty for one person's channels.
To use Postgres instead, the `postgres` profile runs one next to Bongsu:

```sh
# in .env: POSTGRES_PASSWORD=<a long random string>
#          DATABASE_URL=postgres://bongsu:<that password>@postgres:5432/bongsu
docker compose --profile https --profile postgres up -d --build
```

Or point `DATABASE_URL` at a Postgres you already run (any recent version; Bongsu creates its tables on first
start). [databases.md](../../docs/databases.md) compares the two and covers backups.

## Email (optional)

Connection alerts can also go by email ([configuration.md](configuration.md), `MAILER`). To see them without sending
real mail, the `mail` profile runs Mailpit, which catches every message:

```sh
# in .env: MAILER=smtp  SMTP_HOST=mailpit  SMTP_PORT=1025  MAIL_FROM=Bongsu <bongsu@example.com>
docker compose --profile https --profile mail up -d
```

Its web page is on `http://localhost:8025` (on the server only). For real email, point `SMTP_HOST`, `SMTP_PORT`,
`SMTP_USER` and `SMTP_PASS` at your provider, or use `MAILER=resend` with `RESEND_API_KEY`.

## Updating

`git pull && docker compose --profile https up -d --build`; with the published image, change `BONGSU_IMAGE` to the new
version (or keep `latest`) and run `docker compose pull bongsu && docker compose --profile https up -d`. Migrations run
at start. More in [Updating](updating.md).

## Backups

`docker compose exec bongsu node server.mjs backup /data/backup-$(date +%F).db` makes a consistent copy while Bongsu
runs; the media and restoring are in [Backups and restore](backups.md).

## Without Docker

Node 22 and pnpm (`corepack enable`):

```sh
pnpm install
pnpm --filter @bongsu/web build && pnpm --filter @bongsu/dashboard build && pnpm --filter @bongsu/node build
cd apps/node && set -a && . ../../.env && set +a && node dist/server.mjs
```

It reads the same settings from the environment, plus `DATABASE_PATH` (default `data/bongsu.db`) or `DATABASE_URL`
(Postgres), `PORT` (8787), `HOST`, `MIGRATIONS_DIR` and `WEB_DIR` (the repository's `migrations/` and
`packages/web/dist` by default), and `MEDIA_DIR` for the local store.
