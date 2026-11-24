# Tunable scheduler: when each run happens and how much it does (#64)

Status: design approved in conversation (2026-11-08); this spec awaits the owner's review.

## Goal

An instance admin fits the scheduler to their hosting (Workers free: 50 subrequests and 10 ms CPU per invocation;
Workers paid: 10,000 subrequests by default; Node: no such limit) **at deploy time**, never from the dashboard. Success:

- any cron expression runs the right job on both runtimes;
- timings that depend on the interval follow it;
- one budget number sets how much a run does, and a run never goes over it;
- the dashboard shows all of it, read-only, to instance admins.

A deployment that sets no new variable behaves as today.

## Decisions

| # | Decision | Why |
|---|---|---|
| D1 | All of #64 in one spec and one pull request; the plan builds part A (when) before part B (how much) | The dashboard section and the docs would otherwise change twice |
| D2 | The cron Worker has **one** trigger, `* * * * *`; core decides each minute which runs are due | One source of truth for both runtimes; any expression works without touching triggers; 1 of the free plan's 5 cron triggers per account instead of 3 (LADN shares the account, #58) |
| D3 | One per-run budget, `RUN_SUBREQUESTS`, counted on the real `fetch` calls, shared out **in order, keeping one unit of work for each later step**, with carry-over and a hard stop (amended during the build: was "fair share") | Counts what Cloudflare counts instead of estimating; the inbox keeps today's room, no step can starve the rest or overshoot |
| D4 | Set at deploy time only; the dashboard displays, never edits | The values belong to the hosting plan, and a wrong one fails runs quietly (decided in Phase 13 part 3a) |

## Part A: when runs happen

### Named runs and variables

| Run | Variable | Default (UTC) | Does |
|---|---|---|---|
| `instagram` | `CRON_INSTAGRAM` | `*/5 * * * *` | `tick(…, "instagram")`: publish what's due |
| `shorts` | `CRON_SHORTS` | `2,32 * * * *` | `tick(…, "shorts")`: first comments on YouTube Shorts |
| `upkeep` | `CRON_UPKEEP` | `7,22,37,52 * * * *` | inbox scan, cleanup, digest, results, metrics, followers, comments, connections, media stores |

- The run today called "inbox" is renamed **`upkeep`**: in `runSchedule`'s successor, the logs (`upkeep: …`), its lock
  name (`upkeep`, was `inbox`) and the docs. The old `inbox` lock row expires on its own (600 s).
- The `CRON_INSTAGRAM` / `CRON_SHORTS` / `CRON_INBOX` constants in `constants.ts` become the defaults of the new
  variables (`CRON_INBOX` → `CRON_UPKEEP`).
- `Env` gains `CRON_INSTAGRAM?`, `CRON_SHORTS?`, `CRON_UPKEEP?`, `RUN_SUBREQUESTS?` (strings, like the other vars).

### The cron matcher (`packages/core/src/cron.ts`, new)

A small, dependency-free parser and matcher for standard 5-field cron in UTC: minute, hour, day of month, month,
day of week (0–6, 0 = Sunday; 7 accepted as Sunday). Each field takes `*`, numbers, ranges `a-b`, lists `a,b`, and steps
`*/n` / `a-b/n`. Day of month and day of week follow the usual rule: when both are restricted, either matching is
enough. No names (`MON`, `JAN`), no `@hourly` macros, no seconds field: refused with a clear message.

- `parseCron(expr): Cron` throws `CronError` (message names the field) on anything else.
- `matches(cron, at: Date): boolean` for the minute `at` falls in.
- `shortestGap(cron): number` (seconds): the smallest interval between two consecutive firings, found by walking one
  week of minutes (10,080 checks, done once per expression and cached). A run that fires every minute has a gap of 60.

### Firing: `runDue` (replaces `runSchedule`'s entry)

`packages/core/src/schedules.ts` exports:

- `schedules(env): { name, expr, cron, gapS, source: "default" | "variable" }[]`, or each entry with an `error` when
  its variable doesn't parse.
