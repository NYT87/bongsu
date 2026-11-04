# @bongsu/api

## 0.4.0

### Minor Changes

- 057bff6: The ntfy topic is a setting of each workspace: the dashboard's **Settings → Notifications (ntfy)** sets, tests and
  removes it, and only that workspace's notifications go there. It's stored encrypted (it needs `ENCRYPTION_KEY`) and
  the page shows only its server. Bongsu posts to it without following redirects and with a time limit.
  
  To update: `NOTIFY_URL` is gone. If you used it, paste the same topic in the dashboard's Settings (migration `0016`
  adds the column) and remove the variable or secret.
- de54272: Media stores are set up in the dashboard (**Media**), and there can be several side by side.
  
  - **S3-compatible buckets**: AWS S3, Cloudflare R2, Backblaze B2, MinIO. Instagram fetches the files from the bucket
    through presigned links and the app uploads straight to it ([S3-compatible buckets](site/docs/s3.md)).
  - **Connect Google Drive** with your Google app (the one YouTube uses): no service account any more
    ([Google Drive](site/docs/drive.md)).
  - One store of each kind, one of them the default; each file is read from the store it's in, the inbox is read in
    every store, and the app's upload page lets you pick the store. A weekly check marks a store that stopped answering.
  - Get started has a fifth step for it; the app's Settings and `/health` list the stores.
  
  To update: the `MEDIA_STORE`, `DRIVE_SA_JSON` and `DRIVE_OWNER_OAUTH` variables are gone. Set the store up again on the
  dashboard's Media page (Drive with **Connect Google Drive**; on Docker, **This server's disk** for the `local` store),
  and remove those secrets. Migration `0017` adds the `media_store` table. Signed media links now name their store
  (`/m/<store>/<id>`), so links made before the update stop working; they only last a few hours.

### Patch Changes

- 18c6031: Push notifications go only to the members of the workspace they're about: a device belongs to the user who turned
  notifications on and the workspace they did it in, and stops getting them when that user leaves it. **Send a test**
  reaches only your own devices. Push subscriptions are only taken for the browsers' push services, and Bongsu sends to
  them without following redirects and with a time limit. A device subscribed before this update keeps working for the
  default workspace's owner; others turn notifications on again in Settings.
- Updated dependencies [057bff6]
- Updated dependencies [de54272]
- Updated dependencies [18c6031]
  - @bongsu/core@0.4.0

## 0.3.0

### Patch Changes

- @bongsu/core@0.3.0

## 0.2.0

### Minor Changes

