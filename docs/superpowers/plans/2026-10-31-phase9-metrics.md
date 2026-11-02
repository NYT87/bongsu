# Phase 9 part 1 (metrics series, sampler, charts, Results view) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `post_metrics` time series sampled by the cron run on a decaying schedule for Instagram posts and YouTube uploads, read as totals or daily differences, charted in the app, with a published item's page split into Results and Post and the 24 h notification opening Results.

**Architecture:** One core module (`metrics.ts`) owns the schedule rule, the sampler and the pure series math; the 24 h result becomes a sample plus a marker; a shared op (`itemMetrics`) serves the app now and the agent API later; the app gets an SVG chart component and a segmented Results/Post view.

**Tech Stack:** TypeScript, the neutral schema (`packages/schema`, generated SQL for SQLite and Postgres), Hono, React, vitest (core unit; Cloudflare integration with the fake world), Biome.

**Spec:** `docs/superpowers/specs/2026-10-31-phase9-metrics-design.md`

## Global Constraints

- Portable SQL only (the subset SQLite and Postgres share; the `post_results` column drop is a `sql` step per dialect); every query filters by workspace except the sampler's own run, which tags each row with its item's workspace; times stored as unix seconds, answered as `due`/`due_at` and `at` (ISO UTC) with dates on the caller's clock.
- One source of truth: lifetime counts stored once per sample; daily values computed on read; the 24 h numbers read from the series (`nearest24h`); `post_results` holds only `median_views` and `fetched_at` after the migration.
- The schedule: 6 h for 3 days, daily to day 30, weekly to day 90, then none; `METRICS_PER_RUN = 4`; constants only (no env overrides).
- `core` and `api` runtime-independent; demo data only; approval untouched; the notification wording unchanged except its target.
- The chart: inline SVG, no library; series hues from new `--series-*` tokens, never channel or status colours; a label and a marker shape per series; a readout reachable by tap and keyboard; `prefers-reduced-motion` respected; both themes; 44 px targets.
- Conventional Commits with `Refs #137` / `#136` / `#86` (subjects start lowercase); a changeset; hooks never skipped.
- Before the last commit: `pnpm check && pnpm typecheck && pnpm test` (Cloudflare `--testTimeout 120000 --maxWorkers=2`), `pnpm --filter @bongsu/schema generate` leaves no diff, `pnpm --filter @bongsu/web build`, `pnpm --filter @bongsu/dashboard build`, `pnpm site`.

## Review Focus

1. A post published 3 days and 1 hour ago whose last sample was 7 hours ago: due (the daily band starts at 3 days; 24 h not yet elapsed since the last sample → NOT due). State the exact rule and test both sides of each band edge. Test in Task 2.
2. Daily mode on a series with samples on days 1, 2 and 4: day 3 is `null`, day 4 is the difference from day 2's last sample, not 0 and not from day 3. Test in Task 2.
3. The 24 h fetch on a post that already has a sample from 20 minutes ago (the sampler got there first): no second insights call, no duplicate row, the notification reads that sample. Test in Task 3.
4. A YouTube upload of workspace B must not be sampled under workspace A's account, and `GET /app-api/video/metrics` for it answers 404 to workspace A's user. Test in Task 4 and `workspaces.test.ts`.
5. The item page of a published Reel whose Trial Reel copy has no samples yet shows the Reel's chart with one series and the trial section saying it has no results, not an empty second series or a crash. Check in Task 6 (a fixture in the route test: trial row without samples).

---

### Task 1: The migration (#137)

**Files:**
- Create: `packages/schema/src/migrations/0011_post_metrics.ts`
- Modify: `packages/schema/src/migrations/index.ts` (register it), `migrations/sqlite/0011_post_metrics.sql` and `migrations/postgres/0011_post_metrics.sql` (generated), `docs/schema.md` (generated), `packages/core/src/data.ts` or wherever `post_results` columns are read (grep `post_results`: `results.ts`, `pwa/routes.ts`, `agent/ops.ts` `item`, `cli` export, `performance.ts`?) — only the type/column lists that would break the typecheck; behaviour moves in Tasks 3 and 4
- Test: `packages/schema/test` (the existing migration tests: find how 0010 is covered, e.g. a conformance run applying every migration on SQLite and PGlite) and `packages/core/test/portable-sql.test.ts`

