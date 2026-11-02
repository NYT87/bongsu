# Phase 9 part 2a: followers brought by a post or video — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `post_metrics` carries the followers a post or video brought (Instagram `follows`/`profile_visits`, YouTube `subscribersGained`), shown on Results and in the 24 h notification.

**Architecture:** Two columns on the series; the Instagram insights call asks for the follow metrics with a one-retry fallback; a YouTube Analytics client call per channel per run, gated on a stored OAuth scope; the app reads the new fields through the existing routes, plus an `analytics` flag on the video metrics answer.

**Tech Stack:** TypeScript, the neutral schema generator, Hono, React, vitest with the fake world.

**Spec:** `docs/superpowers/specs/2026-11-01-phase9-followers-design.md`

## Global Constraints

- Portable SQL only (`ALTER TABLE … ADD COLUMN`; no SQLite-only functions); timestamps from the app.
- Every new row and read keeps the workspace rules of part 1 (rows tagged from the account; routes filter by `c.caller.workspaceId`).
- `core`/`api` runtime-independent; approval untouched; the notification wording unchanged except the appended followers part.
- Strings in the app through `t()` (`packages/web/src/i18n.ts`, `en` only).
- Exact copy: the Results line part ` · +12 followers · 85 profile visits` (Instagram), ` · +12 subscribers` (YouTube); the reconnect line "Subscribers gained: not available until the channel is reconnected with analytics (dashboard → Connections)."
- The Analytics scope `https://www.googleapis.com/auth/yt-analytics.readonly`; the Analytics endpoint `https://youtubeanalytics.googleapis.com/v2/reports`.
- Conventional Commits (lowercase subject ≤100 chars, `Refs #138`), Biome, no personal data, the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus

1. A Graph insights call that fails for a reason other than an unsupported metric (token expired, media deleted): no retry loop, the attempt fails as before, the follow fields never masquerade as 0. Test in Task 2.
2. A YouTube channel connected before this change (no `scope` key in its credentials): no Analytics call, no log noise, `follows` NULL, the video metrics answer says `analytics: false`. Test in Task 3.
3. A 403 from Analytics on a connection whose stored scope claims the grant (the owner removed access in Google): the channel's statistics sample is still recorded with `follows` NULL and the failure logged once. Test in Task 3.
4. The 24 h notification for a post whose `follows` is NULL (unsupported media or an older sample): the line reads exactly as before, no "+0 followers". Test in Task 2.
5. A YouTube video's Results view under the reconnect state: the picker has no Subscribers entry and the muted line shows; with the scope and a 0 gained, the line shows "+0 subscribers". Checked in Task 4 (route test for `analytics`; the view by typecheck and a look).

---

### Task 1: The columns and the series fields

