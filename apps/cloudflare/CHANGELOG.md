# @bongsu/cloudflare

## 0.3.0

### Patch Changes

- @bongsu/api@0.3.0
  - @bongsu/core@0.3.0

## 0.2.0

### Minor Changes

- 839cc12: Accounts and connections live in the database instead of `config.ts`: workspaces, users, memberships, connections (Composio, encrypted credentials or a named secret) and accounts, with the Trial Reels default in each account's settings. The calendar shows any number of YouTube channels.
- 839cc12: Platform-neutral content: a planned item has a `format` (one of its platform's formats, or none: decided by its media) and `options` (Instagram's location, cover frame and trial switch moved there; migration 0006). Platforms and providers are registries (`platforms/`, `providers/`): the tick publishes through any provider with resumable start/check/finish steps. `plan_add` / `plan_update` take `format` and `options` (the older `kind` and `location` still work); queue items carry `format` and `options`. Item keys are opaque ids.
- 839cc12: The dashboard at `/dashboard`, for setting up and managing an instance without a terminal. The first person signs up with the `SETUP_TOKEN` secret and a passkey (and gets recovery codes); after that, sign-in is an email and a passkey. Its sections: an overview of what needs attention, connections, OAuth apps, accounts (Trial Reels default, rename, disable), phones and passkeys (add a phone with a QR code), agent keys (created with scopes, shown once) and an audit log. Changes to who can do what ask for the passkey again after 10 minutes.
  
  Accounts are connected from it: bring your own Meta and Google apps (the page shows the redirect URLs to register; their secrets are stored encrypted), then **Connect** Instagram (Instagram Login) or YouTube (Google, with PKCE). Bongsu finds which accounts the grant reaches and creates them, or takes over the ones it has, so a reconnect keeps each account's plan. An Instagram token or a Composio connected-account id can be pasted instead. Removing a connection revokes Google's grant and keeps the accounts.
- 839cc12: Instagram providers: each account posts through its connection's provider, `instagram-graph` (Instagram's own API with the account's token; Trial Reels for every account) or `instagram-composio` (as before). The inbox cron renews instagram-graph tokens weekly, keeps the renewed token encrypted, and marks a connection `expiring` or `broken` (with one notification) when renewal fails. Migration 0005 allows `instagram` connections. Setup: `site/docs/instagram-graph.md`.
- 839cc12: Media goes through a `MediaStore` interface (Drive is the first store; `docs/media-stores.md`). Migration 0004 turns media references into `{store, id, checksum}` (approvals, queued jobs, plan items, drafts) and keys `inbox_seen` and `media_cleanup` (was `drive_cleanup`) by store and id; existing Drive references keep their id and md5, so approvals stay valid. Drafts made by agents take file ids in the instance's store.
- 839cc12: Times are stored in UTC (migration 0003: `plan_items.due_at`, `approvals.due_at`, `posted.published_at`); time zones only apply when showing and entering them. Each user can pick their own zone in Settings (the workspace's is the default, and agent keys use it). The API returns `due` on the caller's clock plus `due_at` in ISO 8601 UTC, `plan_add`/`plan_update` also take `at` (an instant with its zone), and the queue returns `until` instead of `until_kst`.
- 839cc12: Agent keys work within their workspace: plan items, drafts, jobs, the Shorts list and accounts of other workspaces are invisible to them. New `list_accounts` tool (`GET /v1/accounts`); `shorts_add` takes the comment's text without needing a file. Approvals and the audit log record the user.
- 839cc12: Plan dates and times follow the workspace's time zone (daylight saving included) instead of one fixed zone; the daily digest is sent from the workspace's digest hour. API times now end with the zone name, and `get_status` returns `today` and `timezone`.

### Patch Changes

- 839cc12: An optional Mailer (`MAILER = "resend"`, `MAIL_FROM`, the `RESEND_API_KEY` secret): connection alerts are also emailed
  to the workspace's owners and admins. Off by default. The alert now points to the dashboard's Connections page.
- 839cc12: The database schema is written once (`packages/schema`) and generated per database: `migrations/sqlite/` (the existing
  0001–0009, unchanged, so current databases need nothing) and `migrations/postgres/`, plus `docs/schema.md` and
  `schema.json`. Wrangler, the Node runner and the image now read `migrations/sqlite/`.
- 839cc12: Bongsu runs on Node: `apps/node` serves the app, the dashboard and the APIs, runs the three schedules with node-cron
  and keeps everything in one SQLite file (migrations applied at start). New: a `local` media store (a directory,
  `MEDIA_STORE=local`, `MEDIA_DIR`) and an `smtp` mailer on Node. The schedules now live in one place
  (`core/schedules.ts`), shared with the Cloudflare cron Worker; `/health` asks only for the secrets the media store in
  use needs.
- 839cc12: Security review fixes. Approvals now name the account they were given for (migration 0010 fills it in for existing
  ones); a Shorts comment needs the owner's approval of its text, from the Short's page in the app, before the scheduler
  posts it; the comments under a live post are hashed again before posting and skipped when they changed after
  approval; the plan is asked again (still there, same time, same account, released, account enabled) before a container
  made earlier is published (a job whose item is on hold is held, without taking one of the tick's slots, and goes on
  once released), and dry run stops a job already under way. The comments inbox, replies, manual post records and Trial
  Reel records stay within the caller's workspace; account ids are unique across the instance. A member's role now gates
  approving, resuming, pausing and plan changes in the app, and instance changes in the dashboard take an owner or admin.
  The local media store refuses symlinks leading outside its folder; an Instagram post whose permalink lookup fails
  keeps its media id instead of being published again.
- Updated dependencies [839cc12]
- Updated dependencies [839cc12]
- Updated dependencies [839cc12]
- Updated dependencies [839cc12]
- Updated dependencies [839cc12]
- Updated dependencies [839cc12]
- Updated dependencies [839cc12]
- Updated dependencies [839cc12]
- Updated dependencies [839cc12]
- Updated dependencies [839cc12]
- Updated dependencies [839cc12]
- Updated dependencies [839cc12]
- Updated dependencies [839cc12]
- Updated dependencies [839cc12]
- Updated dependencies [6b61b80]
- Updated dependencies [839cc12]
- Updated dependencies [839cc12]
- Updated dependencies [839cc12]
- Updated dependencies [839cc12]
- Updated dependencies [839cc12]
- Updated dependencies [839cc12]
- Updated dependencies [839cc12]
- Updated dependencies [839cc12]
- Updated dependencies [839cc12]
- Updated dependencies [839cc12]
- Updated dependencies [839cc12]
- Updated dependencies [839cc12]
- Updated dependencies [839cc12]
- Updated dependencies [839cc12]
- Updated dependencies [839cc12]
- Updated dependencies [0af344f]
- Updated dependencies [839cc12]
- Updated dependencies [839cc12]
- Updated dependencies [839cc12]
- Updated dependencies [839cc12]
  - @bongsu/core@0.2.0
  - @bongsu/api@0.2.0

## 0.1.0

### Minor Changes

- First version of Bongsu, generalized from a working personal deployment: scheduled Instagram Reels, posts, carousels, stories and Trial Reels, YouTube Shorts comments, passkey approvals, the agent API (REST and MCP), the Drive inbox and the phone app, as a pnpm monorepo (core, api, web, cloudflare).

### Patch Changes

- Updated dependencies
  - @bongsu/core@0.1.0
  - @bongsu/api@0.1.0
