---
"@bongsu/core": minor
"@bongsu/api": minor
"@bongsu/web": minor
"@bongsu/dashboard": minor
"@bongsu/cloudflare": minor
"@bongsu/node": minor
"@bongsu/schema": minor
---

Switching workspaces and notifications per person (Phase 13, part 2).

- **Switching.** Someone who can open more than one workspace switches in the dashboard's sidebar and in the app's
  header, which opens a bottom sheet. The two session routes are `POST /admin-api/session/workspace` and
  `POST /app-api/session/workspace` (a session cookie only: agent keys can't switch); `state` and `me` now carry
  `workspace` and `workspaces`. `POST /admin-api/workspaces/:id/open` stays as an alias until the next minor version.
- **Pushes for every workspace.** A device's subscription belongs to its person and gets the notifications of every
  workspace they're a member of. Links carry `?w=<id>` and open in that workspace; a person no longer in it sees
  "You're no longer in that workspace." Tags are `<workspace>:<target>`, and when you can open more than one workspace
  the title starts with `Workspace name · `. Instance admins get pushes only from the workspaces they're members of
  (and the prefix, since they can open them all).
- **Notification groups.** Five groups per person and workspace: **Needs you**, **Problems**, **Published**, **Inbox**
  and **Digest**, set in the app's Settings → Notifications. Admins and creators get all five by default; editors get
  all but **Needs you**. Setting a group back to its default follows the role again. The workspace's ntfy topic and
  the audit log still get everything. Removing a member deletes their settings for that workspace, and their devices
  stop getting its pushes.

Updating an existing instance (migration 0021 runs on its own):

- Existing devices now get pushes from every workspace their person is in, not only the one they subscribed in.
- Editors no longer get `needs_you` pushes (approvals and overdue items) by default; an editor who wants them turns
  **Needs you** on in Settings → Notifications.
- The Workspaces page's **Open** still works; the sidebar's switcher does the same for anyone in several workspaces.
