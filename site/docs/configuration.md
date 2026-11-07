# Configuration

## Accounts and connections (database)

Accounts (the Instagram profiles and YouTube channels Bongsu publishes to) and connections (how it reaches each
platform) live in the database, per workspace. The dashboard doesn't manage every kind yet; add
them with SQL (`pnpm exec wrangler d1 execute bongsu --remote --command "…"` in `apps/cloudflare`):

```sql
-- An Instagram account posted through Instagram's own API, its token in a secret named IG_TOKEN_TRAVEL
-- (site/docs/instagram-graph.md: creating the Meta app and getting the token)
INSERT INTO connections (id, workspace_id, provider, kind, secret_name, created_at, updated_at)
  VALUES ('ig_travel', 'default', 'instagram', 'oauth', 'IG_TOKEN_TRAVEL', unixepoch(), unixepoch());
INSERT INTO accounts (id, workspace_id, platform, handle, external_id, connection_id, capabilities, created_at, updated_at)
  VALUES ('demo_travel', 'default', 'instagram', 'demo_travel', '<Instagram user id>', 'ig_travel',
          '{"trialReels": true}', unixepoch(), unixepoch());

-- Or through Composio
INSERT INTO connections (id, workspace_id, provider, kind, external_ref, created_at, updated_at)
  VALUES ('c_travel', 'default', 'composio', 'composio', '<Composio connected-account id>', unixepoch(), unixepoch());
INSERT INTO accounts (id, workspace_id, platform, handle, external_id, connection_id, capabilities, created_at, updated_at)
  VALUES ('demo_running', 'default', 'instagram', 'demo_running', '<Instagram user id>', 'c_travel',
          '{}', unixepoch(), unixepoch());

-- A YouTube channel for Shorts comments, its OAuth JSON kept in a secret named YT_MAIN_OAUTH
INSERT INTO connections (id, workspace_id, provider, kind, secret_name, created_at, updated_at)
  VALUES ('c_main', 'default', 'youtube', 'oauth', 'YT_MAIN_OAUTH', unixepoch(), unixepoch());
INSERT INTO accounts (id, workspace_id, platform, handle, display_name, connection_id, created_at, updated_at)
  VALUES ('main', 'default', 'youtube', 'main', 'Main channel', 'c_main', unixepoch(), unixepoch());
```

