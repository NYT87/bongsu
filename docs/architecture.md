# Architecture

```
            phone app (PWA) ─┐                 ┌─ Instagram (via Composio)
  AI agents (REST /v1, /mcp) ┼─► bongsu ──┐    ├─ YouTube Data API (Shorts comments)
   Instagram fetching media ─┘  (Worker)  ├─ D1 ┤
                                          │    └─ Google Drive (media, inbox)
                   cron triggers ─► bongsu-cron
```

## Two Workers, one database

| Worker | Entry | Does |
|---|---|---|
| `bongsu` | `apps/cloudflare/src/index.ts` | `/app-api/*` (the owner's app, passkey session), `/v1/*` and `/mcp` (agents, API keys), `/m/*` (signed media links Instagram downloads from), `/health`, and the app's static files |
| `bongsu-cron` | `apps/cloudflare/src/cron.ts` | the scheduled runs only, so each run starts a small bundle and stays inside the free plan's CPU limit |

Both use the same D1 database and the same secrets. The app is built from `packages/web/` into `packages/web/dist` and served by `bongsu`
as Workers assets.

## Cron runs

| Schedule | Run |
|---|---|
| `*/5 * * * *` | Instagram: create jobs for due approved items, advance up to `JOBS_PER_TICK` jobs: 4 on Cloudflare, 20 on Node (`packages/core/src/tick.ts`) |
| `2,32 * * * *` | YouTube Shorts comments |
| `7,22,37,52 * * * *` | Drive inbox scan, moving posted media aside, daily digest, 24 h results, new comments |

Each run takes a lock in the database, so two runs never overlap.

## How a Reel goes out

1. The plan item exists in D1 with its texts and Drive media.
2. The owner approves it in the app (passkey). The approval stores hashes of the texts and each media file's store, id
   and checksum ([media stores](media-stores.md)).
3. At the due time the tick creates a job. The first step checks the approval still matches.
4. It signs a short-lived link (`/m/<id>?exp=…&sig=…`) and asks Instagram to create a container from it.
   Instagram downloads the file through `bongsu`, which streams it from the media store (or, for a store with presigned
   URLs, straight from the store).
5. Later ticks poll the container, publish it, post the self-comment (and second comment), record the post, and notify.
6. If the account has Trial Reels on and the Reel's switch is on, a trial copy job follows.

## Database

The schema is written once in `packages/schema` and generated per database (`migrations/sqlite/`, `migrations/postgres/`; every table in [schema.md](schema.md)). Plan data carries a `workspace_id`; times are UTC unix seconds (zones only apply
when showing and entering them). The main tables:

| Area | Tables |
|---|---|
| Workspaces | `workspaces`, `workspace_settings` (time zone, digest hour), `users` (own time zone), `memberships` |
| Accounts | `accounts`, `connections` |
| Plan | `plan_items`, `approvals`, `posted`, `trial_posts` |
| Scheduler | `jobs`, `locks`, `settings`, `audit` |
| Drafts and inbox | `drafts`, `inbox_seen`, `media_cleanup` (keyed by store and file id) |
| Shorts | `shorts_comments`, `shorts_commented` |
| Owner and agents | `passkeys`, `sessions`, `challenges`, `setup_codes`, `api_keys` (agent keys and CLI tokens), `rate_limits`, `push_subs` |
| Results | `post_metrics` (the series), `account_metrics`, `post_results`, `comments`, `comment_polls`, `snapshots` (imported; they backfill `account_metrics` once) |

The database is the only source of the plan and its texts; nothing is read from a repository at publish time.
