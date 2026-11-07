# @bongsu/cloudflare

## 0.6.0

### Patch Changes

- Updated dependencies [d0ea1b3]
  - @bongsu/core@0.6.0
  - @bongsu/api@0.6.0

## 0.5.0

### Minor Changes

- 3d22c04: Switching workspaces and notifications per person (Phase 13, part 2).
  
  - **Switching.** Someone who can open more than one workspace switches in the dashboard's sidebar and in the app's
    header, which opens a bottom sheet. The two session routes are `POST /admin-api/session/workspace` and
    `POST /app-api/session/workspace` (a session cookie only: agent keys can't switch); `state` and `me` now carry
    `workspace` and `workspaces`. `POST /admin-api/workspaces/:id/open` stays as an alias until the next minor version.
  - **Pushes for every workspace.** A device's subscription belongs to its person and gets the notifications of every
    workspace they're a member of. Links carry `?w=<id>` and open in that workspace; a person no longer in it sees
    "You're no longer in that workspace." Tags are `<workspace>:<target>`, and when you can open more than one workspace
    the title starts with `Workspace name · `. Instance admins get pushes only from the workspaces they're members of
    (and the prefix, since they can open them all).
  - **Notification groups.** Five groups per person and workspace: **Needs you**, **Problems**, **Published and
    results**, **New drafts and comments** and **Daily digest**, set in the app's Settings → Notifications. Admins and
    creators get all five by default; editors get all but **Needs you**. Setting a group back to its default follows the
    role again. The workspace's ntfy topic and the audit log still get everything. Removing a member deletes their
    settings for that workspace, and their devices stop getting its pushes.
  
  Updating an existing instance (migration 0021 runs on its own):
  
  - Existing devices now get pushes from every workspace their person is in, not only the one they subscribed in.
  - Editors no longer get `needs_you` pushes (posts held past their time, and Shorts comments waiting for a working
    connection) by default; an editor who wants them turns **Needs you** on in Settings → Notifications.
  - The Workspaces page's **Open** still works; the sidebar's switcher does the same for anyone in several workspaces.
- aa8968a: A media folder, media stores and OAuth apps per workspace (Phase 13, part 3a).
  
  - **Media folder.** Each workspace has its own: the slug of the workspace's name (`demo-travel`) for one created since, `UPLOADS` for a workspace
    kept from before this release, editable by its admins in Settings → Media (Bongsu never moves files). Inside it: `inbox/<project>/`,
    `<project>/…`, `_posted/`, and the app's uploads in `_uploads/` (they were a top folder, "Bongsu app uploads").
  - **Stores.** Besides the instance's, a workspace's admins add their own S3 bucket or Google Drive in Settings → Media.
    A workspace's default is its own store if it has one, else the instance's. A file reference must be in the caller's
    workspace (its own store, or inside its folder in an instance store), else it's refused with "not in this
    workspace's media". S3 ids and paths with `.`, `..` or empty segments are refused, and a redirect from an S3
    endpoint is an error, never followed. A broken store of a workspace
    is told to that workspace and links to Settings → Media. Agent API `create_draft` file ids are in the key's
    workspace's default store.
  - **OAuth apps.** A workspace can set its own Meta and Google apps in Settings → OAuth apps; a connection uses it if
    set, else the instance's, and keeps the one it started with. The redirect URLs are the same.
  - **Inbox.** Scans each workspace's `<folder>/inbox` in its stores, at most `INBOX_WORKSPACES_PER_RUN` workspaces per
    run, in turn (default 3 on Cloudflare, 20 on Node, at most 100; set at deploy time). The "inbox workspace" picker on
    the Media page is gone.
  - **Scheduler.** The Workspaces page has a read-only Scheduler section for instance admins: the three runs and
    their times, `JOBS_PER_TICK`, `INBOX_WORKSPACES_PER_RUN`, the last inbox run, and whether the schedules are off
    (`SCHEDULES=off` on Node). Making the schedule tunable is #64.
  - **Dashboard.** Get started's media step needs an instance store (a workspace's own bucket doesn't count).
    Settings has General, Media and OAuth apps tabs (`/dashboard/settings`, `/settings/media`,
    `/settings/apps`).
  
  Updating an existing instance (the migrations run on their own):
  
  - Nothing moves: a workspace kept from before this release keeps `UPLOADS`, and the app's uploads from before stay in "Bongsu app uploads"
    where they are; new uploads go to `_uploads/`.
  - New workspaces get a folder named from their name: create it in the store (or change it in Settings → Media) before
    dropping files in its inbox.
  - The inbox workspace chosen on a store is no longer used: each workspace's inbox goes to that workspace.
  - Optionally set `INBOX_WORKSPACES_PER_RUN` (in `[vars]` of `wrangler.cron.toml`, or `.env` on Node).
- 6348d13: A workspace icon, and people's names per workspace (Phase 13, part 3b).
  
  - **Icon.** A workspace's admins set an optional icon in the dashboard's Settings: a square PNG, 192 to 1024 pixels,
    at most 200 KB (`PUT` and `DELETE /admin-api/settings/icon`). It shows beside the workspace's name in the dashboard's
    sidebar, in the app's header and workspace picker, and in its push notifications. It is served, public, at `/icon/<hash>.png`.
    The installed app's icon stays the instance's. `iconUrl` is now part of `state`, `me` and the settings.
  - **Names.** You set your own name in the app's Settings → You, and a name each workspace shows for you
    (`POST /app-api/me/name` and `/app-api/me/display-name`); an admin can edit a member's name for their workspace
    (`POST /admin-api/members/:userId/name`). Approvals ("Approved by"), pauses ("Paused by"), drafts, moved releases, the
    member list and the audit log name people this way. Agents see `paused_by`, `approval.approved_by` and each draft's
    `by`.
  
  Updating an existing instance (migration 0023 runs on its own): nothing to do. No workspace has an icon and nobody has
  a display name until someone sets one; people are shown by their name, else the start of their email, as before.
- c6add56: People, roles, invites and workspaces (Phase 13, part 1).
  
  - **Roles.** A person is an **admin**, an **editor** or a **creator** in each workspace, and the instance has **instance
    admins**. Admins run their workspace (connections, accounts, keys, settings, members); editors work on the plan,
    texts and drafts and read the rest, with no approving, pausing or connecting; creators use the app, where they plan,
    approve, pause, resume and connect their own accounts, and are pointed there when they sign in to the dashboard.
    Instance admins also get an **Instance** group: Workspaces, Media and OAuth apps.
  - **First run.** The setup token makes an instance admin, a user who belongs to no workspace, and the dashboard asks
    for the first workspace (a name, its time zone, its first admin: you or an email). Nothing lands in a workspace nobody
    chose: an inbox draft goes to the workspace whose plan has its project, else to the store's new **Inbox feeds**
    workspace (dashboard, Media), else it waits; a broken store is told to the instance admins.
  - **Members and invites.** A workspace's admins invite people by email with a role: a one-time link for 7 days, always
    shown to copy and emailed when a mailer is set. Admins and editors join in the dashboard, creators in the app, with
    a new passkey or the one they have. Admins change roles and remove members (cut off at once, and the invites they
    sent as an admin revoked); a workspace always keeps one admin. Instance admins make a member an instance admin, or
    stop them being one, from Members.
  - **Workspaces page.** Instance admins list, create, rename, archive and restore workspaces, add an admin and open one
    to work in it. An archived workspace stops completely (nothing publishes, keys and members are refused, no digest,
    no comments or metrics read). A workspace's own admins rename it in Settings. An instance admin in no workspace
    lands on the Instance pages.
  - **Audit.** A workspace's log shows only its own rows, each naming the person who acted, in the app as in the
    dashboard; instance admins also read the instance's (new workspaces, media stores, OAuth apps, instance admins).
  - **Connect from the app.** Admins and creators connect Instagram and YouTube from the app's Settings with the
    instance's OAuth apps; a connection lands in the workspace the flow started from.
  - **Connect flows stay in their browser.** Every OAuth flow (Instagram and YouTube from the dashboard or the app,
    Connect Google Drive) sets a short-lived cookie in the browser that started it, and the callback finishes it only in
    that browser: a provider link sent to someone else can no longer connect their account into your workspace. A flow
    someone started before the update is refused; start it again.
  - **Pause per workspace.** **Pause this workspace** and **Resume with passkey** act on one workspace; the others go on
    publishing. An agent key's `pause_scheduler` pauses its own workspace, and `get_status` and the digest say so.
  
  Updating an existing instance (migrations 0018, 0019 and 0020 run on their own):
  
  - Roles are converted: `owner` becomes `admin`, `approver` becomes `creator` and `viewer` becomes `editor`. People who
    were owners also become instance admins, so they keep Media, OAuth apps and the new Workspaces page; make anyone
    else an instance admin (**Make instance admin** in Members) only if they should have them.
  - Existing `approver`s become creators and so use the app, not the dashboard; if one needs the dashboard, change their
    role to editor or admin in Members.
  - The `default` workspace stays (it has your data), and so does its first admin. A fresh instance has no `default`
    workspace and no `owner` user: its first user is the one who signs up with the setup token.
  - The old instance-wide pause moves to the `default` workspace; any other workspace is not paused.
  - Each media store keeps feeding `default` from its inbox (**Inbox feeds**), as before; change it in the dashboard,
    Media, if another workspace should receive them.
  - Signed-in sessions keep working and open the person's first workspace. A person who belongs to several workspaces
    works in the first until a switcher arrives; an instance admin opens another from the Workspaces page.
  - Agent keys and CLI tokens are unchanged, except that a CLI token carries its person's new role.

### Patch Changes

- Updated dependencies [3d22c04]
- Updated dependencies [aa8968a]
- Updated dependencies [6348d13]
- Updated dependencies [c6add56]
  - @bongsu/core@0.5.0
  - @bongsu/api@0.5.0

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

- Updated dependencies [057bff6]
- Updated dependencies [de54272]
- Updated dependencies [18c6031]
  - @bongsu/core@0.4.0
  - @bongsu/api@0.4.0

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
