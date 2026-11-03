# @bongsu/dashboard

## 0.3.0

No changes in this release.

## 0.2.0

### Minor Changes

- 839cc12: Stats for agents. Three read tools, MCP and REST at once: `get_metrics` (a post's or video's series with its 24 h
  numbers), `get_account_metrics` (an account's followers and views per day) and `list_performance` (the posts and videos
  of a window, ranked by any count). `ingest_metrics` (`POST /v1/metrics`) uploads samples collected elsewhere into the
  same series, behind a new `metrics` scope: opt-in on an agent key, part of the owner's and admin's rights. The CLI gains
  `bongsu stats` and `bongsu ingest`. Migration 0014 drops the unused `labels` and `manual_stats` tables: an instance that
  imported data from an earlier deployment loses what they held, so take a backup first if you want it.
- 839cc12: CLI tokens: in **Keys & tokens**, each person can make tokens for the `bongsu` command line (30, 90 or 365 days, with a
  passkey check). A token acts as its person with their role's rights, read on every request; it stops at expiry, on
  revoke or when the person leaves the workspace. Needs migration 0009.
- 839cc12: The dashboard at `/dashboard`, for setting up and managing an instance without a terminal. The first person signs up with the `SETUP_TOKEN` secret and a passkey (and gets recovery codes); after that, sign-in is an email and a passkey. Its sections: an overview of what needs attention, connections, OAuth apps, accounts (Trial Reels default, rename, disable), phones and passkeys (add a phone with a QR code), agent keys (created with scopes, shown once) and an audit log. Changes to who can do what ask for the passkey again after 10 minutes.
  
  Accounts are connected from it: bring your own Meta and Google apps (the page shows the redirect URLs to register; their secrets are stored encrypted), then **Connect** Instagram (Instagram Login) or YouTube (Google, with PKCE). Bongsu finds which accounts the grant reaches and creates them, or takes over the ones it has, so a reconnect keeps each account's plan. An Instagram token or a Composio connected-account id can be pasted instead. Removing a connection revokes Google's grant and keeps the accounts.
- 839cc12: A scheduled YouTube video's release date can be moved from the app (with the passkey), from the dashboard's new Videos
  page and from the API, where the opt-in `reschedule` scope allows it. The app's name, theme colour and icons come from
  build inputs (`BONGSU_APP_NAME`, `BONGSU_THEME_COLOR`). The app reads its texts through `t()` from an English catalogue,
  with the workspace's locale on `/app-api/me`.
- 839cc12: Every notification's wording lives in one file (`core/texts/notifications.ts`). The PWA's empty screens point to the
  dashboard's setup and the provider guides when no account is connected, and say where posts come from when there's
  nothing planned. Caption checks can be tuned per account in the dashboard's Accounts page (hashtag cap, first-line
  length, language checks on or off); approving uses the account's rules.

### Patch Changes

- 839cc12: New icons, rebuilt from the vector mark: app icons (any and maskable), Apple touch icon and favicon, plus an SVG
  favicon for browsers that support it. The browser tab shows a simplified mark drawn for small sizes.
- 839cc12: The product is "Bongsu" everywhere: the app's sign-in, notifications and passkey prompts no longer say "Bongsu
  scheduler". The small mark heads both apps and sits above the dashboard's sign-in. The dashboard's overview puts
  "Needs you" first on phones with the numbers in two columns, names each to-do's action, and lines up its cards; status
  pills read "Connected", "Expiring", "Broken"; Remove and Revoke turn red only on hover or focus.
- 839cc12: Get started: after sign-up the dashboard opens a four-step checklist (time zone and digest hour, OAuth apps, a
  connection, the device you approve on), each ticked from what's actually set up; the overview links back to it until
  all four are done.
- 839cc12: The dashboard's guides are the public ones from `site/docs/` (the install, account and reference guides, built into the
  project site at /docs/); the internal pages are no longer bundled.
- 839cc12: The app no longer adds devices or sets an account's Trial Reels default: both live in the dashboard (Devices &
  passkeys, Accounts). The dashboard's Accounts page shows what each account publishes.
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
