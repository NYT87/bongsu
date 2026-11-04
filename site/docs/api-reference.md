# API reference

The keys, scopes, MCP tools and REST endpoints agents use. To connect Claude, start with [Connect Claude](connect-claude.md);
for what an agent may and may not do, see [What agents can do](what-agents-can-do.md).

AI agents (Claude Code, other MCP clients, scripts) work with the plan through the `bongsu` Worker. They can read,
propose drafts, edit the plan and pause. They can never approve, resume or manage keys: those need the owner's passkey.
The one thing a key may do to a video is move a scheduled YouTube release date, and only with the `reschedule` scope.

## API keys

Keys look like `bongsu_<random>`. The database keeps only their sha256, a name and the scopes.

| Scope | Allows |
|---|---|
| `read` | status, queue, items, jobs, notifications, drafts |
| `draft` | create and withdraw drafts |
| `plan` | add, update, remove plan items and their texts; list Shorts comments (the owner approves their text); record manual posts and comments |
| `pause` | pause the scheduler (resuming is owner-only) |
| `reschedule` | move a scheduled YouTube video's release date, at least 1 hour ahead; not given by default |

Create one in the dashboard ([Keys & tokens](the-dashboard.md#keys--tokens)): **Keys & tokens** → **Agent keys** → **Create a key**, name it after the agent or machine using it and tick
its scopes. The key is shown once: store it in the agent's secret store. **Revoke** there stops it at once. (Both ask
for your passkey again when the last check is more than 10 minutes old.)

For an instance without the dashboard, a key can be created in SQL:

```sh
KEY="bongsu_$(openssl rand -hex 24)"
HASH=$(printf %s "$KEY" | sha256sum | cut -d' ' -f1)
pnpm exec wrangler d1 execute bongsu --remote --command \
  "INSERT INTO api_keys (id, name, key_hash, scopes, created_at) VALUES ('$(uuidgen)', 'my-agent', '$HASH', '[\"read\",\"draft\",\"plan\"]', unixepoch())"
echo "$KEY"
```

Each key may make 60 requests a minute.

A key belongs to a workspace (`api_keys.workspace_id`, `default` unless set): it sees and changes only that workspace's
accounts, plan, drafts, jobs and Shorts list. Items of other workspaces look absent (404). Add `workspace_id` to the
`INSERT` above for another workspace.

## CLI tokens

A person's own token for the `bongsu` command line, made in **Keys & tokens** → **Your CLI tokens** (with a
fresh passkey check) for 30, 90 or 365 days. It looks like `bongsu_cli_<random>` and works wherever an agent key does,
but acts as its person, with their role's rights in the workspace, read on every request: an owner's token can also
approve and resume. It stops working when it expires, when it's revoked, or when its person leaves the workspace.
Agent keys never get those rights.

## MCP

`POST /mcp`, JSON-RPC 2.0 (streamable HTTP without sessions), header `Authorization: Bearer bongsu_…`.

Claude Code:

```sh
claude mcp add --transport http bongsu https://<PUBLIC_URL>/mcp --header "Authorization: Bearer $KEY"
```

For clients without remote HTTP support, `bongsu mcp` is a stdio bridge to `/mcp` that uses your CLI profile (see
[the CLI](cli.md)):

```sh
npx bongsu login --url https://<PUBLIC_URL>
claude mcp add bongsu -- npx -y bongsu mcp
```