- 839cc12: Each account's page. The inbox run samples every account's follower (subscriber) count once a day into a new
  `account_metrics` series (migration 0013); an instance with imported nightly snapshots gets their history once. An
  account's page in the app (Stats → an account) charts its followers (Total | Daily) and its posts' views per day over
  7, 30 or 90 days, and ranks the posts and videos that brought followers. The Stats page reads followers from the
  series. The Stats and reviews routes now show only the caller's workspace's snapshots and reviews (they showed every
  workspace's).
- 839cc12: Accounts and connections live in the database instead of `config.ts`: workspaces, users, memberships, connections (Composio, encrypted credentials or a named secret) and accounts, with the Trial Reels default in each account's settings. The calendar shows any number of YouTube channels.
- 839cc12: Stats for agents. Three read tools, MCP and REST at once: `get_metrics` (a post's or video's series with its 24 h
  numbers), `get_account_metrics` (an account's followers and views per day) and `list_performance` (the posts and videos
  of a window, ranked by any count). `ingest_metrics` (`POST /v1/metrics`) uploads samples collected elsewhere into the
  same series, behind a new `metrics` scope: opt-in on an agent key, part of the owner's and admin's rights. The CLI gains
  `bongsu stats` and `bongsu ingest`. Migration 0014 drops the unused `labels` and `manual_stats` tables: an instance that
  imported data from an earlier deployment loses what they held, so take a backup first if you want it.
- 839cc12: CLI tokens: in **Keys & tokens**, each person can make tokens for the `bongsu` command line (30, 90 or 365 days, with a
  passkey check). A token acts as its person with their role's rights, read on every request; it stops at expiry, on
  revoke or when the person leaves the workspace. Needs migration 0009.
- 839cc12: The `bongsu` command line (`npx bongsu`): `login` with a CLI token, `status`, `queue`, `texts get|set`, `approve`
  (shows what you approve first; only owner, admin and approver tokens can), `export --format json|csv`, `mcp` (a stdio
  bridge to `/mcp`), `schema --dialect sqlite|postgres` and `deploy-secrets`, which replaces `setup-secrets.sh`. The API
  gets two REST-only routes for it, `GET /v1/approve/<key>` with `POST /v1/approve`, and `GET /v1/export`; agent keys
  still can't approve. Messages and the app point to the app or the CLI.
- 839cc12: Providers declare how an account connects (token, OAuth with its endpoints and scopes, or Composio), listed in `/app-api/platforms`, and how their connections stay alive. The weekly check now covers YouTube too: a revoked refresh token marks the channel `broken` and notifies once, instead of failing at the next Shorts comment.
- 839cc12: Platform-neutral content: a planned item has a `format` (one of its platform's formats, or none: decided by its media) and `options` (Instagram's location, cover frame and trial switch moved there; migration 0006). Platforms and providers are registries (`platforms/`, `providers/`): the tick publishes through any provider with resumable start/check/finish steps. `plan_add` / `plan_update` take `format` and `options` (the older `kind` and `location` still work); queue items carry `format` and `options`. Item keys are opaque ids.
- 839cc12: The dashboard at `/dashboard`, for setting up and managing an instance without a terminal. The first person signs up with the `SETUP_TOKEN` secret and a passkey (and gets recovery codes); after that, sign-in is an email and a passkey. Its sections: an overview of what needs attention, connections, OAuth apps, accounts (Trial Reels default, rename, disable), phones and passkeys (add a phone with a QR code), agent keys (created with scopes, shown once) and an audit log. Changes to who can do what ask for the passkey again after 10 minutes.
  
  Accounts are connected from it: bring your own Meta and Google apps (the page shows the redirect URLs to register; their secrets are stored encrypted), then **Connect** Instagram (Instagram Login) or YouTube (Google, with PKCE). Bongsu finds which accounts the grant reaches and creates them, or takes over the ones it has, so a reconnect keeps each account's plan. An Instagram token or a Composio connected-account id can be pasted instead. Removing a connection revokes Google's grant and keeps the accounts.
- 839cc12: The followers a post or video brought. The metrics series gains Instagram's `follows` and `profile_visits`
  (migration 0012; NULL for samples taken before and for media types without them) and, for YouTube, the subscribers a
  video gained through the YouTube Analytics API. The connect flow now asks for the `yt-analytics.readonly` scope:
  add it to your Google app's consent screen and enable the YouTube Analytics API, then **Reconnect** each channel
  from the dashboard; until then a video's Results view says the subscriber numbers aren't available. The 24 h
  notification and the Results view show "+12 followers · 85 profile visits" (a Trial Reel copy its own), and the
  metric picker gains Followers and Profile visits (Subscribers for a video).
- 839cc12: Media goes through a `MediaStore` interface (Drive is the first store; `docs/media-stores.md`). Migration 0004 turns media references into `{store, id, checksum}` (approvals, queued jobs, plan items, drafts) and keys `inbox_seen` and `media_cleanup` (was `drive_cleanup`) by store and id; existing Drive references keep their id and md5, so approvals stay valid. Drafts made by agents take file ids in the instance's store.
- 839cc12: Results over time: the inbox cron samples each published Instagram post (and its Trial Reel copy) and each public
  YouTube upload into a new `post_metrics` series, every 6 hours for 3 days, daily to day 30, weekly to day 90, a few
  per run (YouTube through `videos.list`, 1 quota unit per channel per run). A published item's page splits into
  **Results | Post** (a YouTube video's into **Results | Video**): the 24 h numbers, now the sample nearest 24 hours
  after publishing, and a line chart, Total or Daily, of views, reach, likes, comments, saves or shares, with the Trial
  Reel as a second line. The 24 h notification's **Open results** opens it. New routes `GET /app-api/item/metrics` and
  `GET /app-api/video/metrics`.
  
  Needs migration 0011, which adds `post_metrics` and drops the six count columns from `post_results`, keeping only the
  median and the marker that the 24 h notification went out. Each earlier 24 h result becomes that post's first sample
  (taken when it was fetched), so posts keep their numbers through the upgrade.
- 839cc12: A scheduled YouTube video's release date can be moved from the app (with the passkey), from the dashboard's new Videos
  page and from the API, where the opt-in `reschedule` scope allows it. The app's name, theme colour and icons come from
  build inputs (`BONGSU_APP_NAME`, `BONGSU_THEME_COLOR`). The app reads its texts through `t()` from an English catalogue,
  with the workspace's locale on `/app-api/me`.
- 839cc12: Every notification's wording lives in one file (`core/texts/notifications.ts`). The PWA's empty screens point to the
  dashboard's setup and the provider guides when no account is connected, and say where posts come from when there's
  nothing planned. Caption checks can be tuned per account in the dashboard's Accounts page (hashtag cap, first-line
  length, language checks on or off); approving uses the account's rules.
- 839cc12: The app names posts the way each platform does: platforms declare `labels` ("Reel", "Short", "Post") and an account noun, the new `/app-api/platforms` serves them, and the app takes every name, dot and Instagram-only control (cover frame, location, Trial Reel) from it. Calendar events carry `platform`, `format` and `label` instead of `kind`; queue items and the item page carry `platform` and `label`; `list_accounts` says what each account's platform calls its formats, plus its options and features. The daily digest counts per platform.
- 0af344f: The Stats tab reads only what Bongsu collects or receives: each account's followers from the account series, then the last 7 days' posts and videos, most viewed first, each opening its Results or video page. The snapshot Performance page and the review pages are gone with their routes (`/app-api/performance`, `/app-api/report`), and migration 0015 drops the `reports` table (export it first if an instance imported reviews). The `snapshots` table stays: it backfills the account series once.
- 839cc12: Times are stored in UTC (migration 0003: `plan_items.due_at`, `approvals.due_at`, `posted.published_at`); time zones only apply when showing and entering them. Each user can pick their own zone in Settings (the workspace's is the default, and agent keys use it). The API returns `due` on the caller's clock plus `due_at` in ISO 8601 UTC, `plan_add`/`plan_update` also take `at` (an instant with its zone), and the queue returns `until` instead of `until_kst`.
- 839cc12: Agent keys work within their workspace: plan items, drafts, jobs, the Shorts list and accounts of other workspaces are invisible to them. New `list_accounts` tool (`GET /v1/accounts`); `shorts_add` takes the comment's text without needing a file. Approvals and the audit log record the user.
- 839cc12: Plan dates and times follow the workspace's time zone (daylight saving included) instead of one fixed zone; the daily digest is sent from the workspace's digest hour. API times now end with the zone name, and `get_status` returns `today` and `timezone`.

### Patch Changes

- 839cc12: The product is "Bongsu" everywhere: the app's sign-in, notifications and passkey prompts no longer say "Bongsu
  scheduler". The small mark heads both apps and sits above the dashboard's sign-in. The dashboard's overview puts
  "Needs you" first on phones with the numbers in two columns, names each to-do's action, and lines up its cards; status
  pills read "Connected", "Expiring", "Broken"; Remove and Revoke turn red only on hover or focus.
- 839cc12: Get started: after sign-up the dashboard opens a four-step checklist (time zone and digest hour, OAuth apps, a
  connection, the device you approve on), each ticked from what's actually set up; the overview links back to it until
  all four are done.
- 839cc12: `/health` asks for a connection kind's secret only when such a connection exists: `COMPOSIO_CONSUMER_KEY` with a Composio connection, `ENCRYPTION_KEY` with an instagram-graph one. An instance on Instagram's own API needs no Composio key.
- 839cc12: Bongsu runs on Node: `apps/node` serves the app, the dashboard and the APIs, runs the three schedules with node-cron
  and keeps everything in one SQLite file (migrations applied at start). New: a `local` media store (a directory,
  `MEDIA_STORE=local`, `MEDIA_DIR`) and an `smtp` mailer on Node. The schedules now live in one place
  (`core/schedules.ts`), shared with the Cloudflare cron Worker; `/health` asks only for the secrets the media store in
  use needs.
- 839cc12: The dashboard overview's "Waiting for approval" now counts what the app's Needs you lists: upcoming items with no
  approval and those approved for another time (re-approve), not only the never-approved ones.
- 839cc12: A passkey only confirms its own user's action. Approving, resuming and moving a YouTube release in the app (and the
  dashboard's fresh passkey check) now refuse another member's passkey registered on the same device, and the app only
  offers the signed-in user's passkeys for them.
- 839cc12: Postgres: on Node and Docker, `DATABASE_URL=postgres://…` runs Bongsu on Postgres (the compose file's `postgres`
  profile starts one); the tables come from `migrations/postgres/`, seed rows included. The app's SQL now works on both:
  the database-specific bits live in `core/sql.ts`, and the queries Postgres rejected (untyped `IS NULL` parameters,
  ambiguous names in upserts, the reserved `window`) are fixed.
- 839cc12: The app no longer adds devices or sets an account's Trial Reels default: both live in the dashboard (Devices &
  passkeys, Accounts). The dashboard's Accounts page shows what each account publishes.
- 839cc12: Recovery-code sign-in in the dashboard allows five tries per email in 15 minutes, right or wrong, so the codes can't
  be guessed.
- 839cc12: `GET /app-api/me` answers the signed-in role's scopes, and the app shows a scheduled YouTube video's Release date card only to someone who can move it (owners and admins); other roles no longer see a card that answers 403.
- 839cc12: Accounts can be removed from the dashboard once disabled and with nothing left to publish; published history stays.
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
- 839cc12: The dashboard and the app work as the signed-in user, in their workspace: accounts, connections, agent keys, settings,
  the audit log, items, drafts and approvals. Connecting saves to that workspace; approvals record the user.
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
  - @bongsu/core@0.2.0

## 0.1.0

### Minor Changes

- First version of Bongsu, generalized from a working personal deployment: scheduled Instagram Reels, posts, carousels, stories and Trial Reels, YouTube Shorts comments, passkey approvals, the agent API (REST and MCP), the Drive inbox and the phone app, as a pnpm monorepo (core, api, web, cloudflare).

### Patch Changes

- Updated dependencies
  - @bongsu/core@0.1.0
