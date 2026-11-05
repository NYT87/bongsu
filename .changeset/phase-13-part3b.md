---
"@bongsu/core": minor
"@bongsu/api": minor
"@bongsu/web": minor
"@bongsu/dashboard": minor
"@bongsu/cloudflare": minor
"@bongsu/node": minor
"@bongsu/schema": minor
---

A workspace icon, and people's names per workspace (Phase 13, part 3b).

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
