---
title: "Phase 9 part 2a: the followers a post or video brought"
author: NYT87
date: 2026-11-01
branch: feat/phase-9-followers
cost: { minutes: 119, tokens: 941672 }
touches:
  - ".impeccable/config.json"
  - apps/cloudflare/test/metrics.test.ts
  - apps/cloudflare/test/world.ts
  - packages/core/src/clients/youtube.ts
  - packages/core/src/metrics.ts
  - packages/core/src/results.ts
  - site/docs/youtube.md
  - ".changeset/followers.md"
  - docs/PLAN.md
  - site/docs/how-it-works.md
---

## Decided

- The followers a post brought are two more lifetime counts on `post_metrics` (`follows`, `profile_visits`, migration 0012); YouTube's subscribers gained since publishing go in `follows`.
- Instagram: `insightsOf` (packages/core/src/metrics.ts) asks for the follow metrics with the rest; a refusal whose message names a metric gets one retry without them, and the refusal is remembered per post (`settings` key `metrics_nofollows:<key>`, cleared with the failure stamps past 90 days).
- YouTube: the Analytics API (`reports.query`, `dimensions=video`, `sort=-subscribersGained`, `maxResults=50`), one query per channel per run, only when the connection's stored credentials carry `scope` with `yt-analytics.readonly`. `exchangeGoogleCode` stores Google's granted `scope`; a connection made before has none and answers `analytics: false` until reconnected.
- A video with no Analytics row is "unknown" (NULL) under 72 h old (the report lags 1-3 days), 0 after. The query starts the UTC day before the oldest due upload because Analytics days are Pacific Time.
- Videos have no 24 h line: Subscribers is a picker metric on the video's Results view; the reconnect line sits under the chart.

## Tried and ruled out

- Storing a missing Analytics row as 0: a young video's chart showed a flat zero then a jump.
- Paying the follow-metrics retry on every sample: two calls per sample for 90 days on a media type without them.

## Watch out

- The fake world accepts any Analytics query shape and any Graph metric list: the real API's requirements (the top-videos report's sort and cap; which media types answer `follows`) were checked by reasoning, not by a live call. Look at one real channel and one real Reel after deploying.
- A channel configured from a secret needs `scope` in its JSON value, or it stays on "not available" forever.
- New commits' trailer follows the session's model (the attribution reminder); older commits on a branch may name another.
