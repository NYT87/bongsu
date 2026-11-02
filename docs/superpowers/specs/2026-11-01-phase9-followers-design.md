# Phase 9, part 2a: followers brought by a post or video

The first of part 2's two merge requests (`docs/PLAN.md`, Phase 9): #138, the followers a post or video brought,
on the Results view and in the 24 h notification. Decided with the owner on 2026-11-01: the YouTube Analytics scope
is added now (channels connected before show a reconnect state until reconnected); the account series, its
backfill from the nightly snapshots and the channel page are the second merge request (#139); the agent tools are
part 3 (#140). Execution: native (this session implements, one whole-branch review at the end).

## The series

Migration `0012_post_metrics_followers` (`packages/schema/src/migrations/`, generated for both dialects,
`docs/schema.md` regenerated): `post_metrics` gains `follows` (int, NULL) and `profile_visits` (int, NULL) with a
portable `ALTER TABLE … ADD COLUMN`. `follows` is the lifetime count of accounts that started following because of
the post (Instagram `follows`) or subscribed from the video (YouTube `subscribersGained` since publishing);
`profile_visits` is Instagram's `profile_visits` (NULL for YouTube). Daily values keep being differences on read.

`Sample` (`packages/core/src/metrics.ts`) gains the two fields; `FIELDS`, `sampleOf`, `recordSample`, `series`,
`nearest24h` carry them like the others. The old count copy in 0011 stays as it is (those rows have NULLs).

## Instagram

- `FOLLOW_METRICS = ["follows", "profile_visits"]` next to `METRICS`. The sampler and the 24 h result ask the
  provider for `[...METRICS, ...FOLLOW_METRICS]` in one insights call. When the Graph API rejects the call because a
  media type has no such metric (a 400 whose message names the metric: feed photos and carousels do have them, but
  older media and some account types don't), one retry with `METRICS` alone, the two left NULL; a helper
  `insightsOf(provider, mediaId)` in `metrics.ts` owns the retry so both callers share it. Composio goes through the
  same provider method and the same fallback.
- The 24 h notification line (`results.ts`) gains ` · +12 followers · 85 profile visits` when `follows` is not NULL
  (the profile visits part only when not NULL); a Trial copy's line the same, so the Reel's and the Trial Reel's
  follows stand side by side. Nothing else in the wording changes.

## YouTube

- `YouTube.subscribersByVideo(ids, from, to)` (`clients/youtube.ts`): the Analytics API
  (`GET https://youtubeanalytics.googleapis.com/v2/reports?ids=channel==MINE&startDate=<from>&endDate=<to>&metrics=subscribersGained,subscribersLost&dimensions=video&filters=video==<ids>`,
  50 ids per call, dates `YYYY-MM-DD`) → `Map<id, { gained, lost }>`; a video with no row has gained 0. A 403 throws
  `AnalyticsScopeError` (the token lacks the scope; the message says to reconnect). `YouTubeProvider.subscribers`
  exposes it.
- The sampler: a channel's sample is `statistics` plus, when the connection holds the analytics scope,
  `subscribersByVideo(ids, earliest publish date of the batch, today)` in one more call per channel per run;
  `follows = gained`, `profile_visits = NULL`. Without the scope the call is skipped (no attempt, no log noise) and
  `follows` stays NULL.
- The scope: `providers/index.ts` adds `https://www.googleapis.com/auth/yt-analytics.readonly` to the YouTube
  connect scopes, and `exchangeGoogleCode` keeps Google's `scope` answer in the stored credentials (`scope` key in
  the JSON). `youtubeAnalytics(env, connection): Promise<boolean>` (`providers/youtube.ts`) reads it: true when the
  stored scope string holds `yt-analytics.readonly`; a connection made before this change has no `scope` key and
  answers false. The Google Cloud project must have the **YouTube Analytics API** enabled (a docs step).
- The video metrics answer (`videoMetrics` op, `/app-api/video/metrics`) gains `analytics: boolean` so the app can
  say why subscribers are missing. `GET /app-api/item` is unchanged in shape apart from the two new `Results` fields.

## Routes and the app

- `Results` (`packages/web/src/api.ts` and the routes building it) gains `follows` and `profile_visits`; the
  `MetricPoint` type and the metrics answers carry them.
- `ResultsLine`: ` · +12 followers · 85 profile visits` after the existing numbers when `follows` is not NULL (the
  visits part when not NULL); YouTube's line: ` · +12 subscribers`. The Trial Reel's line gets its own, as today.
- The metric picker on Results gains **Followers** and, for Instagram, **Profile visits** (YouTube: Followers only,
  labelled **Subscribers**). The chart reads the new fields like the others; Daily shows the growth.
- A YouTube video's Results view without the scope shows a muted line under the numbers: "Subscribers gained: not
  available until the channel is reconnected with analytics (dashboard → Connections)." with no Subscribers entry
  in the picker. The dashboard's Connections page is unchanged: **Reconnect** already exists on the row.
- Notifications: unchanged apart from the line's new numbers.

## Fake world and tests

- `apps/cloudflare/test/world.ts`: Graph insights answer `follows` and `profile_visits` too (growing per read); a
  flag `graphNoFollows` (a media id set) makes the call 400 with Meta's "metric[6] must be one of …" message when
  the follow metrics are asked, so the retry is exercised; `youtubeanalytics.googleapis.com/v2/reports` answers one
  row per filtered video (`subscribersGained` growing per read, `subscribersLost` 0), 403 when the world's
  `ytAnalyticsScope` is false; the token exchange answers `scope` with both scopes (one scope when a test asks).
- Tests: `packages/core/test/metrics.test.ts` (sampleOf and series with the new fields); `packages/schema/test`
  (the migration adds the columns on both engines); `apps/cloudflare/test/metrics.test.ts` (an Instagram sample
  records follows and visits; the fallback leaves them NULL and still records the rest; a YouTube sample records
  subscribers gained with the scope and NULL without, with no Analytics call; the video metrics answer's
  `analytics`; the 24 h notification line with the followers part; the item route's `results` fields);
  `connections` tests (the authorize URL carries both scopes; the exchange stores `scope`); `workspaces.test.ts`
  unchanged (no new route).
- Docs: `site/docs/youtube.md` (the consent screen step adds the Analytics scope, the Cloud project enables the
  YouTube Analytics API, a "Reconnect for subscriber numbers" note; the quota paragraph: Analytics has its own
  quota, one query per channel per run), `site/docs/instagram-graph.md` (the insights permission covers
  `follows`/`profile_visits`), `site/docs/how-it-works.md` and `site/docs/the-app.md` (the Followers line, the
  reconnect state), `packages/web/PRODUCT.md`, `packages/web/DESIGN.md` (the Results line), `docs/PLAN.md` tick
  #138. Changeset: `@bongsu/core`, `@bongsu/api`, `@bongsu/web`, `@bongsu/schema` minor.
- One merge request, `feat(core,api,web,schema): followers brought by a post or video`, `Closes #138`.

## Out of scope

The account series, the snapshot backfill, the channel page and its ranking (#139, the next merge request); the
agent tools (#140); `subscribersLost` in the app (fetched, not stored: a video's lost subscribers aren't attributable
in the same sense); a dashboard badge for the missing scope.
