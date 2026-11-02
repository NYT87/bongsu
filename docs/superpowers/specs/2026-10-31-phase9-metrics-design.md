# Phase 9, part 1: the metrics series, the sampler, the chart and the Results view

The first of Phase 9's three parts (`docs/PLAN.md`): #137 (a `post_metrics` time series sampled by the cron run,
line charts total and daily), #136 (a published item's page splits into Results and Post; the Trial Reel's results
beside the Reel's; the 24 h notification opens Results) and #86's post side (the built-in sampler replaces the
Python collect for posts; the account side is part 2). Decided with the owner on 2026-10-31: the 24 h result is the
series' sample nearest 24 hours after publishing (`post_results` keeps only the median comparison and the
notification marker); followers (#138), the account series and channel page (#139) and the agent tools (#140) are
parts 2 and 3; #88's tables are dropped and #87 becomes a metrics ingest in part 3.

## The series

Migration `0011_post_metrics` (`packages/schema/src/migrations/`, generated for both dialects, `docs/schema.md`
regenerated):

- `post_metrics`: `id` (serial), `item_key` (the plan key, `trial:<key>` for a Trial Reel copy, `video:<id>` for a
  YouTube upload), `account`, `platform`, `media_id`, `taken_at` (unix seconds), `views`, `reach`, `likes`, `comments`,
  `saves`, `shares` (ints, NULL when the platform doesn't give one), `workspace_id`; indexes `(item_key, taken_at)`
  and `(workspace_id, taken_at)`. One row per sample; lifetime counts as the APIs report them. Daily values are the
  difference between consecutive samples, computed on read, never stored.
- `post_results` loses its six count columns (a `sql` step: Postgres `ALTER TABLE … DROP COLUMN`, SQLite's rebuild:
  create, copy, drop, rename) and keeps `item_key`, `account`, `media_id`, `median_views`, `fetched_at`,
  `workspace_id`: the marker that the 24 h notification went out, and the account's median at that time.

## The sampler

`packages/core/src/metrics.ts`, run in the inbox cron run after `postResults` (`schedules.ts`, its own try):

- `sampleMetrics(env, deps): Promise<{ sampled: string[] }>`: the published, non-story Instagram posts of every
  workspace (`posted` and `trial_posts` with a `media_id`) and the public uploads of every YouTube channel (the
  calendar's cached uploads, `channelUploads`, those with `privacy === "public"`), each with its last sample time;
  the ones due by the schedule, oldest due first, `METRICS_PER_RUN = 4` per run. Instagram samples through the
  provider's `results(mediaId, METRICS)` (Graph and Composio, as the 24 h fetch does); YouTube through a new
  `YouTube.statistics(ids): Promise<Map<id, { views, likes, comments }>>` (`videos.list` `part=statistics`, 1
  quota unit per 50 ids; one call per channel per run covers every due video of that channel). Each sample is one
  `post_metrics` row with `taken_at = now`.
- The schedule (`constants.ts`; constants, no environment overrides yet: nothing else in that file has them; a
  redeploy changes them): `METRICS_DENSE_S = 6 h` for `METRICS_DENSE_UNTIL_S = 3 d` after publishing, then every
  `METRICS_DAILY_S = 24 h` until `METRICS_DAILY_UNTIL_S = 30 d`, then every `METRICS_WEEKLY_S = 7 d` until
  `METRICS_STOP_S = 90 d`, then never. `nextSampleAt(publishedAt, lastAt | null, nowS)` is the pure rule
  (`metrics.ts`, unit-tested): due when there is no sample, or when `now - last >= interval(age)`.
- The 24 h result (`results.ts`): unchanged in when it runs (24 h after publishing, up to 3 days, a few per run) and
  what it says; it now writes its fetch as a `post_metrics` sample (unless one was taken in the last hour, then it
  uses that one) and the `post_results` marker with the median. Its notification lines read from the sample.
- `series(rows, { daily, tz }): Point[]` (`metrics.ts`, pure): total mode returns the samples; daily mode keeps the
  last sample of each day on the workspace's clock and returns the differences between consecutive days, `null`
  for a metric on a day without a sample. `nearest24h(rows, publishedAt)` picks the sample closest to
  `publishedAt + 24 h` within ±6 h, else the latest; the item route uses it for the "24 h" numbers.

## Routes (`/app-api`)

- `GET /app-api/item/metrics?key=&daily=&from=&to=` → `{ item: { key, platform, account, label, published_at,
  due, due_at }, samples: [{ at, views, reach, likes, comments, saves, shares }…], trial?: { samples: [...] } }`,
  the shape #140's `get_metrics` will reuse (the op lives in `packages/api/src/agent/ops.ts` as `itemMetrics`, with
  the caller's workspace, `from`/`to` on the caller's clock, at most 400 points, the newest kept). 404 for an item
  not in the workspace.
- `GET /app-api/video/metrics?video=&daily=&from=&to=` → the same shape for a YouTube upload (`video:<id>`), 404
  when no channel of the workspace has it.
- `GET /app-api/item` keeps `results` and `trial.results` (the Results type unchanged for the app) now built from
  `nearest24h` of the series plus `post_results.median_views` and `fetched_at`; the CLI's `bongsu export` and the
  `/v1/items/<key>` answer that carried `results` read the same.

## The app

- `LineChart` (`packages/web/src/Chart.tsx`, inline SVG, no library): `series: { label, hue, points: { at, value |
  null }[] }[]`, a legend, the x axis as dates on the workspace's clock, the y axis with a few ticks (tabular
  numerals), a readout for the point nearest a tap or an arrow-key focus (a `role="img"` with an `aria-label`
  summary, and a visually hidden table of the values for screen readers), `prefers-reduced-motion` respected (no
  transitions when set), both themes. Series hues are new tokens `--series-1 … --series-5` in `tokens.css` (light
  and dark), kept apart from the channel and status colours (The Channel Code Rule, The One Signal Rule); a hue is
  never the only cue: each series has its label and a distinct marker shape at the points.
- A published Instagram item's page: a segmented control **Results | Post** (the Queue's `segmented` pattern) under
  the title; `#/item/<key>/results` opens Results, `#/item/<key>` opens Post (or Results when a result exists and the
  route doesn't say); the back link and the platform icon unchanged. **Results**: the 24 h numbers (views, reach,
  likes, comments, saves, shares, "×usual" against the median), the time they're from, then the chart with a
  **Total | Daily** toggle and a metric picker (views, reach, likes, comments, saves, shares; views by default); a
  Reel with a Trial Reel copy shows the Trial Reel as a second series and its own 24 h numbers ("×the regular
  Reel"). Before any sample: "No results yet: the first numbers arrive 24 hours after publishing." **Post**: what the
  page shows today for a published item.
- A YouTube video's page: **Results | Video** once the series has samples for it (views, likes, comments; no reach or
  saves), else as today.