**Interfaces:**
- Produces: table `post_metrics` with columns `id` (serial, primary key), `item_key` text not null, `account` text not null, `platform` text not null, `media_id` text not null, `taken_at` timestamp not null, `views`, `reach`, `likes`, `comments`, `saves`, `shares` int nullable, `workspace_id` text not null default `'default'`; indexes `post_metrics_item (item_key, taken_at)`, `post_metrics_ws (workspace_id, taken_at)`. `post_results` without `views, reach, likes, comments, saves, shares`.
- The `sql` step: Postgres `ALTER TABLE post_results DROP COLUMN views, DROP COLUMN reach, …`; SQLite: `CREATE TABLE post_results_new (…six kept columns…); INSERT INTO post_results_new SELECT item_key, account, media_id, median_views, fetched_at, workspace_id FROM post_results; DROP TABLE post_results; ALTER TABLE post_results_new RENAME TO post_results;` with `apply` updating the neutral tables (delete the six columns).

- [ ] **Step 1: Write the failing test**: in the schema package's migration test, assert that after all migrations `post_metrics` exists with the columns above (query `tables()` or the dialect's catalog as the existing tests do) and `post_results` has no `views` column; on both SQLite and PGlite.
- [ ] **Step 2: Run** `pnpm --filter @bongsu/schema test`. Expected: FAIL.
- [ ] **Step 3: Implement** the migration; `pnpm --filter @bongsu/schema generate`; fix the typecheck fallout (types that list the dropped columns) minimally: the readers switch to the series in Tasks 3-4, so for now the item route's `results` query selects only the kept columns and returns `views…` as `null` (a temporary state inside this branch).
- [ ] **Step 4: Run** the schema tests, `pnpm typecheck`, the core `portable-sql.test.ts`, and `git status` shows the generated files changed. Expected: PASS.
- [ ] **Step 5: Commit** `feat(schema): post_metrics series; post_results keeps the marker and the median` (`Refs #137`).

### Task 2: The schedule rule and the series math (#137)

**Files:**
- Create: `packages/core/src/metrics.ts` (the pure part only), `packages/core/test/metrics.test.ts`
- Modify: `packages/core/src/constants.ts`

**Interfaces:**
- Produces: constants `METRICS_DENSE_S = 6 * 3600`, `METRICS_DENSE_UNTIL_S = 3 * 86400`, `METRICS_DAILY_S = 86400`, `METRICS_DAILY_UNTIL_S = 30 * 86400`, `METRICS_WEEKLY_S = 7 * 86400`, `METRICS_STOP_S = 90 * 86400`, `METRICS_PER_RUN = 4` (each with a one-line why). `export const METRICS = ["views", "reach", "likes", "comments", "saved", "shares"] as const` (the Instagram insight names; `saved` maps to the `saves` column). `export interface Sample { at: number; views: number | null; reach: number | null; likes: number | null; comments: number | null; saves: number | null; shares: number | null }`. `export function sampleInterval(ageS: number): number | null` (6 h / 24 h / 7 d / null by the bands; the band edges inclusive at the lower bound: age ≥ 3 d is daily). `export function nextSampleAt(publishedAt: number, lastAt: number | null, nowS: number): number | null` (null = never again; `publishedAt` when no sample; else `lastAt + sampleInterval(nowS - publishedAt)`). `export function isDue(publishedAt, lastAt, nowS): boolean` (`nextSampleAt !== null && nextSampleAt <= nowS`). `export function series(rows: Sample[], o: { daily: boolean; tz: string }): Sample[]` (total: sorted by `at`; daily: last sample per day on `tz`, consecutive-day differences, a metric `null` when either day lacks a value or the previous day had no sample; the first day has no previous → omitted). `export function nearest24h(rows: Sample[], publishedAt: number): Sample | null` (closest to `publishedAt + 86400` within ±6 h, else the latest, else null).

