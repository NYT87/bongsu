---
title: "Phase 9 part 3: stats for agents, the metrics ingest, the old tables"
author: NYT87
date: 2026-11-02
branch: feat/phase-9-agent-stats
cost: { minutes: 89, tokens: 215976 }
touches:
  - ".impeccable/config.json"
  - apps/cloudflare/test/agent-stats.test.ts
  - apps/cloudflare/test/workspaces.test.ts
  - packages/api/src/agent/ops.ts
  - site/docs/api-reference.md
  - site/docs/security.md
  - site/docs/what-agents-can-do.md
  - ".changeset/agent-stats.md"
  - docs/PLAN.md
  - site/docs/cli.md
---

## Decided

- Every stats tool is a `TOOLS` entry (MCP and REST at once): `get_metrics` (`GET /v1/items/<key>/metrics`, registered before `get_item`'s greedy `:key{.+}` route), `get_account_metrics`, `list_performance`; all `read`. They reuse the app's ops (`itemMetrics`, `results24h`, `viewsPerDay`/`postRows` shared with `channelStats`).
- `ingest_metrics` (`POST /v1/metrics`) writes into `post_metrics`/`account_metrics` behind a new `metrics` scope: opt-in on agent keys (not in the dashboard's defaults), in the owner's and admin's role scopes. Rows are all checked first (one bad row writes nothing), deduped on (key or account, at), and must be at least an hour old so an upload never becomes the 24 h result (`results.ts` reuses a sample within the hour).
- `labels` and `manual_stats` are dropped (migration 0014, `DROP TABLE IF EXISTS` in a `sql` step whose `apply` removes them from the model).

## Tried and ruled out

- `IN (?2, ?3, …)` with one parameter per value: D1 refuses more than 100 bound parameters; use `jsonList(db, n)` (one JSON parameter) and multi-row inserts chunked under 100 parameters.
- `findUpload` per `video:` key in a batch: it refreshes every channel per unknown id; look ids up in the cached lists and refresh each channel once.

## Watch out

- On this machine under load (load average ~20) PGlite suites time out in hooks (the Node Postgres tests show as skipped, the schema tests fail); rerun alone or with `--hookTimeout 120000` before suspecting a change.
- The fake world serves every YouTube channel from one uploads list, so per-channel refresh costs can't be told apart in tests.
