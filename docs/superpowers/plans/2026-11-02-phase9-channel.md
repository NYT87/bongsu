# Phase 9 part 2b: the account series and the channel page — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A daily follower series per account, backfilled from snapshots, and a channel page with the followers chart, views per day and what brought followers.

**Architecture:** One table and a sampler in core; one op/route in api (plus the performance route reading the series, scoped to the workspace); the existing `LineChart` in the web app.

**Tech Stack:** TypeScript, the neutral schema, Hono, React, vitest with the fake world.

**Spec:** `docs/superpowers/specs/2026-11-02-phase9-channel-design.md`

## Global Constraints

- Portable SQL; timestamps from the app; every read filtered by `c.caller.workspaceId`; rows tagged from the account.
- `core`/`api` runtime-independent; approval untouched; strings through `t()`.
- Constants: `ACCOUNT_METRICS_S = 24 h`, `ACCOUNTS_PER_RUN = 4`, `ACCOUNTS_ATTEMPTS_PER_RUN = 8`; the failure wait `METRICS_DENSE_S`; `days` ∈ {7, 30, 90}, default 30; brought: at most 10.
- Exact copy: "Not available until the channel is reconnected with analytics (dashboard → Connections)."; "No followers attributed to posts in this period."
- Conventional Commits, `Refs #139`, Biome, no personal data, trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A snapshot whose `taken` has no offset: on the workspace's clock, not UTC (backfill test).
2. The backfill running twice (flag lost, or a second workspace): no duplicate rows (idempotence test).
3. An account with a single sample: `change` null, the daily chart empty, no crash (route test).
4. Another workspace's account or snapshot: 404 / not shown (workspaces test).
5. A post whose first sample is inside the period: its brought count is from that sample, not from 0 at an unknown time (route test with a mid-period first sample).

---

### Task 1: The table and `dailyGrowth`
Files: `packages/schema/src/migrations/0013_account_metrics.ts` (+ index, generate), `packages/core/src/metrics.ts`, tests in `packages/schema/test/*`, `packages/core/test/metrics.test.ts`.
- [ ] Failing tests: the table on both engines; `dailyGrowth` with a gap and a zone boundary. Run: FAIL.
- [ ] Implement; run schema + core tests, typecheck. Commit `feat(schema,core): an account_metrics series and the daily growth rule`.

### Task 2: The account sampler and the backfill
Files: `packages/core/src/account-metrics.ts`, `packages/core/src/clients/youtube.ts` (`subscriberCount`), `packages/core/src/providers/youtube.ts`, `packages/core/src/constants.ts`, `packages/core/src/schedules.ts`, `apps/cloudflare/test/world.ts` (channels statistics; Composio user info), `apps/cloudflare/test/account-metrics.test.ts`.
Produces: `sampleAccounts(env, deps): Promise<{ sampled: string[]; backfilled: number }>`.
- [ ] Failing tests per the spec's list. Run: FAIL. Implement. Run the file + metrics + scenario tests, typecheck, check. Commit `feat(core): sample each account's followers daily; backfill from the snapshots once`.

### Task 3: The channel route and the performance route
Files: `packages/api/src/agent/ops.ts` (`channelStats`), `packages/api/src/pwa/routes.ts`, `packages/api/src/pwa/performance.ts`, tests `apps/cloudflare/test/stats.test.ts` (new), `app.test.ts`, `workspaces.test.ts`.
Consumes: Task 1's `dailyGrowth`; Task 2's rows. Produces: the route answer in the spec.
- [ ] Failing tests (shape, days, daily, views summed, ranking and share with a mid-period first sample, analytics flag, single-sample account, performance from the series and its fallback, workspace isolation). Run: FAIL. Implement. Run, typecheck, check. Commit `feat(api): the channel stats route; the performance route reads the series per workspace`.

### Task 4: The channel page
Files: `packages/web/src/App.tsx` (`ChannelPage`, the Stats rows' `since`), `packages/web/src/api.ts`, `packages/web/src/i18n.ts`, `packages/web/DESIGN.md`, `packages/web/PRODUCT.md`.
- [ ] Implement; web typecheck, build, test; check. Commit `feat(web): the channel page: followers, views per day and what brought them`.

### Task 5: Docs, plan, changeset, full check
Files: `site/docs/how-it-works.md`, `site/docs/the-app.md`, `site/docs/youtube.md`, `site/docs/configuration.md`, `docs/PLAN.md`, `.changeset/account-series.md`.
- [ ] Write; full verification (check, typecheck, generate no diff, core, schema, web, node, Cloudflare full, test:site, site). Commit `docs(docs): tick #139: the account series and the channel page`.
