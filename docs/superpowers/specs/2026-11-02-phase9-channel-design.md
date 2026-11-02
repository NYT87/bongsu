# Phase 9, part 2b: the account series and the channel page

The second merge request of part 2 (`docs/PLAN.md`, Phase 9): #139. Decided with the owner on 2026-11-01: a daily
`account_metrics` series sampled by the cron run, backfilled once from the nightly snapshots; execution native.
Part 3 (#140 agent tools, #87 ingest, #88 tables) follows.

## Rulings (the issue leaves these open)

- **Followers only, at the account level.** `account_metrics` keeps the follower (subscriber) count per sample.
  Account-level reach and profile views aren't shown anywhere in #139, so they wait (YAGNI). YouTube's exact daily
  `subscribersGained`/`subscribersLost` wait too: Analytics publishes them 1-3 days late, so a daily sample can't
  attribute them to its own day; the daily chart is the difference of the counts. YouTube rounds `subscriberCount`
  (three significant figures above 1,000): the guide says so.
- **The dashboard links to the app's page** rather than having its own (no dashboard change in this MR: the
  dashboard has no stats today).
- **"What brought followers"** is the ranking of the account's posts and videos by the followers they brought in the
  period; it replaces the issue's "keep the posts list" (the channel page has no posts list today).

## The series

Migration `0013_account_metrics`: `account_metrics` (`id` serial, `account` (accounts.id), `platform`, `taken_at`,
`followers` int NULL, `workspace_id`), indexes `(account, taken_at)` and `(workspace_id, taken_at)`.

`dailyGrowth(points: { at; value | null }[], tz): { at; value | null }[]` (`metrics.ts`, pure): the last point of
each day on the zone's clock, then each sampled day's growth since the previous sampled day, `null` for a day with
no sample (the rule `series` follows; `series` keeps its own code).

## The sampler

`sampleAccounts(env, deps)` (`packages/core/src/account-metrics.ts`), in the inbox run after `metrics`:

- Every active Instagram and YouTube account of every workspace whose last sample is at least `ACCOUNT_METRICS_S`
  (24 h) old, oldest first, at most `ACCOUNTS_PER_RUN = 4` recorded and `ACCOUNTS_ATTEMPTS_PER_RUN = 8` tried per run.
- Instagram: the provider's `verify()` (`followers_count`, Graph or Composio). YouTube: `YouTube.subscriberCount()`
  (`channels.list part=statistics mine=true`, 1 unit; `hiddenSubscriberCount` → NULL).
- A failure logs and stamps `settings` `account_metrics_failed:<id>`; the account waits `METRICS_DENSE_S` (6 h)
  before it is tried again. A success clears the stamp.
- The backfill: before sampling, each workspace without the `settings` flag `account_metrics_backfill:<workspace>`
  gets one row per snapshot account (`followers` not NULL, an `accounts` row with that id and platform in that
  workspace), `taken_at` from the snapshot's `taken` (an ISO time with an offset as given; one without, on the
  workspace's clock), skipping a row that already exists at that time; then the flag is set.

## Routes

- `GET /app-api/stats/channel?account=&days=` (`days` 7, 30 or 90; default 30) → the op `channelStats` in
  `ops.ts` (#140 reuses it): `{ account: { id, platform, title, url, followers, change, since }, followers: { total:
  Point[], daily: Point[] }, views: Point[], brought: { key, title, platform, follows, share, href }[], analytics:
  boolean | null }`. 404 for an account not in the caller's workspace.
  - `followers.total`: the account's samples in the period; `daily`: `dailyGrowth` of them. `followers`/`change`/
    `since`: the latest sample, and its difference from the newest sample at least 20 h older (and that one's time).
  - `views`: per day on the caller's clock, the sum over the account's posts of each post's `dailyGrowth(views)`
    (`post_metrics` rows of the account in the workspace), `null` for a day no post has a value.
  - `brought`: per item of the account, `follows` at the end of the period minus `follows` at its start (the last
    sample at or before it, else the item's first sample in the period, so a post sampled from its first minutes
    counts nearly all); positive ones, most first, at most 10; `share` = the gain over the account's follower change
    in the period when that is positive, else null. `title`: the plan item's title (or name) for Instagram keys (a
    `trial:` key says "Trial Reel" after it), the cached upload's title for `video:` keys; `href`: `#/item/<reel
    key>/results` or `#/video/<account>/<id>?d=<published date>`.
  - `analytics`: for YouTube, whether the connection holds the analytics scope (`youtubeAnalytics`); null for
    Instagram.
- `GET /app-api/performance` now filters snapshots and reports by the caller's workspace (it read every workspace's:
  a pre-existing gap, closed here since the route changes). Its `accounts` come from the series when the workspace
  has samples (each active account with one: followers, change and `since`), else from the snapshot as today; it
  answers `none` only when there is neither.

## The app

- The Stats page's audience rows read `since` when present ("+3 since Oct 31").
- The channel page (`#/stats/<platform>/<account>`, `ChannelPage`): the big count and change as today; a period
  control **7 days | 30 days | 90 days**; the **followers** chart (`LineChart`, Total | Daily); **views per day**
  (`LineChart`, daily); **What brought followers**: rows (title, "+12", share as "40%"), each opening the item's
  Results or the video page; for YouTube without the scope: "Not available until the channel is reconnected with
  analytics (dashboard → Connections)."; with no gains: "No followers attributed to posts in this period."; the
  **Open on Instagram/YouTube** button. Through `useLoad` (cache, stale, retry).

## Tests and docs

- `packages/core/test/metrics.test.ts`: `dailyGrowth` (a gap, the zone's day boundary).
- `apps/cloudflare/test/account-metrics.test.ts`: an Instagram account sampled (Composio's user info), a YouTube
  channel (`channels.list` statistics), not again within 24 h, a failure stamped and retried after 6 h, the backfill
  once (idempotent, the offset-less time on the workspace clock, unknown accounts skipped).
- `apps/cloudflare/test/metrics.test.ts` (or a new `stats.test.ts`): the channel route's shape, `days`, the daily
  growth, views per day summed, the ranking and share, the YouTube `analytics` flag; `app.test.ts`: the performance
  route from the series and the snapshot fallback; `workspaces.test.ts`: another workspace's account → 404, its
  snapshot not shown.
- Docs: `site/docs/how-it-works.md`, `site/docs/the-app.md` (Stats and the channel page), `site/docs/youtube.md`
  (quota +1 unit a day per channel; rounded counts), `site/docs/configuration.md` (the constants),
  `packages/web/DESIGN.md`, `packages/web/PRODUCT.md`, `docs/PLAN.md` tick #139, changeset (core, api, web, schema
  minor). One MR, `feat(core,api,web,schema): the account series and the channel page`, `Closes #139`.

## Out of scope

Account reach and profile views; exact YouTube daily gains; a dashboard page; the agent tools (#140); the snapshot
upload API (#87).
