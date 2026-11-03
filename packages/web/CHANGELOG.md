# @bongsu/web

## 0.2.0

### Minor Changes

- 839cc12: Each account's page. The inbox run samples every account's follower (subscriber) count once a day into a new
  `account_metrics` series (migration 0013); an instance with imported nightly snapshots gets their history once. An
  account's page in the app (Stats → an account) charts its followers (Total | Daily) and its posts' views per day over
  7, 30 or 90 days, and ranks the posts and videos that brought followers. The Stats page reads followers from the
  series. The Stats and reviews routes now show only the caller's workspace's snapshots and reviews (they showed every
  workspace's).
- 839cc12: Accounts and connections live in the database instead of `config.ts`: workspaces, users, memberships, connections (Composio, encrypted credentials or a named secret) and accounts, with the Trial Reels default in each account's settings. The calendar shows any number of YouTube channels.
- 839cc12: The dashboard at `/dashboard`, for setting up and managing an instance without a terminal. The first person signs up with the `SETUP_TOKEN` secret and a passkey (and gets recovery codes); after that, sign-in is an email and a passkey. Its sections: an overview of what needs attention, connections, OAuth apps, accounts (Trial Reels default, rename, disable), phones and passkeys (add a phone with a QR code), agent keys (created with scopes, shown once) and an audit log. Changes to who can do what ask for the passkey again after 10 minutes.
  
  Accounts are connected from it: bring your own Meta and Google apps (the page shows the redirect URLs to register; their secrets are stored encrypted), then **Connect** Instagram (Instagram Login) or YouTube (Google, with PKCE). Bongsu finds which accounts the grant reaches and creates them, or takes over the ones it has, so a reconnect keeps each account's plan. An Instagram token or a Composio connected-account id can be pasted instead. Removing a connection revokes Google's grant and keeps the accounts.
- 839cc12: The followers a post or video brought. The metrics series gains Instagram's `follows` and `profile_visits`
  (migration 0012; NULL for samples taken before and for media types without them) and, for YouTube, the subscribers a
  video gained through the YouTube Analytics API. The connect flow now asks for the `yt-analytics.readonly` scope:
  add it to your Google app's consent screen and enable the YouTube Analytics API, then **Reconnect** each channel
  from the dashboard; until then a video's Results view says the subscriber numbers aren't available. The 24 h
  notification and the Results view show "+12 followers · 85 profile visits" (a Trial Reel copy its own), and the
  metric picker gains Followers and Profile visits (Subscribers for a video).
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
- 839cc12: Plan dates and times follow the workspace's time zone (daylight saving included) instead of one fixed zone; the daily digest is sent from the workspace's digest hour. API times now end with the zone name, and `get_status` returns `today` and `timezone`.

### Patch Changes

- 839cc12: New icons, rebuilt from the vector mark: app icons (any and maskable), Apple touch icon and favicon, plus an SVG
  favicon for browsers that support it. The browser tab shows a simplified mark drawn for small sizes.
- 839cc12: The product is "Bongsu" everywhere: the app's sign-in, notifications and passkey prompts no longer say "Bongsu
  scheduler". The small mark heads both apps and sits above the dashboard's sign-in. The dashboard's overview puts
  "Needs you" first on phones with the numbers in two columns, names each to-do's action, and lines up its cards; status
  pills read "Connected", "Expiring", "Broken"; Remove and Revoke turn red only on hover or focus.
- 839cc12: The Drafts page puts the kind and account beside the draft's title again, instead of running them into it.
- 839cc12: Media goes through a `MediaStore` interface (Drive is the first store; `docs/media-stores.md`). Migration 0004 turns media references into `{store, id, checksum}` (approvals, queued jobs, plan items, drafts) and keys `inbox_seen` and `media_cleanup` (was `drive_cleanup`) by store and id; existing Drive references keep their id and md5, so approvals stay valid. Drafts made by agents take file ids in the instance's store.
- 839cc12: The app no longer adds devices or sets an account's Trial Reels default: both live in the dashboard (Devices &
  passkeys, Accounts). The dashboard's Accounts page shows what each account publishes.
- 839cc12: `GET /app-api/me` answers the signed-in role's scopes, and the app shows a scheduled YouTube video's Release date card only to someone who can move it (owners and admins); other roles no longer see a card that answers 403.
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

## 0.1.0

### Minor Changes

- First version of Bongsu, generalized from a working personal deployment: scheduled Instagram Reels, posts, carousels, stories and Trial Reels, YouTube Shorts comments, passkey approvals, the agent API (REST and MCP), the Drive inbox and the phone app, as a pnpm monorepo (core, api, web, cloudflare).