- Notifications: `results` targets open `#/item/<key>/results`; a `trial:<key>` target maps to its Reel's Results
  (`actionsFor`), so the "Open in app" button exists for Trial Reel results too.
- The dashboard shows no items today, so nothing changes there (#136's "where it shows an item" has no such place).
- The Stats page's per-account chart waits for part 2 (the account series).

## Tests and docs

- `packages/core/test/metrics.test.ts`: `nextSampleAt` across the schedule's bands; `series` daily differences with
  a missing day (`null`) and samples out of order; `nearest24h`.
- `apps/cloudflare/test/metrics.test.ts`: the fake world's insights and a `videos.list part=statistics` handler
  return values that grow per call; the sampler takes a sample for a fresh post, none 5 hours later, one 6 hours
  later; after 3 days only daily; YouTube uploads sampled through one `videos.list` per channel; the 24 h fetch
  reuses a sample taken within the hour; the routes' shapes, `daily`, `from`/`to`, the 400 cap; the notification's
  target for a Reel and for its Trial Reel; `workspaces.test.ts` extended (another workspace's item → 404; the
  sampler tags rows with each workspace); `portable-sql.test.ts` passes.
- The migration generated and `docs/schema.md` regenerated; `docs/databases.md` if it lists tables.
- Docs: `site/docs/how-it-works.md` (Results and comments: the series and the schedule), `site/docs/the-app.md`
  (the Results view, the chart), `site/docs/youtube.md` (Quota: statistics, 1 unit per 50 videos per sample),
  `site/docs/configuration.md` (the schedule constants), `packages/web/DESIGN.md` (the chart component, the
  Results view), `packages/web/PRODUCT.md`.

## Docs and bookkeeping

- `docs/PLAN.md`: tick #137 and #136 ("done 2026-10-31"), #86's box with a note (posts sampled by the built-in
  collector; the account side with #139).
- Changeset: `@bongsu/core`, `@bongsu/api`, `@bongsu/web`, `@bongsu/schema` minor.
- One merge request, `feat(core,api,web,schema): metrics series, sampler, charts and the Results view`, closing
  #136, #137, `Refs #86`.

## Out of scope

Followers brought (#138), the account series and the channel page (#139), the agent tools and CLI (#140), the
metrics ingest (#87), dropping `labels`/`manual_stats` (#88, with part 3), the YouTube Analytics API, a per-account
chart on the Stats page, any analysis inside Bongsu.
