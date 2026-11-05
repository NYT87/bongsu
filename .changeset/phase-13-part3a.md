---
"@bongsu/core": minor
"@bongsu/api": minor
"@bongsu/web": minor
"@bongsu/dashboard": minor
"@bongsu/cloudflare": minor
"@bongsu/node": minor
"@bongsu/schema": minor
---

A media folder, media stores and OAuth apps per workspace (Phase 13, part 3a).

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