- [ ] **Step 1: Write the failing tests** `metrics.test.ts`: `sampleInterval(0) === 21600`, `(3*86400 - 1) === 21600`, `(3*86400) === 86400`, `(30*86400) === 604800`, `(90*86400) === null`; `isDue(p, null, p + 10)` true; `isDue(p, p + 5*3600, p + 5*3600 + 3600)` false (Review Focus 1: 6 h not elapsed); `isDue(p, p + 3*86400 - 7*3600, p + 3*86400 + 3600)` false (daily band, 8 h since last) and true at `+ 24 h`; `series` daily with samples at day 1 (views 10), day 2 (30), day 4 (70) in `Asia/Seoul` → points for days 2, 3 and 4: day 2 = 20, day 3 = `null` (no sample that day), day 4 = `null` (no sample the day before: a two-day difference would mislead); total mode unaffected (Review Focus 2); `nearest24h` picks the sample at +23 h over +30 h; falls back to the latest when none within ±6 h; `null` on empty.
- [ ] **Step 2: Run** `pnpm --filter @bongsu/core test`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** the pure functions and constants.
- [ ] **Step 4: Run** the core tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): the metrics schedule rule and the series math` (`Refs #137`).

### Task 3: The sampler and the 24 h result on the series (#137, #86)

**Files:**
- Modify: `packages/core/src/metrics.ts` (add `sampleMetrics`), `packages/core/src/results.ts` (write the sample, read it for the lines, keep the marker), `packages/core/src/schedules.ts` (`["metrics", sampleMetrics]` after results), `packages/core/src/clients/youtube.ts` (`statistics(ids)`), `packages/core/src/providers/youtube.ts` (expose `statistics`), `packages/core/src/calendar.ts` (export `channelUploads` already; a helper `publicUploads(env, fetcher, account)` if useful), `apps/cloudflare/test/world.ts` (insights values that grow per call: a counter per media id; a `videos.list` `part=statistics` handler returning `statistics: { viewCount, likeCount, commentCount }` per id, growing per call)
- Test: `apps/cloudflare/test/metrics.test.ts` (new), `apps/cloudflare/test/phase11.test.ts` or wherever `postResults` is tested (grep `24 h results`): keep passing

**Interfaces:**
- Consumes: Task 1's table; Task 2's rule and `METRICS`.
- Produces: `sampleMetrics(env: Env, deps: { fetch; now: Date }): Promise<{ sampled: string[] }>`: candidates = Instagram `posted` ∪ `trial_posts` (non-story, `media_id` not null, published ≤ 90 d ago) with `MAX(taken_at)` from `post_metrics` per key, plus for each YouTube account the cached public uploads (`channelUploads(env, fetcher, account)`, `privacy === "public"`, `when` ≤ 90 d ago) keyed `video:<id>`; those `isDue`, ordered by `nextSampleAt`, the first `METRICS_PER_RUN`; Instagram through `providerFor(...).results(media_id, METRICS)`; YouTube grouped per channel through `YouTube.statistics(ids)`; a row per sample; a failing provider logs and skips (tried next run). `YouTube.statistics(ids: string[]): Promise<Map<string, { views: number | null; likes: number | null; comments: number | null }>>` (`videos.list?part=statistics&id=…`, 50 per call). `postResults` change: before fetching, `SELECT … FROM post_metrics WHERE item_key = ?1 AND taken_at >= ?2` (now − 3600): if a row exists, use it; else fetch and insert a sample; then insert the `post_results` marker `(item_key, account, media_id, median_views, fetched_at, workspace_id)`; the lines use the sample's numbers.

- [ ] **Step 1: Write the failing tests** `metrics.test.ts` (seed a published Reel via `seedReel` + the fake's posting flow or a direct `posted` row with `media_id`, and a YouTube channel with `ytUploads` incl. a public one): `it("samples a fresh post, not again 5 h later, again 6 h later")` (run `sampleMetrics` at t0, t0+5h, t0+6h with `deps.now`; rows 1, 1, 2; views grow between rows); `it("samples daily after 3 days")`; `it("samples a channel's public uploads with one videos.list per channel")` (count the fake's calls; rows for `video:<id>`, platform youtube); `it("the 24 h result reuses a sample taken within the hour and writes the marker")` (Review Focus 3: insights called once); `it("tags rows with the item's workspace")` (a workspace-B account's post → `workspace_id = 'b'`); `it("takes at most METRICS_PER_RUN per run, oldest due first")`.
- [ ] **Step 2: Run** the file. Expected: FAIL.
- [ ] **Step 3: Implement** the sampler, the client method, the fake handlers, the results change and the schedule hook.
- [ ] **Step 4: Run** `metrics.test.ts`, the results tests (grep `postResults` in apps/cloudflare/test), `pnpm --filter @bongsu/core test`, `pnpm check`, `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): sample post metrics on a decaying schedule; the 24 h result is a sample` (`Refs #137, #86`).

