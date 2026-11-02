# Phase 9, part 3: stats for agents, a metrics ingest, the old tables dropped

The last part of Phase 9 (`docs/PLAN.md`): #140, #87 and #88 in one merge request. Decided with the owner on
2026-11-02: #87 is a samples API that writes into the same series the sampler fills; #88 drops `labels` and
`manual_stats`; one merge request; native execution.

## #140: three read tools

Each is an entry of `packages/api/src/agent/tools.ts` (an MCP tool and a `/v1` route), scope `read`, the caller's
workspace only. Dates are `YYYY-MM-DD` on the caller's clock, both inclusive, as elsewhere; every answer gives
instants as unix seconds (`at`) and the item's `published_at` as ISO UTC.

- `get_metrics` — `GET /v1/items/<key>/metrics` (registered before `get_item`'s greedy route): `itemMetrics` as the
  app uses it, plus `results` (the 24 h numbers, `results24h`) and, for a Reel with a Trial copy, `trial.results`;
  args `key`, `daily`, `from`, `to`, `metrics` (a subset of `views, reach, likes, comments, saves, shares, follows,
  profile_visits`; the others are left out of each point). A `video:<id>` key goes to `videoMetrics`. 404 outside the
  workspace.
- `get_account_metrics` — `GET /v1/accounts/<id>/metrics`: `{ account: { id, platform, title }, followers: Point[],
  views: Point[] }`: the account series (totals, or `dailyGrowth` with `daily`) and the views its posts added per day
  (the channel page's rule); `from`/`to`, default the last 30 days; at most `METRICS_MAX_POINTS` points, the newest.
  404 outside the workspace.
- `list_performance` — `GET /v1/performance?account=&platform=&from=&to=&sort=&limit=`: one row per post or video
  of the workspace with samples, published in the window (default the last 30 days; a post without a known
  publishing time counts its first sample's): `{ key, platform, account, title, label, published_at, at, views,
  reach, likes, comments, saves, shares, follows, profile_visits, views_24h }` (the latest sample's totals; `views_24h`
  from the strict 24 h sample). `sort` is any of the counts or `views_24h` or `published_at` (default `views`,
  descending, nulls last); `limit` default 50, at most 200. A Trial copy's row comes right after its Reel's when both
  are in the page.
- The descriptions say what the numbers are: lifetime counts as the platform reported them at `at`; `daily` is the
  growth since the previous sampled day, `null` for a day without a sample (not 0); reach, saves and the follow
  metrics only where the platform reports them; a video's `follows` only for a channel connected with the analytics
  scope; no analysis inside Bongsu.
- The CLI: `bongsu stats <key>` (the series as a table), `bongsu stats --account <id>` (followers and views per day),
  `--daily`, `--from`, `--to`, `--json` raw.

## #87: the metrics ingest

- `ingest_metrics` — `POST /v1/metrics`, a new scope `metrics`: opt-in on an agent key (like `reschedule`: the
  dashboard offers it, not given by default) and in the owner's and admin's role scopes (a CLI token). Body
  `{ posts?: [{ key, at, views?, reach?, likes?, comments?, saves?, shares?, follows?, profile_visits? }],
  accounts?: [{ account, at, followers }] }`, at most 500 rows a call; `at` ISO 8601 with a zone, not in the future
  (5 minutes' slack). A post key is a plan key of the workspace that went out (`posted`), its `trial:` copy
  (`trial_posts`), or `video:<id>` of a workspace channel's cached uploads; an account is one of the workspace's.
  Every row is checked first: one bad row answers 400 with each problem (`rows[3]: …`) and writes nothing. A sample
  already there (same key or account and `at`) is skipped, so an upload can be sent again. Rows land in
  `post_metrics` / `account_metrics` tagged with the workspace; the charts, the routes and the tools read them like
  sampled ones. Answer `{ posts: { added, skipped }, accounts: { added, skipped } }`. Written to the audit log.
- `bongsu ingest <file.json>` sends a file of that shape (`-` for stdin).
- Approval untouched: nothing in it reaches the plan, texts, approvals or publishing.

## #88: the old tables

Migration `0014_drop_labels_manual_stats`: `DROP TABLE labels; DROP TABLE manual_stats;` on both dialects (portable),
`docs/schema.md` and `schema.json` regenerated, `docs/architecture.md` updated. The changeset and the updating guide
say an instance that imported data from an earlier deployment loses what those tables held: `bongsu export` or a database backup first.

## Tests and docs

- `apps/cloudflare/test/agent-stats.test.ts`: each tool through MCP `tools/call` and REST; `metrics` subsets; `daily`
  with a null day; `list_performance` sorting, `limit` cap 200, the Trial row after its Reel, the window; the ingest:
  scope required (403 without), validation (one bad row, nothing written), idempotence, the 500 cap, a future `at`,
  another workspace's key or account refused, rows read back by the app's route.
- `workspaces.test.ts`: the three read routes and the ingest for another workspace's item or account (404 / 400).
- `packages/schema/test`: the tables are gone on both engines. `packages/cli/test`: `stats` and `ingest`.
- Docs: `site/docs/api-reference.md` (the four rows, a **Stats** section with the example question "which Reel of
  October brought the most followers?" answered by `list_performance` sorted by `follows`, then `get_metrics`),
  `site/docs/what-agents-can-do.md`, `site/docs/cli.md`, `site/docs/the-dashboard.md` (the opt-in scope),
  `site/docs/updating.md` (the dropped tables), `docs/architecture.md`, `docs/PLAN.md` ticks (#140, #87, #88),
  changeset (core, api, cli, dashboard, schema minor).
- One MR, `feat(api,cli,schema): stats for agents, a metrics ingest, the old stats tables dropped`, closing #140, #87,
  #88, in the Phase 9 milestone with the `phase-9` label.

## Out of scope

Analysis inside Bongsu; a snapshot-format upload; editing or deleting samples.
