# Phase 13, part 1: people, roles, invites and workspaces

Issues: #18 (workspaces: create, rename, archive), #19 (members and invites), #20 (roles in every route), and the
creators' side of #33. Later parts of Phase 13 (their own specs): the dashboard switcher and the PWA picker (#18, #22),
notifications per user (#23), the workspace icon (#34), names (#35), per-workspace OAuth apps and media roots (#21),
isolation tests on every surface (#24). Status: designed in chat 2026-11-04, waiting for review of this spec.

## Intent

Bongsu runs as a small SaaS for both a team and separate clients: one instance, many workspaces, strict separation
between them, roles inside each. A workspace is usually one creator's accounts plus the people who help with them
(a convention, not a rule); a person can be in several workspaces with a role in each; an account belongs to one
workspace. Success: the instance admin creates a workspace and invites its admin; that admin invites an editor and a
creator; the creator signs up in the PWA, connects their own account there and approves their posts; nobody sees or
changes another workspace, and only the instance admin changes what's instance-wide.

## 1. Roles

| | instance admin | admin | editor | creator |
|---|---|---|---|---|
| Scope | every workspace | their workspaces | their workspaces | their workspaces |
| Dashboard | yes | yes | yes | no ("use the app") |
| PWA | yes | yes | yes | yes |
| Instance settings (Media, OAuth apps), Workspaces page | yes | no | no | no |
| Members: invite, change role, remove | yes | yes | no | no |
| Connections, accounts, settings, agent keys (dashboard) | yes | yes | no | no |
| Connect their own accounts (PWA) | yes | yes | no | yes |
| Plan, texts, drafts, release dates | yes | yes | yes | yes |
| Approve, pause, resume (passkey for approve and resume) | yes | yes | no | yes |
| Stats, comments | yes | yes | yes | yes |

- **Instance admin** is `users.instance_admin` (a flag, not a membership). The bootstrap user gets it; an instance
  admin can give it to another user or take it away (never from the last one). They act in any workspace with an
  admin's rights.
- **Workspace roles** are `admin`, `editor`, `creator` (`memberships.role`). The migration turns `owner` into `admin`,
  `approver` into `creator` and `viewer` into `editor`; nothing is deployed, so no person is affected.
- `ROLE_SCOPES` (what a signed-in person's CLI token and app session carry): admin and creator `read, draft, plan,
  pause, reschedule, metrics, approve, resume`; editor `read, draft, plan, reschedule, metrics`. `approve` and
  `resume` still need the passkey in the app; no token ever approves.
- **Agent keys** (API, MCP) don't change: one workspace each, content only, never approve. No user or role endpoints
  on `/v1` or `/mcp`.
- The dashboard's guard becomes three: instance routes (Workspaces, Media, OAuth apps) need `instance_admin`;
  managing routes (members, connections, accounts, settings, keys) need admin (or instance admin); the rest any
  member except creators. A creator's dashboard sign-in is refused with a pointer to the app.

## 2. Pause and resume per workspace

`Pause everything` is one `settings` row today, so pausing stops every workspace. It becomes per workspace:
`workspace_settings.paused` (JSON `{reason, by, at}` or NULL). The tick skips a paused workspace's jobs (the others
run); **Resume with passkey** resumes only that workspace; agents' `pause_scheduler` pauses their key's workspace;
the app, `/v1/status` and the digest say whether *this* workspace is paused. The old instance-wide row is moved to the
default workspace by the migration.

## 3. Members and invites (dashboard → Members, workspace admins)

- **Invite:** an email and a role make a one-time link valid 7 days (`invites`: token hash, workspace, email, role,
  invited_by, created_at, expires_at, used_at, revoked_at). The page always shows the link with **Copy**; with a
  `Mailer` it's also emailed.
- **Accepting** (`/invite/<token>`): a new email sets a name and a passkey and joins with the role; an existing user
  (same email) signs in with their passkey and joins. Neither the page nor any answer says whether an email already
  has an account. Creators finish in the PWA, admins and editors in the dashboard.
- **Change role / remove:** a workspace always keeps one admin (the last one can't be removed or demoted, except by
  the instance admin). Removing a member ends their sessions in that workspace, revokes their CLI tokens there and
  drops their push devices there.
- **Pending invites** listed with **Revoke**; everything audited. Changes ask for a fresh passkey (`FRESH_S`).

## 4. Workspaces (dashboard → Workspaces, instance admins)

- **List** every workspace: name, members, accounts, created, archived.
- **Create:** a name and the first admin's email, which sends that admin an invite. The new workspace gets its
  settings row (time zone from the instance admin's, digest 08:00, English).
- **Rename**, **add an admin** (an invite) to any workspace.
- **Archive / restore:** `workspaces.archived_at`. An archived workspace publishes nothing (the tick skips it, as if
  paused), its members can't open it (sign-in into it refused), agent keys stop working; its data stays. Deleting
  is left out of this phase.
- Until the switcher (part 2), an instance admin opens a workspace from this page: their session's workspace is set
  to it (`sessions.workspace_id`), the same field the switcher will use.
- The sidebar gets an **Instance** group (Workspaces, Media, OAuth apps) shown only to instance admins.

## 5. Creators connect their accounts in the PWA

- The PWA's Settings get **Connect Instagram** and **Connect YouTube** (and Reconnect), for admins and creators, with
  the instance's OAuth apps. The flows are the dashboard's (`startConnect`, `finishConnect`, PKCE, `oauth_states`);
  the callback sends the browser back to the app (`/#/settings?connected=…`) when the flow started there.
- The connection and its accounts belong to the creator's workspace. Without an OAuth app the button explains that
  the instance admin has to add it first.

## Data (one migration, 0018)

- `users.instance_admin` (bool, default 0); the bootstrap user set to 1.
- `memberships.role` values `admin / editor / creator`, existing rows converted.
- `workspaces.archived_at` (timestamp, NULL).
- `workspace_settings.paused` (json, NULL); the `settings` row `paused` moved into the default workspace's.
- `invites` (new table, above).
- `sessions.workspace_id` (text, NULL: the user's first workspace), for the workspace a session works in.

## Tests

Roles: a matrix test per route group (instance, managing, content, approving) for each role, dashboard and PWA, and
creators refused in the dashboard. Invites: new and existing users, expiry, reuse, revoke, wrong workspace, the last
admin. Pause: one workspace paused, the other publishes; resume only its own. Archive: the tick skips it, sign-in and
keys refused. PWA connect: the flow from the app lands the accounts in the creator's workspace. `workspaces.test.ts`
gets the new routes.

## Order of work

1. Migration 0018, roles and `ROLE_SCOPES`, the three dashboard guards, creators out of the dashboard.
2. Pause and resume per workspace.
3. Invites and the Members page.
4. The Workspaces page, archive, the Instance group.
5. Connecting from the PWA.
6. Docs (the dashboard and app guides, security, a "people and roles" section), PLAN, changeset.
