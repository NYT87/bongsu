# Architecture

```
            phone app (PWA) ─┐                 ┌─ Instagram (via Composio)
  AI agents (REST /v1, /mcp) ┼─► bongsu ──┐    ├─ YouTube Data API (Shorts comments)
   Instagram fetching media ─┘  (Worker)  ├─ D1 ┤
                                          │    └─ Google Drive (media, inbox)
       cron trigger (every minute) ─► bongsu-cron
```

## Two Workers, one database

| Worker | Entry | Does |
|---|---|---|
| `bongsu` | `apps/cloudflare/src/index.ts` | `/app-api/*` (the owner's app, passkey session), `/v1/*` and `/mcp` (agents, API keys), `/m/*` (signed media links Instagram downloads from), `/icon/<hash>.png` (a workspace's icon, public, addressed by its content's hash), `/health`, and the app's static files |
| `bongsu-cron` | `apps/cloudflare/src/cron.ts` | the scheduled runs only, so each run starts a small bundle and stays inside the free plan's CPU limit |

Both use the same D1 database and the same secrets. The app is built from `packages/web/` into `packages/web/dist` and served by `bongsu`
as Workers assets.

## Cron runs

The cron Worker has one trigger, `* * * * *`; Node has one node-cron task at the same rate. Each minute both call
`runDue` (`packages/core/src/schedules.ts`), which starts the runs whose schedule matches that minute. A schedule is a
`CRON_*` variable or its default, parsed by core's own matcher (`packages/core/src/cron.ts`, five fields, UTC), so the
two runtimes can't drift.

| Run | Variable, default | Does |
|---|---|---|
| `instagram` | `CRON_INSTAGRAM`, `*/5 * * * *` | create jobs for due approved items, advance up to `JOBS_PER_TICK` jobs: 4 on Cloudflare, 20 on Node (`packages/core/src/tick.ts`) |
| `shorts` | `CRON_SHORTS`, `2,32 * * * *` | YouTube Shorts comments |
| `upkeep` | `CRON_UPKEEP`, `7,22,37,52 * * * *` | the steps of `UPKEEP_STEPS`, in order: inbox scan per workspace media folder (`INBOX_WORKSPACES_PER_RUN` workspaces at a time: 3 on Cloudflare, 20 on Node), moving posted media aside, daily digest, 24 h results, metrics, followers, new comments, connections, media stores |

- Runs due the same minute start side by side; each takes its own lock in the database, so two runs of one name never
  overlap. They share one invocation, so each gets `floor(limit / runs)` of a finite `RUN_SUBREQUESTS` (`runDue`) and
  records `shared: true` in `run_last:<name>`. A minute with nothing due makes no database call (Workers cap D1
  queries per invocation).
- Upkeep yields the minute (`upkeepDue`, from the expressions only, no state): it runs at minute M when it matches M
  and no tick is due at M; or when it matched M−1, a tick was due at M−1 and none is at M (it moved one minute, with
  the whole limit). When a tick is due both in its minute and the next, it runs in its own minute, sharing it. The
  dashboard's warning (`schedulerRuns`) follows the same rule: tick with tick on any shared minute, upkeep only when
  it can't move.
- `runDue` writes the schedules it used to the `schedules` settings row, and each run writes `run_last:<name>` (when,
  calls used, the limit, the steps stopped, a refused `RUN_SUBREQUESTS`, whether the limit was split): the `bongsu` Worker serves the dashboard and
  can't read the cron Worker's variables.
- The publishing runs' lock and deadline follow the run's shortest interval (`lockSeconds`); past the deadline a run
  starts no more jobs (uploads or others), so its work ends within the lock; the wait for Instagram's processing is a
  time (`MAX_POLL_S`, 2 h from the first poll), not a count of runs.
- An invalid `CRON_*`: Node refuses to start; Cloudflare logs it each minute and skips only that run.

### The run budget

`RUN_SUBREQUESTS` (50 on Cloudflare, `unlimited` on Node) bounds the `fetch` calls of one run
(`packages/core/src/budget.ts`, `runBudget(limit, fetcher)`). The run's `fetch` counts every call and refuses one
past the limit with `BudgetSpent` before sending it.

- `SUBREQUESTS_KEPT` (6) is the reserve for the end of a run (notes, the sweep): the tick's upload gate leaves it, and
  the upkeep steps' shares leave it out.
- Upkeep: `calls.step(name, keepForLater)` gives each step, when it starts, what is left less the reserve less one
  unit of work for each later step (`UPKEEP_UNIT_CALLS`, each step's `*_UNIT_CALLS`). Unused calls carry forward; the
  per-step caps still bound each step. A step checks `canAfford(n)` before each unit and stops cleanly; a
  `BudgetSpent` escaping it is logged like any step failure and the next step runs. The notifications (and mail) a
  step sends about its work go through `deps.noteFetch`, the run's own fetch, so they are paid from the reserve: a
  step that spent its share still tells the owner. The daily digest is the exception: its message is its work, paid
  from its share (`DIGEST_UNIT_CALLS`).
- The tick: a `BudgetSpent` leaves the job for the next run with no attempt counted; a Shorts comment refused this
  way is re-armed for the next Shorts run; the sweep waits for a run that didn't spend its calls and whose deadline
  hasn't passed.
- D1 queries are capped per invocation too and aren't counted here: the steps keep their own query bounds
  (`ACCOUNT_BACKFILL_PER_RUN`), and the cap is to be measured on the first real deployment (#58).

## How a Reel goes out

1. The plan item exists in D1 with its texts and Drive media.
2. The owner approves it in the app (passkey). The approval stores hashes of the texts and each media file's store, id
   and checksum ([media stores](media-stores.md)).
3. At the due time the tick creates a job. The first step checks the approval still matches.
4. It signs a short-lived link (`/m/<id>?exp=…&sig=…`) and asks Instagram to create a container from it.
   Instagram downloads the file through `bongsu`, which streams it from the media store (or, for a store with presigned
   URLs, straight from the store).
5. Later ticks poll the container, publish it, post the self-comment (and second comment), record the post, and notify.
6. If the account has Trial Reels on, the Reel's switch is on and the approval covered the copy (it records the switch), a
   trial copy job follows.

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
