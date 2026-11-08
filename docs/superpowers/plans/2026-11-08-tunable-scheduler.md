# Tunable Scheduler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run times (`CRON_*`) and a per-run call budget (`RUN_SUBREQUESTS`) set at deploy time, on both runtimes, shown read-only on the dashboard (#64).

**Architecture:** A dependency-free cron matcher in core decides each minute which named runs are due (`runDue`), fired by one every-minute trigger on Cloudflare and one every-minute node-cron task on Node. A counting `fetch` per run (`runBudget`) shares `RUN_SUBREQUESTS` among the upkeep steps by fair share with a hard stop. The cron side records its schedules and each run's use in settings rows, which the dashboard reads.

**Tech Stack:** TypeScript, Hono, Cloudflare Workers + D1, Node + node-cron + better-sqlite3, vitest (workers pool), React (dashboard).

**Spec:** `docs/superpowers/specs/2026-11-08-tunable-scheduler-design.md`

## Global Constraints

- Before exploring code, read the `.trail/learnings/` files about it (AGENTS.md). Find code with trail rather than broad grep/read: `T=/home/motoko/.nvm/versions/node/v24.21.0/bin/trail` (it runs on Node 24 by its own path; keep Node 22 on PATH for pnpm), then `$T ask "<task>" --source`, `$T grep "<literal>"`, `$T skeleton <file>`, and `$T callers <symbol> --depth all` before changing a symbol.

- Node 22: `export PATH=$HOME/.nvm/versions/node/v22.14.0/bin:$PATH` before every command.
- `core` and `api` stay runtime-independent: no Cloudflare or Node imports there.
- Portable SQL only (`ON CONFLICT … DO UPDATE`); `packages/core/test/portable-sql.test.ts` must stay green.
- No new dependency (the cron matcher is hand-written).
- Defaults keep today's behaviour: `CRON_INSTAGRAM` = `*/5 * * * *`, `CRON_SHORTS` = `2,32 * * * *`, `CRON_UPKEEP` = `7,22,37,52 * * * *`; `RUN_SUBREQUESTS` = 50 on Cloudflare, `unlimited` on Node; `SUBREQUESTS_KEPT` = 6.
- `RUN_SUBREQUESTS` accepts a whole number from 10 to 10,000,000, or `unlimited`.
- Lock: `lockS = clamp(gapS − 60, 60, 3540)`; upload deadline `min(UPLOAD_BUDGET_S, lockS − 60)`, at least 30 s; `MAX_POLL_S` = 7200.
- Tests: run focused files only, one at a time, `--maxWorkers=1`, in the foreground (the machine is short on RAM); CI runs the full suite. `pnpm check` and `pnpm typecheck` before each commit.
- Conventional Commits, lowercase subject ≤ 100 chars, body `Refs #64`, trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never `--no-verify`. Never push.
- No personal data: demo accounts and example.com only.

## Plan decisions (refining the spec; the owner is told at handoff)