**Files:**
- Create: `packages/schema/src/migrations/0012_post_metrics_followers.ts`; register in `packages/schema/src/migrations/index.ts`; generate (`pnpm --filter @bongsu/schema generate`) → `migrations/sqlite/0012_post_metrics_followers.sql`, `migrations/postgres/0012_post_metrics_followers.sql`, `docs/schema.md`, `schema.json`.
- Modify: `packages/core/src/metrics.ts` (`Sample`, `FIELDS`, `sampleOf`, `recordSample`, every `SELECT … FROM post_metrics` column list in `metrics.ts`, `results.ts`, `packages/api/src/agent/ops.ts`), `packages/core/src/results.ts`.
- Test: `packages/schema/test/sqlite.test.ts`, `packages/schema/test/postgres.test.ts` (a `0012_post_metrics_followers` describe like 0011's: migrate from 0011, assert the two columns exist and accept NULL), `packages/core/test/metrics.test.ts`.

**Interfaces:**
- Produces: `Sample` gains `follows: number | null; profile_visits: number | null`; `sampleOf(v, at)` reads `v.follows` and `v.profile_visits`; `recordSample` writes them; `series`/`nearest24h` carry them.

- [ ] **Step 1: Write the failing tests**: schema (both engines): after 0012, `post_metrics` has `follows` and `profile_visits` and an insert without them succeeds; core: `sampleOf({ views: 1, follows: 12, profile_visits: 85 }, 10)` → `{ follows: 12, profile_visits: 85 }`; `series` daily returns the difference of `follows` (`[null→, 5]` for samples 10 then 15) and NULL when either sample lacks it.
- [ ] **Step 2: Run** `pnpm --filter @bongsu/schema test`, `pnpm --filter @bongsu/core test`. Expected: FAIL (unknown column / missing field).
- [ ] **Step 3: Implement** the migration (`alterTable`/`addColumn` as the generator supports; else a `sql` step with the two portable `ALTER TABLE post_metrics ADD COLUMN … INTEGER` statements per dialect), regenerate, extend the fields.
- [ ] **Step 4: Run** the two suites, `pnpm typecheck`, `git status --porcelain migrations docs/schema.md` (only the new files). Expected: PASS.
- [ ] **Step 5: Commit** `feat(schema,core): post_metrics carries follows and profile visits` (`Refs #138`).

---

### Task 2: Instagram follows and profile visits

**Files:**
- Modify: `packages/core/src/metrics.ts` (`FOLLOW_METRICS`, `insightsOf`), `packages/core/src/results.ts` (use `insightsOf`; the line), `apps/cloudflare/test/world.ts` (insights answer; `graphNoFollows: Set<string>`).
- Test: `apps/cloudflare/test/metrics.test.ts`, `apps/cloudflare/test/phase11.test.ts` (the notification line).

**Interfaces:**
- Consumes: Task 1's fields.
- Produces: `export const FOLLOW_METRICS = ["follows", "profile_visits"] as const`; `export async function insightsOf(pr: { results(mediaId: string, metrics: string[]): Promise<Record<string, number | null>> }, mediaId: string): Promise<Record<string, number | null>>` — one call with `[...METRICS, ...FOLLOW_METRICS]`; on an `InstagramError` whose message contains `metric` (Meta's "metric[n] must be one of …"), one retry with `[...METRICS]`, the follow keys left out (→ NULL); any other error rethrown.

- [ ] **Step 1: Write the failing tests**: metrics.test.ts: "an Instagram sample records follows and profile visits" (the fake answers `follows = 7 × n`, `profile_visits = 8 × n` → the row has them); "a media without follow metrics keeps the rest" (`w.graphNoFollows.add(mediaId)` → the first call 400s, the row has views etc. and `follows IS NULL`, exactly two insights calls); "a failing insights call isn't retried" (`w.graphTokens.clear()` style failure → no row, one call). phase11.test.ts: the 24 h line ends with ` · +7 followers · 8 profile visits` (values from the fake at n=1) and a NULL-follows case reads as before (no "followers").
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement**: the fake world's insights handler answers the follow metrics when asked (and 400s with `{ error: { message: "(#100) metric[6] must be one of the following values: …" } }` for ids in `graphNoFollows` when the request's `metric` names `follows`); `insightsOf`; the sampler (`metrics.ts` Instagram branch) and `results.ts` call it; the line: after the existing `commen…` part, `${v.follows != null ? ` · +${v.follows} followers` : ""}${v.profile_visits != null ? ` · ${v.profile_visits} profile visits` : ""}`.
- [ ] **Step 4: Run** `pnpm --filter @bongsu/cloudflare exec vitest run test/metrics.test.ts test/phase11.test.ts test/phase13.test.ts test/providers.test.ts --testTimeout 120000 --maxWorkers=2`, `pnpm check`, `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): Instagram follows and profile visits in the series and the 24 h line` (`Refs #138`).

---

### Task 3: YouTube subscribers gained and the Analytics scope

**Files:**
- Modify: `packages/core/src/clients/youtube.ts` (`AnalyticsScopeError`, `subscribersByVideo`), `packages/core/src/providers/youtube.ts` (`exchangeGoogleCode` stores `scope`; `youtubeAnalytics`; `YouTubeProvider.subscribers`), `packages/core/src/providers/index.ts` (the scope), `packages/core/src/metrics.ts` (the channel sample), `apps/cloudflare/test/world.ts` (`ytAnalyticsScope = true`, `ytAnalyticsCalls: string[][]`, the reports endpoint, the token exchange's `scope`).
- Test: `apps/cloudflare/test/metrics.test.ts`, `apps/cloudflare/test/connect.test.ts`.

**Interfaces:**
- Produces: `class AnalyticsScopeError extends Error` (clients/youtube.ts); `YouTube.subscribersByVideo(ids: string[], from: string, to: string): Promise<Map<string, { gained: number; lost: number }>>` (`from`/`to` `YYYY-MM-DD`; 50 ids per call; 403 → `AnalyticsScopeError`; other non-OK → `Error("youtube analytics: <status>")`); `YouTubeProvider.subscribers(ids, from, to)` delegating; `export async function youtubeAnalytics(env: Env, connection: string): Promise<boolean>` (providers/youtube.ts: the decrypted credentials JSON's `scope` string contains `yt-analytics.readonly`); `exchangeGoogleCode` adds `scope: j.scope ?? ""` to the credentials JSON.

- [ ] **Step 1: Write the failing tests**: connect.test.ts: the YouTube authorize URL's `scope` holds both scopes; after the exchange the stored credentials JSON has `scope` with both (the fake token answer gains `scope: "https://www.googleapis.com/auth/youtube.force-ssl https://www.googleapis.com/auth/yt-analytics.readonly"`). metrics.test.ts: "a YouTube sample records subscribers gained" (the fake reports endpoint answers `[[videoId, 3 × n, 0]]` per filtered id → `follows = 3`, one Analytics call per channel with every due id); "a channel without the scope makes no Analytics call" (seed the connection's credentials without `scope` → `follows IS NULL`, `ytAnalyticsCalls` empty, the statistics row recorded); "a 403 from Analytics keeps the statistics sample" (`w.ytAnalyticsScope = false` with the scope stored → row recorded, `follows IS NULL`, one Analytics call, one log line).
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement** per the Interfaces block. The channel sample in `sampleMetrics`: `statsOf` grows a `subs` map fetched once per channel (`youtubeAnalytics(env, account.connection)` first; from = the earliest `when` date of the channel's due videos, to = today's UTC date); `follows = subs.get(id)?.gained ?? (granted ? 0 : null)`, `profile_visits = null`. Fake world: `GET youtubeanalytics.googleapis.com/v2/reports` → 403 `{ error: { code: 403, message: "Insufficient Permission" } }` when `!ytAnalyticsScope`, else `{ columnHeaders: [{name:"video"},{name:"subscribersGained"},{name:"subscribersLost"}], rows: [...] }` for the ids in `filters=video==…`.
- [ ] **Step 4: Run** `… test/metrics.test.ts test/connect.test.ts test/providers.test.ts test/release.test.ts --testTimeout 120000 --maxWorkers=2`, `pnpm check`, `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): YouTube subscribers gained per video through the Analytics API` (`Refs #138`).

---

### Task 4: Routes and the app

**Files:**
- Modify: `packages/api/src/agent/ops.ts` (`results24h` → `follows`, `profile_visits`; `videoMetrics` → `analytics`), `packages/api/src/pwa/routes.ts` (if it maps the fields), `packages/web/src/api.ts` (`Results`, `MetricPoint`, the video metrics type), `packages/web/src/App.tsx` (`ResultsLine`; the metric picker: `follows` → "Followers"/"Subscribers", `profile_visits` → "Profile visits" (Instagram only); the reconnect line), `packages/web/src/i18n.ts` (`results.follows`, `results.subscribers`, `results.profile_visits`, `results.analytics_missing`), `packages/web/DESIGN.md`, `packages/web/PRODUCT.md`.
- Test: `apps/cloudflare/test/metrics.test.ts` (the item route's `results.follows`/`profile_visits`; `/app-api/video/metrics` → `analytics: true|false`; samples carry the fields).

**Interfaces:**
- Consumes: Tasks 1-3. The `analytics` flag: `youtubeAnalytics(env, account.connection)` for the video's account.

- [ ] **Step 1: Write the failing tests**: the item route's `results` has `follows: 7, profile_visits: 8` after a 24 h result; the metrics route's samples carry them; `/app-api/video/metrics` answers `analytics: true` with the scope and `false` without.
- [ ] **Step 2: Run**. Expected: FAIL.
- [ ] **Step 3: Implement**; `pnpm --filter @bongsu/web typecheck && pnpm --filter @bongsu/web build`; look at the Results view through the screenshot pipeline only if the seed changes (it needn't: add `follows`/`profile_visits` to the seed's samples so the demo shows the line, and re-capture `results` only).
- [ ] **Step 4: Run** the metrics test file, `pnpm --filter @bongsu/web test`, `pnpm check`, `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(api,web): the followers a post brought on Results; the reconnect state for YouTube` (`Refs #138`).

---

### Task 5: Docs, plan, changeset, full check

**Files:** `site/docs/youtube.md` (consent scope step, enable the YouTube Analytics API, "Reconnect for subscriber numbers", quota note), `site/docs/instagram-graph.md`, `site/docs/how-it-works.md`, `site/docs/the-app.md`, `docs/PLAN.md` (tick #138), `.changeset/followers.md` (core, api, web, schema minor).

- [ ] **Step 1: Write** them. **Step 2: Full verification**: `pnpm check`, `pnpm typecheck`, `pnpm --filter @bongsu/schema generate` (no diff), `pnpm test` (core + Cloudflare full, `--testTimeout 120000 --maxWorkers=2`), `pnpm --filter @bongsu/web test`, `pnpm --filter @bongsu/node test`, `pnpm --filter @bongsu/schema test`, `pnpm test:site`, `pnpm site`. **Step 3: Commit** `docs(docs): tick #138: followers brought by a post or video` (`Refs #138`).