The CLI is [`bongsu` on npm](https://www.npmjs.com/package/bongsu); see [the CLI](cli.md#install) to run it from a
checkout instead.

## Tools and REST endpoints

| Tool | Scope | REST |
|---|---|---|
| `list_accounts` | read | `GET /v1/accounts` |
| `get_status` | read | `GET /v1/status` |
| `list_queue` | read | `GET /v1/queue?days=&account=&channel=&group=&from=` |
| `queue_groups` | read | `GET /v1/queue/groups?days=` |
| `get_item` | read | `GET /v1/items/<key>` |
| `get_metrics` | read | `GET /v1/items/<key>/metrics?daily=&from=&to=&metrics=` |
| `get_account_metrics` | read | `GET /v1/accounts/<id>/metrics?daily=&from=&to=` |
| `list_performance` | read | `GET /v1/performance?account=&platform=&from=&to=&sort=&limit=` |
| `list_jobs` | read | `GET /v1/jobs?days=` |
| `list_notifications` | read | `GET /v1/notifications?limit=` |
| `list_drafts` | read | `GET /v1/drafts?status=` |
| `create_draft` | draft | `POST /v1/drafts` |
| `withdraw_draft` | draft | `POST /v1/drafts/<id>/withdraw` |
| `plan_add` | plan | `POST /v1/plan` |
| `plan_update` | plan | `POST /v1/plan/update` |
| `plan_remove` | plan | `POST /v1/plan/remove` |
| `record_posted` | plan | `POST /v1/posted` |
| `shorts_add` | plan | `POST /v1/shorts` |
| `record_commented` | plan | `POST /v1/shorts/commented` |
| `pause_scheduler` | pause | `POST /v1/pause` |
| `youtube_reschedule` | reschedule | `POST /v1/youtube/reschedule` |
| `ingest_metrics` | metrics | `POST /v1/metrics` |

MCP clients get the input schemas from `tools/list`.

## Stats

Bongsu serves the numbers; the analysis is the agent's. The numbers are lifetime counts as the platform reported them
at `at` (unix seconds). With `daily`, a point is the growth since the previous sampled day on your clock, `null` for a
day without a sample (not 0). Reach, saves and the follow metrics only come where the platform reports them, and a
video's `follows` (subscribers gained) only for a channel connected with the analytics scope.

- `list_performance` ranks the posts and videos published in a window (default the last 30 days) by any count, its 24 h
  views (`views_24h`) or `published_at`; 50 rows by default, 200 at most; a Trial Reel copy's row follows its Reel's.
- `get_metrics` gives one post's or video's series, its 24 h numbers and its Trial Reel copy's.
- `get_account_metrics` gives an account's followers (sampled once a day) and the views its posts added per day.

"Which Reel of October brought the most followers?" is `list_performance` with `from: 2026-10-01`, `to: 2026-10-31`,
`sort: follows`, then `get_metrics` with `daily: true` for the top rows to see when they came.

**Uploading numbers collected elsewhere.** `ingest_metrics` (scope `metrics`, opt-in) takes
`{ "posts": [{ "key", "at", "views", … }], "accounts": [{ "account", "at", "followers" }] }`, at most 500 rows a call,
`at` ISO 8601 with a zone and at least an hour ago (a newer sample would stand in for the 24 h numbers you are
notified of; recent numbers are the sampler's to take). A post key is a plan key that went out, its `trial:` copy, or
`video:<id>` of one of a channel's 50 latest uploads. A post row needs at least one count, an account row its
`followers`, and an unknown field is refused. Every row is
checked first: one bad row writes nothing and the error names each problem. A sample already there (same key or account
and time) is skipped, so a file can be sent again. The rows land in the same series the sampler fills, so the app's
charts and the tools above read them like sampled ones.

Times are stored in UTC. An agent key works in its workspace's time zone (`get_status` returns it with today's date):

- **Reading:** every time comes twice, `due` on that clock (`2026-10-20 18:00 Asia/Seoul`) and `due_at` as ISO 8601 UTC
  (`2026-10-20T09:00:00Z`). Free-slot suggestions after a clash carry `date`, `time` and `at`.
- **Writing** (`plan_add`, `plan_update`): either `at`, an instant with its zone (`2026-10-20T09:00:00Z` or
  `2026-10-20T18:00+09:00`; one without a zone is refused), or `date` (`YYYY-MM-DD`) and `time` (`HH:MM`) on the
  workspace's clock. No time: Reels 18:00, posts 19:00. In `plan_update` a date alone keeps the time and a time alone
  keeps the date; `date: null` unschedules.

A planned item is a post to one account: `format` is one of its platform's formats (Instagram: `video`, `image`,
`carousel`, `story`), or left out for a post whose media decide at approval (one image, several = a carousel, one
video). `options` holds the platform's choices for the post (Instagram: `location`, `coverMs`, `trial`); unknown
options and values are refused (400). The older `kind` (`reel` / `post`) and top-level `location` still work. Item
keys are opaque ids: use them as returned.

`list_accounts` also says, per account, what its platform calls each format (`formats`), its options and features;
queue items carry `platform` and `label` (what the platform calls the post: "Reel", "Post"…).

`list_accounts` gives the account ids that `plan_add`, `create_draft` and `shorts_add` take.

Texts: `plan_add` / `plan_update` take `caption`, `comment`, `comment2` and `alt`; `shorts_add` takes `text`. A changed
text no longer matches the item's approval, so the owner approves again before it can go out; a Shorts comment's text
is approved the same way, from the Short's page in the app. An approval is good for the account the item was planned
for: removing an item and planning it again for another account needs a new one.

### CLI-only routes

Three REST routes are not tools: MCP never lists them. They exist for the `bongsu` command.

| Route | Needs | What it does |
|---|---|---|
| `GET /v1/approve/<key>` | a CLI token with `approve` (admin, creator, instance admin) | What would be approved: texts, media names and checksums, lint checks, `due`/`due_at`, and a `snapshot` |
| `POST /v1/approve` | the same | Body `{ key, snapshot }`. Approves only if the item still matches the snapshot (else 409 `changed`); answers `{ approved, key, due }` |
| `GET /v1/export?texts=1` | `read` | Every plan item of the workspace as `{ items }`; `texts=1` adds the texts |

An agent key gets 403 on the two approve routes whatever scopes it lists. The approval is recorded as `owner@cli` and
audited.
