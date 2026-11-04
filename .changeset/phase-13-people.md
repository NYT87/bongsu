---
"@bongsu/core": minor
"@bongsu/api": minor
"@bongsu/web": minor
"@bongsu/dashboard": minor
"@bongsu/cloudflare": minor
"@bongsu/node": minor
"@bongsu/schema": minor
---

People, roles, invites and workspaces (Phase 13, part 1).

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
- **Audit.** A workspace's log shows only its own rows; instance admins also read the instance's (new workspaces,
  media stores, OAuth apps, instance admins).
- **Connect from the app.** Admins and creators connect Instagram and YouTube from the app's Settings with the
  instance's OAuth apps; a connection lands in the workspace the flow started from.
- **Pause per workspace.** **Pause this workspace** and **Resume with passkey** act on one workspace; the others go on
  publishing. An agent key's `pause_scheduler` pauses its own workspace, and `get_status` and the digest say so.

Updating an existing instance (migrations 0018 and 0019 run on their own):

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