| Column | Meaning |
|---|---|
| `accounts.id` | the account's key in the plan (`plan_items.account`, `shorts_comments.channel`); for Instagram, use the username |
| `accounts.external_id` | the Instagram user id / the YouTube channel id |
| `accounts.capabilities` | what the platform allows, e.g. `{"trialReels": true}` (Instagram requires a follower minimum for Trial Reels) |
| `accounts.settings` | the owner's choices, e.g. the Trial Reels default (set in the dashboard's Accounts page) |
| `accounts.status` | `active` or `disabled` (disabled accounts get nothing published) |
| `connections.provider` | `instagram` (Instagram's own API, [instagram-graph.md](instagram-graph.md)), `composio`, `youtube` |
| `connections.external_ref` | the Composio connected-account id |
| `connections.secret_name` | the secret holding the credentials (Instagram: the token; YouTube: `{client_id, client_secret, refresh_token, token_uri}`) |
| `connections.credentials` | or the credentials themselves, encrypted with `ENCRYPTION_KEY` (what the dashboard's Connect stores, and where renewed Instagram tokens go) |
| `connections.status` | `ok`, `expiring` (a renewal failed) or `broken` (nothing is posted with it) |

An Instagram account without a working connection and user id is skipped: nothing is queued for it.

### Caption rules

The caption check (`packages/core/src/formats/caption-lint.ts`) judges every caption against its platform's rules:
Instagram's are a cap of 5 hashtags (a FAIL blocks approval), a first line that fits before the feed's fold at about
125 characters, and two language-bound heuristics (a concrete hook, one call to action) written for English, Spanish
and Korean. An admin can change them per account in the dashboard's Accounts page, under **Caption checks**:
`Hashtags max` (0–30), `First line chars` (50–500) and the `Language checks` switch. The values live in
`accounts.settings.captionRules`, e.g. `{"hashtagMax": 10, "languageChecks": false}`; a missing field means the
platform's default, and a field of the wrong type is ignored. `POST /admin-api/accounts/:id` with `captionRules`
changes only the fields sent (`null` puts one back to the default). The PWA, the CLI's `approve` and the agent API all
show the same checks.

## Branding

One instance is one brand. The app's name and theme colour are read by the browser before anyone signs in (the install
name, the tab title, the manifest, the browser bar), so they are inputs to the app build, not database settings.
Nothing else changes: the design, the accent and the dashboard keep Bongsu's.

| Variable | Default | What |
|---|---|---|
| `BONGSU_APP_NAME` | `Bongsu` | Install name, `<title>`, manifest `name`/`short_name`, the sign-in title and the Android hint. At most 40 characters |
| `BONGSU_THEME_COLOR` | `#131f2a` | Manifest `theme_color` and `background_color`, and the `theme-color` meta. `#rrggbb`; anything else falls back to the default |

The icons are the seven files in `packages/web/public`: `favicon.svg`, `favicon.ico`, `icon-192.png`, `icon-512.png`,
`icon-maskable-192.png`, `icon-maskable-512.png` and `apple-touch-icon.png`. `pnpm brand` makes all of them from one
square SVG of your mark, so a fork rebrands in three steps:

1. Set `BONGSU_APP_NAME` and `BONGSU_THEME_COLOR` (below, for Cloudflare or Docker).
2. Make the icons: `BONGSU_APP_NAME="Lighthouse" BONGSU_THEME_COLOR="#112233" pnpm brand your-mark.svg` (from a
   subfolder, `pnpm -w brand`). The mark goes on the theme colour, inside the maskable icons' safe zone, and is used
   at tab sizes too. It needs Python 3 and the Cairo library (`libcairo2` on Debian and Ubuntu, `brew install cairo` on
   macOS); the Python packages install once into a cache folder, not the repository. Commit the seven files.
3. Build the app (or the Docker image) with the same two variables.

The app's build checks the seven files and stops with the name of any one that is missing or at the wrong size, so a
forgotten file can't ship a broken install icon. You can also replace them by hand, same names and sizes (keep the mark
inside the central 80% of the maskable ones).

The project site (`site/`, `pnpm site`) takes its brand files from `BRAND_DIR` (default `docs/assets/brand`): `mark.svg`,
`mark-small.svg`, `lockup.svg`, `social-card.png`, `apple-touch-icon-180.png` and `favicon.ico`.

What stays Bongsu's: the design's colours (`tokens.css`), which carry meaning (green means approved and running), and the
dashboard's mark.

- **Cloudflare:** set the variables in the environment of the app build:
  `BONGSU_APP_NAME="Lighthouse" BONGSU_THEME_COLOR="#112233" pnpm --filter @bongsu/web build` (or `pnpm build`), and
  also in CI's variables if CI deploys.
- **Docker:** put both in `.env` (`docker compose` passes them as build arguments), or
  `docker build --build-arg BONGSU_APP_NAME="Lighthouse" --build-arg BONGSU_THEME_COLOR="#112233" .`; rebuild the image to apply.

## Variables (wrangler files)