### Task 4: The metrics op and routes (#137)

**Files:**
- Modify: `packages/api/src/agent/ops.ts` (`itemMetrics`, `videoMetrics`), `packages/api/src/pwa/routes.ts` (`/app-api/item/metrics`, `/app-api/video/metrics`; `/app-api/item`'s `results` and `trial.results` from `nearest24h` + the marker), `packages/api/src/agent/ops.ts` `item()` (its `results` field likewise), `packages/cli` export if it carried results (grep)
- Test: `apps/cloudflare/test/metrics.test.ts`, `apps/cloudflare/test/workspaces.test.ts`, `apps/cloudflare/test/app.test.ts` (the item route's `results`)

**Interfaces:**
- Consumes: Task 2's `series`, `nearest24h`; Task 3's rows.
- Produces: `ops.itemMetrics(c: OpCtx, o: { key: string; daily?: boolean; from?: string; to?: string }): Promise<{ item: { key, platform, account, label, published_at, due, due_at }, samples: Sample[], trial?: { samples: Sample[] } }>` (404 `ApiError` when the item isn't the caller's; `from`/`to` as `YYYY-MM-DD` on the caller's clock, inclusive; cap 400 newest); `ops.videoMetrics(c, { video, daily, from, to })` → `{ item: { key: "video:<id>", platform: "youtube", account, label: "Short" | "Video", published_at, … }, samples }` (404 unless a channel of the workspace has the upload in its cache); the two `/app-api` routes call them with the signed-in caller; `/app-api/item`'s `results` = `{ ...nearest24h(samples), median_views, fetched_at }` or `null` when no marker and no samples.

- [ ] **Step 1: Write the failing tests**: `metrics.test.ts`: the item route returns `samples` sorted by `at`, `daily=1` returns differences, `from`/`to` filter, the cap (seed 450 rows → 400); the item route's `results.views` equals the nearest-24 h sample; a Trial Reel's `trial.samples`; the video route for a public upload; `workspaces.test.ts`: another workspace's item → 404, workspace B's video → 404 for A (Review Focus 4); `app.test.ts`'s existing `results` assertions updated to the series.
- [ ] **Step 2: Run**. Expected: FAIL.
- [ ] **Step 3: Implement.** **Step 4: Run** the three files, `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): an item's and a video's metrics series; the 24 h numbers read from it` (`Refs #137`).

### Task 5: The chart component (#137)

**Files:**
- Create: `packages/web/src/Chart.tsx`
- Modify: `packages/web/src/tokens.css` (`--series-1…5` light and dark), `packages/web/src/styles.css` (`.chart`, the legend, the readout, the toggle), `packages/web/DESIGN.md` (a "Charts" component section and the tokens in "Colors")
- Test: none automated (no component tests in the repo): `pnpm --filter @bongsu/web typecheck && build`, and a Storybook-free check: a temporary `#/chart-demo` route is NOT added; instead the implementer renders it in Task 6 and the screenshot pipeline captures it.

**Interfaces:**
- Produces: `export function LineChart({ series, mode, tz, height = 180 }: { series: { label: string; hue: 1|2|3|4|5; points: { at: number; value: number | null }[] }[]; mode: "total" | "daily"; tz: string; height?: number })`: an SVG with x as time (ticks at day boundaries on `tz`, labelled "Oct 30" style, at most 6), y with 3-4 ticks (tabular, formatted with `k` above 10,000), a path per series (gaps where a point is `null`), a small marker per point with a shape per hue (circle, square, diamond, triangle, cross), a legend (`label` with its marker), a readout: tapping/clicking the chart or pressing left/right while it's focused selects the nearest point and shows "Oct 30 · Views 1,234" under the chart (`aria-live="polite"`); `role="img"` + `aria-label` ("Views, 12 points, from Oct 20 to Oct 30, latest 1,234"); a visually hidden `<table>` of the values; `@media (prefers-reduced-motion: reduce)` disables the path transition. `export function ChartToggle` isn't needed: the Results view uses the existing `segmented` control for Total | Daily and the metric picker.

- [ ] **Step 1: Write** the component and styles per the interface; the typecheck is the first gate.
- [ ] **Step 2: Run** `pnpm --filter @bongsu/web typecheck && pnpm --filter @bongsu/web build`. Expected: PASS.
- [ ] **Step 3: Commit** `feat(web): an SVG line chart with a legend, a readout and series tokens` (`Refs #137`).

### Task 6: The Results view, the video page, the notification target (#136, #137)

**Files:**
- Modify: `packages/web/src/App.tsx` (`ItemPage`: the segmented control, the `ResultsView`, the route `#/item/<key>/results`; `VideoPage`: Results | Video when samples exist; `ResultsLine` reused for the numbers), `packages/web/src/api.ts` (`Metrics` types), `packages/web/src/i18n.ts` (the new chrome labels: "Results", "Post", "Video", "Total", "Daily", the empty text), `packages/core/src/notify.ts` (`actionsFor`: `reel:`/`post:` targets from the results notification → `/#/item/<key>/results`; `trial:<key>` → its Reel's results), `packages/core/src/texts/notifications.ts` (`postResults` passes `results:<key>` as the target; `actionsFor` maps `results:<key>` and `trial:<key>` to `/#/item/<key>/results` with the label "Open results"), `scripts/screenshots/screens.json` + `seed.mjs` (a `results` screen: the posted item's Results view; the seed gives the posted Reel a dozen samples), `packages/web/DESIGN.md` ("Item page": the Results | Post split), `packages/web/PRODUCT.md`
- Test: `apps/cloudflare/test/metrics.test.ts` (the notification target), `packages/core/test/notifications.test.ts` (the `results` builder's target)

**Interfaces:**
- Consumes: Task 4's routes; Task 5's `LineChart`.
- Produces: `#/item/<key>/results` and `#/item/<key>` routes; `ResultsView({ keyId, item })`: the numbers block (`ResultsLine` for the Reel, and for the trial with "×the regular Reel"), the mode and metric `segmented` controls, `LineChart` with the Reel's series (and the trial's as series 2 when it has samples; when the trial exists without samples, a line "Trial Reel: no results yet"), the empty state; `VideoPage` with the split when `/app-api/video/metrics` has samples; `actionsFor("results:reel:a/b")` → `{ label: "Open results", url: "/#/item/reel%3Aa%2Fb/results" }`, `actionsFor("trial:reel:a/b")` → the same URL.

- [ ] **Step 1: Write the failing tests**: `notifications.test.ts`: `results(["…"], "results:reel:a/b").target === "results:reel:a/b"`; `metrics.test.ts`: after `postResults` for a Reel and for its Trial Reel copy, `w.notifications[0].actions` contains the results URL for both (the trial's maps to the Reel's).
- [ ] **Step 2: Run**. Expected: FAIL.
- [ ] **Step 3: Implement** the app views, the targets, the i18n keys, the screenshot seed and screen; `pnpm --filter @bongsu/web typecheck && build`; `pnpm screenshots` once (`sg docker`) and look at `site/docs/assets/app/results-light.png` (the chart renders with two series and a readout) — Review Focus 5: also seed a trial row without samples for `approvedKey`'s page or a second item and read its page in the demo (`--keep`, curl the route; the app's branch is read by eye in the screenshot if captured).
- [ ] **Step 4: Run** the two test files, `pnpm test:site`, `pnpm check`, `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web,core): the Results view with charts; the 24 h notification opens it` (`Refs #136, #137`).

### Task 7: Docs, plan, changeset, full check

**Files:** Modify `site/docs/how-it-works.md` (Results and comments), `site/docs/the-app.md` (Results view), `site/docs/youtube.md` (Quota), `site/docs/configuration.md` (the schedule), `docs/PLAN.md` (tick #136, #137; #86's note), `.changeset/metrics-series.md` (`@bongsu/core`, `@bongsu/api`, `@bongsu/web`, `@bongsu/schema` minor).

- [ ] **Step 1: Write** them. **Step 2: Full verification** per the Global Constraints (incl. `pnpm --filter @bongsu/schema generate` leaving no diff and `pnpm site`). **Step 3: Commit** `docs(docs): tick Phase 9 part 1: the metrics series and the Results view` (`Refs #136, #137, #86`).
