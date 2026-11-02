---
title: "Phase 9 part 2b: the account series and the channel page"
author: NYT87
date: 2026-11-02
branch: feat/phase-9-channel
cost: { minutes: 61, tokens: 203768 }
touches:
  - ".impeccable/config.json"
  - apps/cloudflare/test/account-metrics.test.ts
  - apps/cloudflare/test/stats.test.ts
  - packages/api/src/agent/ops.ts
  - packages/api/src/pwa/performance.ts
  - packages/api/src/pwa/routes.ts
  - packages/core/src/account-metrics.ts
  - packages/core/src/constants.ts
  - packages/web/src/App.tsx
  - packages/web/src/i18n.ts
---

## Decided

- `account_metrics` holds one follower (subscriber) count per account per day, sampled by `sampleAccounts` (packages/core/src/account-metrics.ts) in the inbox run: 4 accounts a run, 8 attempts, a failing account stamped (`account_metrics_failed:<id>`) and retried after 6 h. YouTube's `subscriberCount` is rounded by YouTube; exact daily gains were left out because Analytics lags 1-3 days.
- Imported nightly snapshots backfill it once per workspace: the samples there are read once, the missing ones inserted 20 per statement, 200 per run; the flag `account_metrics_backfill:<ws>` is set only when nothing is missing. A `taken` without an offset is on the workspace's clock.
- `dailyGrowth` (metrics.ts) is the generic "growth since the previous sampled day, gaps as null" rule; the channel route uses it for followers and for each post's views.
- `channelStats` (ops.ts, reused by #140): a post's "brought" is follows at the period's end less the last sample at or before its start, else its first sample in the period. Views per day count a post's publishing day only when its first sample came within 6 h of publishing (a zero is prepended). A share over 100% is answered as null.
- The performance and report routes now filter by the caller's workspace (they read every workspace's before); the Stats list reads followers from the series once it exists.

## Tried and ruled out

- A SELECT-then-INSERT per snapshot row: on Workers a long history exceeds the per-invocation query budget and the flag is never reached, starving the later inbox steps (token renewal included).
- Tests on the real clock with `now - H`: they fail for an hour after midnight on the workspace's clock; pin samples to noon of today in the workspace zone.

## Watch out

- Snapshot account names must equal `accounts.id` for the backfill to pick them up; others are skipped silently.
- A Stats link built from a snapshot-only account name leads to a 404 on the channel page.
