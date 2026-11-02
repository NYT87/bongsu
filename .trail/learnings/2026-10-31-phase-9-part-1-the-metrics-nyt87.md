---
title: "Phase 9 part 1: the metrics series, the sampler and the Results view"
author: NYT87
date: 2026-10-31
branch: feat/phase-9-metrics
cost: { minutes: 153, tokens: 1351593 }
touches:
  - ".impeccable/config.json"
  - packages/core/src/metrics.ts
  - packages/web/DESIGN.md
  - packages/web/src/i18n.ts
  - site/docs/the-app.md
  - docs/architecture.md
  - docs/development.md
  - site/docs/configuration.md
  - site/docs/how-it-works.md
  - site/docs/youtube.md
---

## Decided

- `post_metrics` holds lifetime counts per sample; daily values are differences computed on read (`series`), never stored. A sampled day shows the growth since the previous *sampled* day; days without a sample are `null` (gaps), so the weekly band gives one point a week.
- The 24 h result is the sample nearest publishing + 24 h within ±6 h; `post_results` keeps only the marker and the median. The item route's `results` is non-null only with an in-window sample or the marker, and the median counts in-window samples only, so "24 h" never shows a sample taken minutes after publishing.
- The sampler (`sampleMetrics`) runs after `postResults` in the inbox run: 4 samples per run, oldest due first, attempts capped at 2× that for the Workers subrequest budget; a failed attempt is stamped in `settings` (`metrics_failed:<key>`) and waits one interval; an account's or a channel's remaining candidates are skipped for the run after its first failure; at most 2 stale channel upload lists are refreshed per run.
- `video:<id>` candidates are deduped globally (first account in order owns the series); the last-sample lookup is by `item_key` only.
- Notification targets: only `results:`-prefixed targets open `/#/item/<key>/results`; a bare `trial:<key>` is the trial copy's job key and opens its Reel's page.
- The chart (`packages/web/src/Chart.tsx`) resets its readout pick when the `series` prop changes by reference: callers memoise it (`useMetrics` keeps one object per path). The readout reads each series at the chosen time (total: value at or before; daily: same tz-day), because the Reel and its Trial Reel are sampled in different runs.
- Migration 0011 copies each old `post_results` row into `post_metrics` as that post's first sample at `fetched_at` before dropping the count columns.

## Tried and ruled out

- Ordering failed candidates in memory only: a few broken posts headed the oldest-due order every run and starved every workspace; a persisted stamp was needed.
- Disabling the second demo YouTube channel in tests to hide the shared-channel double sample: dedupe on `item_key` instead.
- `nearest24h`'s latest-sample fallback for the item route and the median: it made "24 h" numbers appear at once and inflated the median.

## Watch out

- `pnpm screenshots` needs `pnpm --filter @bongsu/dashboard build` first: a web-only build wipes `packages/web/dist/dashboard` and the dashboard shots show the sign-in screen.
- `pgrep -f "vitest.mjs run"` matches your own shell; implementers kept seeing a phantom vitest run. Check `ps` with the pattern excluded.
- Subagents on another model write their own `Co-Authored-By` trailer; amend to the branch's line before the MR.
- The sampler's `channelUploads` refresh is now the main quota cost on YouTube (3 units per refresh, hourly per channel), not the statistics call.