| Name | Meaning |
|---|---|
| `DRY_RUN` | `"1"`: log and notify instead of publishing. `"0"`: live |
| `PUBLIC_URL` | the `bongsu` Worker's URL (signed media links, notification links) |
| `RP_ID` | passkey relying-party id: the app's hostname |
| `VAPID_PUBLIC_KEY`, `VAPID_SUBJECT` | Web Push |
| `JOBS_PER_TICK` | optional, on the cron Worker: publishing jobs advanced per run (default `4`, at most `100`). See [How many go out at once](#how-many-go-out-at-once) |
| `YOUTUBE_UPLOAD_MODE` | optional, on the cron Worker: `"chunk"` sends YouTube uploads in 8 MiB pieces instead of streaming the file in one request. Leave it unset unless YouTube answers the upload with 400 or 411, or an upload fails on the CPU limit: watch the first real upload (see [YouTube](youtube.md#uploads-on-cloudflare)) |
| `INBOX_WORKSPACES_PER_RUN` | optional, on the cron Worker: workspaces whose inbox folder one run scans (default `3`, at most `100`); the next run carries on with the following ones. Set at deploy time, never in the dashboard |

## Secrets

Set on both Workers with `wrangler secret put` (never in the wrangler files).

| Secret | Required | What |
|---|---|---|
| `COMPOSIO_CONSUMER_KEY` | for Composio connections | Composio consumer key ([instagram-composio.md](instagram-composio.md)) |
| `MEDIA_SIGNING_KEY` | yes | random string; signs the media links Instagram downloads (`openssl rand -hex 32`) |
| `ENCRYPTION_KEY` | to connect from the dashboard and to set up a media store | a long random string (`openssl rand -hex 32`) that encrypts the OAuth apps' secrets, the media stores' keys and grants, and the credentials kept in the database |
| `SETUP_TOKEN` | to sign up (web Worker only) | a long random string; the first person signs up in the dashboard with it, once |
| YouTube OAuth secrets (any name, e.g. `YT_MAIN_OAUTH`) | no (channels connected without the dashboard) | JSON `{client_id, client_secret, refresh_token, token_uri}`, named by the channel's connection (`secret_name`) |
| `VAPID_PRIVATE_KEY` | for push | the private half of the VAPID pair |
| `RESEND_API_KEY` | with `MAILER = "resend"` | a [Resend](https://resend.com) API key: connection alerts are also emailed to the workspace's admins. Set `MAILER = "resend"` and `MAIL_FROM` (a sender on a domain verified in Resend, e.g. `Bongsu <bongsu@example.com>`) as `[vars]` in the cron Worker's wrangler file |

`/health` lists missing secrets by name: the ones every instance needs, plus those its connections and media stores
need. It also lists the media stores and their status, and isn't `ok` until at least one is set up and none is broken.

The media stores themselves (Google Drive, an S3-compatible bucket, the server's disk) aren't configured here: they're
set up in the dashboard's **Media** page and kept in the database, their keys and grants encrypted with
`ENCRYPTION_KEY` ([Google Drive](drive.md), [S3-compatible buckets](s3.md)).

## On Node and Docker

The same names, from the environment (`.env` with docker-compose; [self-hosting.md](self-hosting.md)), plus:

| Name | Default | Meaning |
|---|---|---|
| `MEDIA_DIR` | `/media` in Docker | a directory this server offers as a media store ("This server's disk" on the dashboard's Media page; the `bongsu-media` volume), streamed through the signed `/m/` links. Unset: not offered |
| `MAILER` | none | `smtp` (Node only) or `resend` |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | port 587 | the SMTP relay for `MAILER=smtp` (Mailpit in the compose file's `mail` profile: `mailpit`, `1025`) |
| `MAIL_FROM` | | the sender, e.g. `Bongsu <bongsu@example.com>` |
| `DATABASE_PATH` | `/data/bongsu.db` in Docker | the SQLite file |
| `DATABASE_URL` | none | `postgres://user:password@host:5432/db`: Postgres instead of the SQLite file ([databases.md](../../docs/databases.md)) |
| `SCHEDULES` | on | `off`: serve only, run no schedules (no publishing, no polling of comments or the inbox): for a replica or a demo |
| `PORT`, `HOST` | `8787`, `0.0.0.0` | where it listens |
| `MIGRATIONS_DIR`, `WEB_DIR` | set in the image | the folder holding `sqlite/` and `postgres/` migrations, and the built app |
| `RP_ID` | `PUBLIC_URL`'s host | the passkeys' relying party |
| `JOBS_PER_TICK` | `20` | publishing jobs advanced per run, at most `100` ([How many go out at once](#how-many-go-out-at-once)) |
| `INBOX_WORKSPACES_PER_RUN` | `20` | workspaces whose inbox folder one run scans, at most `100` |

## How many go out at once

Every 5 minutes the scheduler advances at most `JOBS_PER_TICK` publishing jobs, all accounts and workspaces together,
the oldest due first. A video takes a few runs (Instagram processes it, then Bongsu publishes it) and holds its place
until it's out, so items due at the same minute beyond that number go out over the next runs. Nothing is dropped,
but a job more than 6 hours late waits for you instead (`CATCH_UP_S`).

- **Cloudflare: 4.** Each job costs a few subrequests and the free plan allows 50 per invocation. On the paid plan
  (1,000 subrequests) you can raise it: set `JOBS_PER_TICK` in `[vars]` of `wrangler.cron.toml`, the Worker that runs
  the schedules.
- **Node and Docker: 20.** No such limit there; set `JOBS_PER_TICK` in `.env` to change it.

Bongsu has no limit of its own per account. Instagram allows 100 posts per account per 24 hours through the API
([Instagram](instagram-graph.md#limits)); YouTube releases scheduled videos itself, so any number go public together.

## The media stores' layout

The same in every store: a Drive's top folders, a bucket's key prefixes (under its folder, if it has one), the
server's media directory.

| Path | Use |
|---|---|
| `<folder>/<project>/…` | media of plan items (looked up in the workspace's default store) |
| `<folder>/inbox/<project>/` | drop files here to get drafts (every store's inbox is read) |
| `<folder>/_posted/` | posted media is moved here, in the store it's in |
| `<folder>/_uploads/` | files uploaded from the app, in the store picked for the upload |

`<folder>` is the workspace's media folder: a name made from the workspace's name (`UPLOADS` for a workspace kept from
before this release), editable by its admins in Settings → Media. Bongsu never moves files when it changes.

## Tunable limits (`packages/core/src/constants.ts`)

| Constant | Default | Meaning |
|---|---|---|
| `CATCH_UP_S` | 6 h | a job later than this waits for the owner |
| `MAX_POLLS` | 24 | ticks to wait for an Instagram container |
| `LINK_TTL_S` | 6 h | lifetime of a signed media link |
| `JOBS_PER_TICK` | 4 | the default jobs advanced per run on Cloudflare (free plan: 50 subrequests per invocation); Node's is `NODE_JOBS_PER_TICK` (20), and the `JOBS_PER_TICK` variable overrides both, up to `JOBS_PER_TICK_MAX` (100) |
| `AUDIT_KEEP_S` | 180 days | audit log retention |
| `METRICS_DENSE_S` | 6 h | time between a post's results samples while it is young… |
| `METRICS_DENSE_UNTIL_S` | 3 days | …until this age |
| `METRICS_DAILY_S` | 24 h | then a sample this often… |
| `METRICS_DAILY_UNTIL_S` | 30 days | …until this age |
| `METRICS_WEEKLY_S` | 7 days | then a sample this often… |
| `METRICS_STOP_S` | 90 days | …until this age; after it no more samples |
| `METRICS_PER_RUN` | 4 | samples taken per inbox cron run, oldest due first |
| `METRICS_ATTEMPTS_PER_RUN` | 8 | samples tried per run, failures included (a failed post waits one interval; an account's first failure ends its turn for the run) |
| `METRICS_REFRESH_PER_RUN` | 2 | YouTube upload lists the sampler refreshes per run once an hour old, the oldest first |
| `ACCOUNT_METRICS_S` | 24 h | how often each account's follower count is sampled |
| `ACCOUNTS_PER_RUN` | 4 | accounts sampled per inbox run at most |
| `ACCOUNTS_ATTEMPTS_PER_RUN` | 8 | accounts tried per run, failures included (a failing account waits 6 hours) |
| `ACCOUNT_BACKFILL_PER_RUN` | 200 | snapshot samples the one-time backfill adds per run (a long history takes a few runs) |
| `METRICS_MAX_POINTS` | 400 | points a metrics read answers at most (the newest) |

They are constants, not environment variables: change one and redeploy.

## Time zones and digest

The database stores every time in UTC (unix seconds: `plan_items.due_at`, `approvals.due_at`, `posted.published_at`,
`jobs.due_at`). Time zones only apply when a person or an agent enters or reads a time:

- **The workspace's zone** (an IANA name such as `Asia/Seoul` or `Europe/Madrid`) is the default for everyone in it,
  and the zone of its agent keys, notifications and daily digest. The digest goes out once a day from the workspace's
  digest hour.
- **A user's own zone** (`users.timezone`, NULL = the workspace's) changes only what that user sees and enters in the
  app: Settings → **Time zone**. Nothing planned moves when either zone changes.

"18:00" entered in a zone with daylight saving is 18:00 on that day's clock, before or after the change. A new instance
starts on `UTC` at 08:00; change the workspace's zone with SQL until the dashboard has a setting:

```sql
UPDATE workspace_settings SET timezone = 'Europe/Madrid', digest_hour = 8, updated_at = unixepoch()
  WHERE workspace_id = 'default';
```