- **P1 — the cron side records, the dashboard reads.** The `bongsu` Worker can't read the cron Worker's variables (today's Scheduler card already relies on what runs record). `runDue` writes the schedules it used to the settings row `schedules` (only when its JSON changed), and each run writes `run_last:<name>`. The dashboard API computes "next firing" from the recorded expressions with core's matcher.
- **P2 — due runs start side by side.** `runDue` starts every due run at once (`Promise.allSettled`), each still guarded by its own database lock, as the three triggers/tasks do today. Running them one after another would let a 4-minute tick hold up upkeep (and on Node, `noOverlap` would skip whole minutes). The Node every-minute task drops `noOverlap`.
- **P3 — the free plan's CPU.** Runs sharing a minute share one Cloudflare invocation's 10 ms CPU. The defaults never share a minute; the dashboard warns when configured runs do.

## Review Focus

1. **Two runs on the same minute** (e.g. `CRON_SHORTS=*/5 * * * *`): both run, neither blocks the other, and the dashboard warns (P2, P3) — Task 2 and Task 7 tests.
2. **Day of month and day of week both restricted** (`0 9 1 * 1`): fires on the 1st *and* on Mondays (the usual cron rule) — Task 1 test.
3. **A run every minute** (`* * * * *`): gap 60, lock 60 s, upload deadline 30 s; the tick still works and never overlaps itself — Task 3 test.
4. **`RUN_SUBREQUESTS=unlimited` or a huge number**: no `NaN`/`Infinity` leaks into shares, logs or the dashboard (shown as "unlimited") — Task 4 and Task 7 tests.
5. **An upgrade with a lock row named `inbox`** from the old code: the first `upkeep` run is not blocked by it — Task 2 test.

---

### Task 1: The cron matcher

**Files:**
- Create: `packages/core/src/cron.ts`
- Test: `packages/core/test/cron.test.ts`

**Interfaces:**
- Produces: `class CronError extends Error`; `interface Cron { expr: string }` (opaque fields inside); `parseCron(expr: string): Cron`; `matches(cron: Cron, at: Date): boolean`; `shortestGap(cron: Cron): number` (seconds, cached per expression); `nextFiring(cron: Cron, after: Date): Date` (first matching minute strictly after `after`, searching at most one year, else throws `CronError`).

- [ ] **Step 1: Write the failing tests** in `cron.test.ts`:
  - `matches` for each default: `*/5 * * * *` at 10:05 true, 10:06 false; `2,32 * * * *` at 10:32 true; `7,22,37,52 * * * *` at 10:52 true.
  - ranges and steps: `0-10/5 9-17 * * 1-5` matches Mon 09:10 UTC, not Sat 09:10, not Mon 18:00.
  - day rule: `0 9 1 * 1` matches 2026-12-01 09:00 (a Tuesday, the 1st) and 2026-12-07 09:00 (a Monday); not 2026-12-02 09:00.
  - `7` as Sunday: `0 0 * * 7` matches 2026-11-08 00:00 (a Sunday).
  - refused with `CronError` naming the field: `* * * *` (4 fields), `60 * * * *`, `*/0 * * * *`, `0 0 * * MON`, `@hourly`, `0 0 0 * * *` (6 fields).
  - `shortestGap`: `*/5 * * * *` → 300; `2,32 * * * *` → 1800; `7,22,37,52 * * * *` → 900; `* * * * *` → 60; `0 9 * * 1` → 604800.
  - `nextFiring(parseCron("*/5 * * * *"), 10:05:30)` → 10:10:00.
- [ ] **Step 2: Run** `pnpm --filter @bongsu/core exec vitest run test/cron.test.ts --maxWorkers=1` — expect FAIL (module missing).
- [ ] **Step 3: Implement `cron.ts`**: each field parsed to a sorted set of allowed values (minute 0–59, hour 0–23, dom 1–31, month 1–12, dow 0–6 with 7 → 0); remember whether dom/dow were `*`. `matches`: minute, hour, month must match; then if both dom and dow are restricted, either matching suffices, else each restricted one must match. `shortestGap`: walk 10,080 minutes from a fixed Monday 00:00 UTC, take the smallest difference between consecutive matches (including the wrap from the last to the first + one week); cache by `expr`.
- [ ] **Step 4: Run** the test file — expect PASS.
- [ ] **Step 5: Commit** `feat(core): a cron matcher for the scheduler`.

### Task 2: Named runs and `runDue` on both runtimes

**Files:**
- Modify: `packages/core/src/schedules.ts`, `packages/core/src/constants.ts` (CRON_INBOX → CRON_UPKEEP), `packages/core/src/env.ts`
- Modify: `apps/cloudflare/src/cron.ts`, `apps/cloudflare/wrangler.cron.toml`
- Modify: `apps/node/src/main.ts`, `apps/node/src/env.ts` (pass `CRON_*` through)
- Test: `apps/cloudflare/test/schedules.test.ts` (new), `apps/node/test/node.test.ts`

**Interfaces:**
- Consumes: Task 1's `parseCron`, `matches`, `shortestGap`, `CronError`.
- Produces:
  - `type RunName = "instagram" | "shorts" | "upkeep"`;
  - `interface Schedule { name: RunName; variable: "CRON_INSTAGRAM" | "CRON_SHORTS" | "CRON_UPKEEP"; expr: string; source: "default" | "variable"; gapS: number | null; error: string | null }`;
  - `schedules(env: Env): Schedule[]` (always the three, in order);
  - `runSchedule(env: Env, fetcher: typeof fetch, name: RunName, at: Date, gapS: number): Promise<void>`;
  - `runDue(env: Env, fetcher: typeof fetch, at: Date): Promise<RunName[]>` (the names it started);
  - `Env` fields `CRON_INSTAGRAM?`, `CRON_SHORTS?`, `CRON_UPKEEP?`, `RUN_SUBREQUESTS?: string`.
  - settings row `schedules`: JSON `Schedule[]`, written by `runDue` only in a minute where a run starts, and only when it differs from the stored value. A minute with nothing due makes no database call (Workers cap D1 queries per invocation; see the account-metrics learning).

- [ ] **Step 1: Write the failing tests** (`schedules.test.ts`, fake world):
  - with no variables, `runDue` at 10:05 starts `["instagram"]`, at 10:32 `["shorts"]`, at 10:52 `["upkeep"]`, at 10:01 `[]`.
  - `CRON_SHORTS="*/5 * * * *"`: at 10:05 starts both `instagram` and `shorts`; both complete (the tick's `tick_last:shorts` row is written).
  - `CRON_UPKEEP="0 3 * * *"`: upkeep runs at 03:00 only.
  - invalid `CRON_SHORTS="61 * * * *"`: `schedules()` has its `error`; `runDue` at 10:05 still starts `instagram`; nothing throws.
  - the `schedules` settings row is written on the first run and not rewritten when unchanged (count writes); a minute with nothing due makes no database call at all (wrap `env.DB` to count).
  - an old lock row `name='inbox'` held by another holder doesn't stop `upkeep` (Review Focus 5); the run's log prefix is `upkeep:`.
  - Node (`node.test.ts`): `main` with `CRON_SHORTS="bad"` exits with a message naming `CRON_SHORTS`; with defaults it registers exactly one task.
- [ ] **Step 2: Run** each test file alone — expect FAIL.
- [ ] **Step 3: Implement.** `schedules.ts`: `runSchedule` switches on `name` (upkeep body as today, lock name `upkeep`, logs `upkeep: …`); `runDue` rounds `at` down to the minute, records the row, starts every valid matching schedule with `Promise.allSettled` (P2), logs invalid ones (`schedule CRON_SHORTS: <message>`) and rejected runs. Cloudflare `cron.ts` `scheduled` → `runDue(env, realFetch, new Date(event.scheduledTime))`; `wrangler.cron.toml` `crons = ["* * * * *"]` with a comment naming the variables. Node `main.ts`: validate `schedules(env)` at startup, throw on any `error`; one `cron.schedule("* * * * *", …, { timezone: "UTC", name: "bongsu" })` without `noOverlap`, keeping the `running` set and shutdown.
- [ ] **Step 4: Run** `schedules.test.ts`, `node.test.ts`, and the existing tests that call `runSchedule` (`grep -l runSchedule apps/*/test`) — expect PASS.
- [ ] **Step 5: Commit** `feat(core,cloudflare,node): named runs fired each minute from cron variables`.

### Task 3: Timings follow the interval

**Files:**
- Modify: `packages/core/src/tick.ts` (lock at `acquire(…, 240)`, `runBudget` deadline, `pollWait` and `MAX_POLLS`), `packages/core/src/providers/youtube.ts` (`UPLOAD_BUDGET_S` comment), `packages/core/src/constants.ts` (`MAX_POLLS` → `MAX_POLL_S = 7200`; `JOBS_PER_TICK_MAX` comment)
- Test: `apps/cloudflare/test/tick.test.ts`, `apps/cloudflare/test/youtube-uploads.test.ts`

**Interfaces:**
- Consumes: Task 2's `runSchedule(…, gapS)` passing the run's gap.
- Produces: `Deps.intervalS?: number` (the run's gap; default 300, so direct `tick()` callers and tests keep today's behaviour); `lockSeconds(intervalS: number): number`; payload field `pollingSince?: number` (unix s of the first poll without progress).

- [ ] **Step 1: Write the failing tests:** `lockSeconds(300)` = 240, `(60)` = 60, `(120)` = 60, `(3600)` = 3540, `(86400)` = 3540; a tick with `intervalS: 60` holds its lock 60 s (a second tick 61 s later acquires it) and its upload deadline is 30 s; an Instagram container still processing after 2 h of polls (with `intervalS: 600`, 13 polls) fails with "never finished processing", and one at 1 h 50 min does not.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement:** `acquire(env.DB, lock, holder, nowS, lockSeconds(deps.intervalS ?? 300))`; the run deadline `min(UPLOAD_BUDGET_S, lockS − 60)` floored at 30; `pollWait` sets `pollingSince` on the first no-progress poll and fails when `nowS − pollingSince > MAX_POLL_S`; progress (`progressed`) clears `pollingSince`. `runSchedule` passes `intervalS: gapS` for the two ticks.
- [ ] **Step 4: Run** `tick.test.ts`, then `youtube-uploads.test.ts` — expect PASS.
- [ ] **Step 5: Commit** `feat(core): the tick's lock and the processing wait follow the interval`.

### Task 4: The run budget

**Files:**
- Create: `packages/core/src/budget.ts`
- Modify: `packages/core/src/constants.ts` (`RUN_SUBREQUESTS` = 50, `RUN_SUBREQUESTS_MIN` = 10, `RUN_SUBREQUESTS_MAX` = 10_000_000; keep `SUBREQUESTS_KEPT` = 6; remove `SUBREQUESTS_PER_RUN` in Task 5), `apps/node/src/env.ts` (`RUN_SUBREQUESTS: vars.RUN_SUBREQUESTS ?? "unlimited"`)
- Test: `packages/core/test/budget.test.ts`

**Interfaces:**
- Produces:
  - `class BudgetSpent extends Error` (message names the step);
  - `runSubrequests(env: Pick<Env, "RUN_SUBREQUESTS">): { value: number; source: "default" | "variable"; invalid: string | null }` (`Infinity` for `unlimited`);
  - `interface StepBudget { name: string; fetch: typeof fetch; left(): number; canAfford(n: number): boolean; used(): number }`;
  - `interface RunCalls { fetch: typeof fetch; used(): number; left(): number; limit: number; step(name: string, stepsLeft: number): StepBudget; stopped(): string[] }`;
  - `runBudget(limit: number, fetcher: typeof fetch): RunCalls` (reserve `SUBREQUESTS_KEPT` held back from shares; `left()` is the run's total left, reserve included).

- [ ] **Step 1: Write the failing tests:** `runSubrequests` — unset → 50 default; `"200"` → 200 variable; `"unlimited"` → Infinity; `"5"`, `"abc"`, `"20000000"` → 50 with `invalid` set (the bad value). `runBudget(50, f)`: `step("a", 3)` share 14 (`floor((50−6)/3)`); after "a" uses 4, `step("b", 2)` share 20; a step's `fetch` past its share throws `BudgetSpent` without calling `f`; `canAfford(n)` agrees with what `fetch` allows; a step that hit its share is listed in `stopped()`; the run's `fetch` (outside steps) counts too; `runBudget(Infinity, f)`: shares `Infinity`, `left()` `Infinity`, no throw after 1,000 calls.
- [ ] **Step 2: Run** `pnpm --filter @bongsu/core exec vitest run test/budget.test.ts --maxWorkers=1` — expect FAIL.
- [ ] **Step 3: Implement `budget.ts`** to the interfaces above (a step that throws `BudgetSpent` or answers `canAfford` false records itself in `stopped()`).
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Commit** `feat(core): a per-run call budget shared by fair share`.

### Task 5: The tick uses the run budget

**Files:**
- Modify: `packages/core/src/tick.ts` (`runBudget(deps)` → core's `runBudget(runSubrequests(env).value, deps.fetch)`; `RunBudget.requestsLeft` reads its `left()` minus the reserve), `packages/core/src/constants.ts` (remove `SUBREQUESTS_PER_RUN`)
- Test: `apps/cloudflare/test/youtube-uploads.test.ts`, `apps/cloudflare/test/tick.test.ts`

**Interfaces:**
- Consumes: Task 4's `runBudget`, `runSubrequests`, `BudgetSpent`.
- Produces: settings row `run_last:instagram` / `run_last:shorts`: `{ at, used, limit, stopped: [] }` (alongside today's `tick_last:*`, which stays for `jobsPerTick`).

- [ ] **Step 1: Write the failing tests:** with `RUN_SUBREQUESTS=200`, chunk mode sends more pieces in one run than with the default (today's 50-request ceiling test keeps passing at the default); a `BudgetSpent` thrown inside a job's step leaves the job as it was with `attempts` unchanged and the next job is not started; `run_last:instagram` records `used` equal to the world's counted calls.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** as in Files; in `advance`'s catch, `BudgetSpent` → leave the job, stop the loop (like the upload gate).
- [ ] **Step 4: Run** `youtube-uploads.test.ts`, `youtube-client.test.ts`, `tick.test.ts` one at a time — expect PASS.
- [ ] **Step 5: Commit** `feat(core): the tick spends the run budget`.

### Task 6: Upkeep shares the budget

**Files:**
- Modify: `packages/core/src/schedules.ts` (upkeep loop), and each step to check its share per unit: `inbox.ts` (`scanInbox`: per workspace), `cleanup.ts` (`cleanMedia`: per move), `results.ts` (`postResults`: per post), `metrics.ts` (`sampleMetrics`: per post and per list refresh), `account-metrics.ts` (`sampleAccounts`: per account), `comments.ts` (`pollComments`: per video), `providers/refresh.ts` (`refreshConnections`: per connection), `media/manage.ts` (`checkStores`: per store); `digest.ts` only receives the step's fetch.
- Test: `apps/cloudflare/test/upkeep-budget.test.ts` (new)

**Interfaces:**
- Consumes: Task 4's `RunCalls`, `StepBudget`, `BudgetSpent`.
- Produces: each step's `deps` gains `budget?: StepBudget` (absent in existing direct callers and tests: no limit); each step defines `const <STEP>_UNIT_CALLS = n` — the most calls one unit makes, read from the step's code — and checks `deps.budget?.canAfford(<STEP>_UNIT_CALLS) ?? true` before a unit; settings row `run_last:upkeep`: `{ at, used, limit, stopped: string[] }`.

- [ ] **Step 1: Write the failing tests** (fake world, many workspaces, posts and accounts seeded so every step has more work than fits): with `RUN_SUBREQUESTS=50`, one upkeep run makes at most 50 calls (counted on the world's fetch); every step still runs (each logs a result or a stop); a step that ignores its share (a test double replacing `pollComments` with one that loops on `deps.fetch`) is stopped by `BudgetSpent`, logged as `comments failed: …`, and `connections` and `media stores` still run; with `RUN_SUBREQUESTS=unlimited` the per-step caps (`METRICS_PER_RUN` = 4, `ACCOUNTS_PER_RUN` = 4) still bound the work; `run_last:upkeep.stopped` lists the steps that stopped on their share.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement:** the upkeep loop builds `runBudget(runSubrequests(env).value, fetcher)`, and for step *i* of 9 passes `{ fetch: s.fetch, now, budget: s }` with `s = calls.step(name, 9 − i)`; each step's unit check as in Interfaces; write `run_last:upkeep` in the `finally`.
- [ ] **Step 4: Run** `upkeep-budget.test.ts`, then each touched step's existing test file (`inbox`, `media-stores`, `metrics`, `account-metrics`, `comments`, `results`, `connect`, `cleanup` as they exist) one at a time — expect PASS.
- [ ] **Step 5: Commit** `feat(core): upkeep steps share the run budget`.

### Task 7: The dashboard's Scheduler card

**Files:**
- Modify: `packages/api/src/dashboard/routes.ts` (`/admin-api/scheduler`), `packages/dashboard/src/pages.tsx` (`SchedulerInfo`, `RUN_NAME` `inbox` → `upkeep: "Upkeep: inbox, results, metrics, comments, connections"`, `SchedulerCard`)
- Test: `apps/cloudflare/test/dashboard.test.ts`, `apps/cloudflare/test/workspaces.test.ts`

**Interfaces:**
- Consumes: the `schedules` and `run_last:<name>` rows (Tasks 2, 5, 6), Task 1's `nextFiring`, Task 4's `runSubrequests` shape.
- Produces: `/admin-api/scheduler` answers `{ runs: { name, expr, variable, source, error, next: string | null (UTC ISO), shared: RunName[] }[] | null (null until the cron side recorded), limits: { runSubrequests: { value: number | "unlimited", source, invalid } | null, jobsPerTick, inboxWorkspacesPerRun }, last: Record<RunName, { at, used, limit: number | "unlimited", stopped: string[] } | null>, schedulesOff }`. `shared` lists the other runs that fire on the same minute within the next week (P3).

- [ ] **Step 1: Write the failing tests:** with recorded rows, the endpoint returns the three runs with `next` from `nextFiring`, `source`, and an invalid one's `error`; `CRON_SHORTS="*/5 * * * *"` recorded → `instagram.shared` = `["shorts"]`; `unlimited` serialises as `"unlimited"` (Review Focus 4); before any record, `runs` is `null`; a workspace admin who isn't an instance admin gets 403 (`workspaces.test.ts`).
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** the endpoint; the card lists runs (expression, next firing in the viewer's zone via the dashboard's existing `when`, variable and default/set, red error, a "shares a minute with …: on Workers free they share one invocation's CPU" warning), the limits, and each run's last use (`used` of `limit`, stopped steps). The `runSubrequests` limit is the one the cron side records in `run_last:*`.
- [ ] **Step 4: Run** `dashboard.test.ts`, `workspaces.test.ts`; `pnpm --filter @bongsu/dashboard build` — expect PASS.
- [ ] **Step 5: Commit** `feat(api,dashboard): the scheduler card shows run times, budget and last use`.

### Task 8: Docs, wording, changeset, plan

**Files:**
- Modify: `site/docs/deploy-cloudflare.md`, `site/docs/configuration.md` (variables table; line ~151), `site/docs/faq.md` (~35: the 2 h wait), the Docker/Node guide in `site/docs/`, `docs/architecture.md`, `docs/PLAN.md` (a ticked #64 line under Phase 13), `apps/cloudflare/wrangler.cron.toml` comments
- Create: `.changeset/tunable-scheduler.md` (`@bongsu/core`, `@bongsu/api`, `@bongsu/dashboard`: minor)

- [ ] **Step 1:** Write the docs per the spec's "Docs and release": the three `CRON_*` variables with defaults, the 1-trigger setup and the 5-triggers-per-account note, `RUN_SUBREQUESTS` (50 free; 10000 paid default, up to 10 million with the Worker's `limits`; `unlimited` on Node), the CPU note for runs sharing a minute (P3), invalid schedules stopping Node's startup, the renamed `upkeep` run, and the D1 open item for #58. Replace "every 5 minutes" for the publishing run with "at each Instagram run (every 5 minutes by default, `CRON_INSTAGRAM`)".
- [ ] **Step 2:** The changeset says what self-hosters see: one cron trigger after the next deploy, `upkeep` in logs, the new variables.
- [ ] **Step 3: Run** `pnpm check`, `pnpm --filter … docs` build if one exists (`node scripts/build-docs.mjs` per `package.json`), `pnpm check-personal` — expect clean.
- [ ] **Step 4: Commit** `docs(docs): the scheduler's run times and budget`.