- `runDue(env, fetch, at)`: for the minute `at` (rounded down), starts every valid schedule that matches it **side by
  side** (each still guarded by its own database lock, as the separate triggers are today), so a 4-minute tick never
  holds up upkeep. A run's failure is logged and doesn't stop the others. It also records the schedules it used in the
  settings row `schedules` (only in a minute where a run starts, and only when changed): the `bongsu` Worker, which serves the dashboard, can't read
  the cron Worker's variables. Runs that share a minute share one Cloudflare invocation's 10 ms CPU on the free plan
  and its calls: with more than one run due and a finite limit, each gets `floor(RUN_SUBREQUESTS / runs due)`, passed
  through `runSchedule` to the tick's budget and to `runUpkeep`, and records that limit (amended after the final
  review: each used to get the whole limit), with `shared: true` in its `run_last` row. Upkeep yields the minute
  (amended in the second final fix wave): it is due at M when it matches M and no tick is due at M, or when it
  matched M−1, a tick was due at M−1 and none is at M; when a tick is due in both its minute and the next, it runs in
  its own minute and shares it. Decided from the expressions only, so idle minutes still make no database call. The
  defaults never share a minute, and the dashboard warns when configured runs do ("they share one invocation's CPU
  and its calls"): ticks sharing any minute, upkeep only when it can't move.
  An invalid variable is logged each minute (`schedule CRON_SHORTS: <reason>`) and only that run is skipped.
- `runSchedule(env, fetch, name, at, gapS, subrequests?)` stays as the per-run entry (by **name**, not expression), used by `runDue` and
  by tests.

Runtimes:

- **Cloudflare:** `wrangler.cron.toml` `[triggers] crons = ["* * * * *"]`; `cron.ts` `scheduled()` calls
  `runDue(env, realFetch, new Date(event.scheduledTime))` and ignores `event.cron`.
- **Node:** `main.ts` validates every schedule at startup and **refuses to start** on an invalid one (the message names
  the variable); then one node-cron task `* * * * *` (UTC, without `noOverlap`: the runs' own locks prevent overlap)
  calls `runDue`. `SCHEDULES=off` still
  schedules nothing. Graceful shutdown is unchanged.

Cost on Cloudflare: about 1,440 invocations a day, most of which only match three expressions and return. Each matching
run then works as today.

### Timings that follow the interval

- **The tick's lock** (`tick.ts`, today a fixed 240 s for a 5-minute tick): `lockS = clamp(gapS − 60, 60, 3540)`, so
  the lock always frees a minute before the next tick. Every 5 minutes keeps 240 s; every 2 minutes gets 60 s; hourly
  gets 3,540 s. The upload's run budget (`UPLOAD_BUDGET_S`, 180 s) stays
  under the lock: `min(UPLOAD_BUDGET_S, lockS − 60)`, at least 30 s.
- **Waiting on Instagram** (`MAX_POLLS` = 24 ticks of 5 minutes): becomes a time, `MAX_POLL_S = 2 h`; a job gives up
  when it has waited longer than that (its first poll's time is kept in the payload), whatever the interval.
- **`JOBS_PER_TICK_MAX`** (100, "a tick holds its lock for 4 minutes"): unchanged; its comment now refers to the lock.
- **Wording:** where the app, the notifications and the docs say "every 5 minutes" / "within one tick" of the
  publishing run, they state the configured interval (from `schedules()`), e.g. `site/docs/configuration.md:151`,
  `site/docs/faq.md:35`. Other "15 minutes" mentions (codes, sessions) are unrelated and stay.

## Part B: how much a run does

### The variable

`RUN_SUBREQUESTS`: the outgoing calls (`fetch`) one run may make.

- Cloudflare default **50** (free plan). A paid plan sets e.g. `10000` (Cloudflare's paid default; it can be raised to
  10 million with the Worker's `limits` setting).
- Accepted: a whole number from 10 to 10,000,000, or `unlimited`. Anything else falls back to the runtime default and
  is reported (log + dashboard).
- Node's default (`apps/node/src/env.ts`) is `unlimited`, given as `RUN_SUBREQUESTS_DEFAULT`, so an invalid value
  there falls back to `unlimited` (still recorded as `invalid`), not to Cloudflare's 50 (amended after the final
  review).

### The run budget (`packages/core/src/budget.ts`, new)

Generalises the tick's counter (`RunBudget` in `tick.ts`):

- `runBudget(limit, fetcher)` → `{ fetch, used(), left(), limit, step(name, keepForLater), stopped() }` (the limit
  comes from `runSubrequests(env)`). Its `fetch` counts every call.
- **Reserve:** `SUBREQUESTS_KEPT` (6) is held back for what a run does at its end (notifications, the sweep).
- **In order, a unit kept for each later step** (amended during the build; the first draft's fair share,
  `floor((left() − reserve) / stepsLeft)`, gave the inbox 4 calls at 50 instead of today's ~30):
  `step(name, keepForLater)` returns a `StepBudget` whose share is `left() − reserve − keepForLater`, where
  `keepForLater` is the sum of the later steps' one unit of work each (`UPKEEP_UNIT_CALLS`, each step's
  `<STEP>_UNIT_CALLS`). Whatever a step leaves unused stays in `left()` for the steps after it; per-step caps still
  bound each step. The notifications (and mail) a step sends about its work are paid from the reserve, through the
  run's own fetch (`StepDeps.noteFetch`), so a step that spent its share still tells the owner (amended after the
  final review: upkeep used to leave the reserve unspent while its steps' notes were refused); the digest's message is
  its work, paid from its share.
- **`StepBudget`:** `{ fetch, left(), canAfford(n) }`. Its `fetch` refuses a call past the step's share by throwing
  `BudgetSpent` before sending anything, so a step that forgets to check still can't overshoot.
- `unlimited`: shares are `Infinity`; the existing per-step caps alone bound the work.

### The tick

- The tick's run budget comes from `runBudget`; `SUBREQUESTS_PER_RUN` (constant 50) is removed.
- The upload gate (`UPLOAD_REQUESTS` = 4 left) and chunk mode's "stop before a piece when fewer than 2 remain" read
  `left()` as today.
- `JOBS_PER_TICK` stays the cap on the jobs a tick advances (and `NODE_JOBS_PER_TICK` Node's default).
- A `BudgetSpent` inside a job is handled like the budget gate today: the job is left for the next run, no attempt
  counted.

### Upkeep

The steps run in today's order: inbox, cleanup, digest, results, metrics, accounts, comments, connections, media stores.
Each gets `calls.step(name, keepForLater)` and its `StepBudget.fetch` instead of the run's `fetch`.

- Each step checks `canAfford(n)` before each unit of work (a workspace's inbox and its store reads, a post's metrics,
  an account's followers, a connection's refresh, a store's check) and stops cleanly when it can't; its next run picks
  up where it left off, as each step already does with its caps.
- A `BudgetSpent` escaping a step is caught like any step failure today (`<step> failed: …`), and the run goes on.
- The per-step constants stay **only as upper bounds** (`METRICS_PER_RUN`, `METRICS_ATTEMPTS_PER_RUN`,
  `METRICS_REFRESH_PER_RUN`, `ACCOUNTS_PER_RUN`, `ACCOUNTS_ATTEMPTS_PER_RUN`, the inbox's `ITEMS_PER_RUN`), so a large
  budget doesn't sample everything at once. `INBOX_WORKSPACES_PER_RUN` stays an optional cap (variable, clamped).
- Database-only work (`ACCOUNT_BACKFILL_PER_RUN`, cleanup's moves that are store calls aside) keeps its own bounds.

### Open item

Workers also cap **D1 queries per invocation**, separately from subrequests: a learning
(`.trail/learnings/2026-11-02-phase-9-part-2b-the-account-nyt87.md`) records a long backfill exhausting it and
starving the later upkeep steps. The budget here counts `fetch` calls only, as the code does today; steps keep their
own query bounds (e.g. `ACCOUNT_BACKFILL_PER_RUN`). The first real deployment (#58) measures the query cap; a query
budget would be a follow-up. Because of it, `runDue` makes **no database call in a minute where no run is due**.

## Dashboard (instance admins, read-only)

The existing **Scheduler** card (`packages/dashboard/src/pages.tsx`, `SchedulerCard`, `/admin-api/scheduler`) shows,
from what the cron side recorded (the `schedules` and `run_last:<name>` rows; "next firing" computed with core's
matcher):

- **Runs:** name, expression, next firing in the viewer's zone, the variable that sets it and whether it is the
  default or set; an invalid one in red with its variable and the parser's message.
- **Limits in effect:** `RUN_SUBREQUESTS` (or "unlimited"), `JOBS_PER_TICK`, `INBOX_WORKSPACES_PER_RUN`: the value the
  latest run used (for `RUN_SUBREQUESTS`, the latest run whose limit wasn't split; if every recorded run shared,
  the latest, marked shared), with a refused `RUN_SUBREQUESTS` flagged (amended during the build: no "default/set", since the
  cron side doesn't record where a limit came from: Node's default comes from `RUN_SUBREQUESTS_DEFAULT`, not from
  `RUN_SUBREQUESTS`, but `run_last` keeps only the value used; the docs name each variable and its default).
- **Last run of each:** when, calls used of the budget, and the steps that stopped on their share. Each run overwrites
  one settings row (`run_last:<name>`, JSON); no history accumulates. Replaces today's "last inbox run".

Only instance admins reach it (as today); `apps/cloudflare/test/workspaces.test.ts` keeps checking that.

## Errors

| Case | Behaviour |
|---|---|
| Invalid `CRON_*` | Node: refuses to start, naming the variable. Cloudflare: logged each minute, that run skipped, the others run; dashboard shows it |
| Invalid `RUN_SUBREQUESTS` | The runtime's default (50 on Cloudflare, `unlimited` on Node), flagged on the dashboard |
| Invalid `JOBS_PER_TICK` / `INBOX_WORKSPACES_PER_RUN` | Not a whole number from 1: the core default (4 / 3, on Node too); above the max: clamped. Not flagged: the dashboard shows the value used |
| A step over its share | `BudgetSpent`, logged, the run continues; the step resumes next run |
| Two runs due the same minute | Ticks: started side by side in one invocation, each under its own lock and with an equal part of a finite `RUN_SUBREQUESTS`; the dashboard warns (shared CPU and calls). Upkeep: moves to the next minute when that one is free of ticks, else shares its own |
| The old `inbox` lock | Ignored; expires within 600 s |

## Tests

Unit (`packages/core/test`): the matcher (fields, ranges, lists, steps, day-of-month/day-of-week rule, invalid input,
`shortestGap`); the budget (shares in order with a unit kept for later steps, carry-over, reserve, `BudgetSpent` on overshoot, `unlimited`, clamping).

Integration (`apps/cloudflare/test`, fake world):

- `runDue` runs the right run for custom expressions, starts same-minute runs side by side, and skips only an invalid one.
- The tick's lock and the Instagram wait follow the interval.
- Upkeep never exceeds `RUN_SUBREQUESTS` (counted on the world's fetch), shares carry over, and a step that ignores its
  share is stopped by `BudgetSpent` while the next steps still run.
- The Scheduler endpoint returns the runs, limits and last runs; admins only (`workspaces.test.ts`).

Node (`apps/node/test`): an invalid `CRON_*` refuses to start; the every-minute task calls `runDue`.

## Docs and release

- `site/docs/deploy-cloudflare.md`: one trigger; the `CRON_*` and `RUN_SUBREQUESTS` variables, with the free/paid
  values; the 5-triggers-per-account note.
- `site/docs/configuration.md`: the new variables in the table; line 151's "every 5 minutes" states the interval.
- Docker / Node guide: the same variables; invalid schedules stop startup.
- `site/docs/faq.md`: the Instagram wait as 2 h, whatever the interval.
- `docs/architecture.md`: runs by name, `runDue`, the budget.
- A changeset: self-hosters see the trigger list change on their next deploy and the run renamed `upkeep` in logs.
- `docs/PLAN.md` has no line for #64 yet: add one under Phase 13 (where it was decided), ticked when done.

## Out of scope

- Editing any of this from the dashboard.
- Per-workspace schedules or budgets.
- Counting D1 queries (see the open item).
