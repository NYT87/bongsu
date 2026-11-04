# Phase 13, part 2: switching workspaces and who gets which notifications

Issues: #18 (the dashboard's workspace switcher), #22 (the app's workspace picker; notifications say which workspace),
#23 (notifications per person and workspace), and the notification part of #24 (isolation tests). Part 1
(`2026-11-04-phase13-people-roles-design.md`) delivered roles, invites, the Workspaces page and per-workspace pause.
Status: designed in chat 2026-11-04, waiting for review of this spec.

## Intent

A person can be in several workspaces with a role in each, for example an agency editor or a creator working for two
clients. They work in one workspace at a time and move between them without going through the Workspaces page.
Their phone tells them what happens in each workspace they're in, limited to what they want to hear. Tapping a
notification opens the app in that notification's workspace.

## Decisions

- **Switching is per session.** The dashboard and the app have their own sessions (`sessions.app`), so each
  remembers its own workspace (`sessions.workspace_id`). Switching in one doesn't move the other.
- **Agent keys and CLI tokens are unchanged:** each stays tied to one workspace.
- **A passkey check belongs to the session**, so a recent check still counts after a switch.
- **Notification settings work by group,** five of them, with defaults by role. A person turns each group on or off
  for each workspace in the app's Settings. Only their changes are stored, and the rest follows their role.
- **One push subscription per device and person.** It receives pushes from every workspace the person is a member
  of, each filtered by that person's groups for that workspace.
- **Only members get a workspace's pushes.** An instance admin acts as admin in every workspace, but gets pushes only
  from the workspaces they're a member of. Instance notices, such as a broken media store, still reach every
  instance admin.
- **The workspace's ntfy topic, the audit log and the connection-problem email are unchanged.** The topic is a shared
  channel and still gets every notification.

## 1. Which workspaces a person can open

A core function, `workspacesOf(db, userId, { notCreator? })` in `packages/core/src/workspaces.ts`, returns
`{ id, name, role }[]`, ordered by name:

- the workspaces the person is a member of that aren't archived, with their role;
- for an instance admin, every other workspace that isn't archived too, with the role `admin` (as `sessionWorkspace`'s
  `roleOf` gives);
- with `notCreator`, which the dashboard uses, the memberships where the person is a creator are left out. Creators
  use the app.

The same rules decide whether a switch is allowed. A shared helper, used by `workspacesOf` and the switch routes,
checks one workspace for one person so that the two can't drift apart.

## 2. The dashboard's switcher (#18)

- The workspace's name in the sidebar header becomes a switcher when `workspacesOf(…, { notCreator: true })` has more
  than one entry. Otherwise it stays plain text.
- `GET /admin-api/state` adds `workspaces: { id, name, role }[]` (the list above).
- `POST /admin-api/session/workspace { id }` checks access with the shared helper. When access is allowed, it calls
  `setSessionWorkspace` and answers `{ ok: true }`. Otherwise it answers 403, and the session keeps its workspace.
  After a switch the client reloads its state and the current page's data, or goes to Overview when the current page
  belongs to the previous workspace (an item, a draft).
- The Workspaces page's **Open** uses this route instead of `/admin-api/workspaces/:id/open`. The old route stays as
  an alias until the next minor version, with a comment saying so.

## 3. The app's picker (#22)

- The app's header shows the current workspace's name. When `workspacesOf` (creators included) has more than one
  entry, tapping the name opens a picker, a sheet listing the workspaces with the person's role in each.
- `GET /app-api/me` adds `workspace: { id, name }` and `workspaces: { id, name, role }[]`.
- `POST /app-api/session/workspace { id }` follows the same rules and answers as the dashboard's route. After a
  switch, the app reloads `me` and goes to the queue.

### Push links open their own workspace

- Every URL in a push (the note's `url` and each action's `url`) gets a `w=<workspaceId>` query parameter. It is added
  in one place, where `notify.ts` builds the push.
- When the app starts or navigates with `w` in the URL and `w` isn't the current workspace, it calls the switch route
  first, then shows the page. If the switch is refused (403), it shows "You're no longer in that workspace" with a
  link to the queue, and the session keeps its workspace.
- The service worker's notification `tag` becomes `<workspaceId>:<target>`. Two workspaces' notes about the same key
  no longer replace each other on the lock screen.
- **A push says which workspace it is from.** For a person in more than one workspace (`workspacesOf`), the push
  title is prefixed with the workspace's name, as in `Demo Studio · demo_travel: published`. For a person in only
  one, the title is unchanged. The ntfy topic belongs to one workspace, so its titles stay as they are. The comment at
  the top of `notify.ts`, which says every message already names its workspace, is corrected to describe this.

## 4. Who gets what (#23)

### Groups

`Note` gets a required `group: NoteGroup`, set by each builder in `packages/core/src/texts/notifications.ts`:

| Group | Builders |
|---|---|
| `needs_you` | `jobHeld`, `shortsWaiting` |
| `problems` | `jobVerdict`, `jobFailed`, `jobRefused`, `providerFailed`, `processingTimeout`, `connectionProblem`, `cleanupRefused` |
| `published` | `published`, `publishedTrial`, `commented`, `dryRunPublish`, `dryRunComment`, `results` |
| `inbox` | `newDrafts`, `newComments`, `releaseMoved` |
| `digest` | `digest` |

`mediaStoreProblem` is an instance notice and goes through the separate instance path (`notifyInstanceAdmins`). It has no
group.

Each builder sets its group so that a new notification can't be added without one: the type requires it.

### Defaults and settings

- **Role defaults** (`packages/core/src/notify-prefs.ts`):
  - admins and creators get every group;
  - editors get every group except `needs_you`, since they can't approve.
- **Stored changes:** a new table, `notify_prefs`:

  | Column | Type |
  |---|---|
  | `workspace_id` | text, not null |
  | `user_id` | text, not null |
  | `grp` | text, not null, one of the five groups |
  | `enabled` | int, 0 or 1 |
  | `updated_at` | timestamp |

  The primary key is (`workspace_id`, `user_id`, `grp`). A row exists only for a group the person changed. Setting a
  group back to its role default deletes the row, so a later role change still moves that group.
- **The effective setting** is the stored row if there is one, else the role default:
  `effectivePrefs(db, workspaceId, userId)`.
- **Removing a member** deletes their `notify_prefs` rows for that workspace. Deleting a workspace isn't possible
  (archiving keeps the rows).

### Sending

- `Notifier.send(note, workspaceId)` keeps its signature.
- The push part (`packages/core/src/push.ts`) changes in four steps:
  1. it reads the workspace's members with their role;
  2. it reads their `notify_prefs` rows for the workspace;
  3. it keeps the members whose effective setting for `note.group` is on, working this out in code so the SQL stays
     portable;
  4. it sends to every `push_subs` row of those people.
- The other caller of `sendPush`, the test push (`POST /app-api/push/test`), sends to the caller's own devices
  regardless of groups. Its audience becomes `{ userId }`.
- The ntfy topic and the audit row don't depend on groups.

### Devices

- `push_subs.workspace_id` is dropped (migration 0021). A row is one device of one person (`endpoint` is already
  unique). Subscribing or unsubscribing no longer depends on the session's workspace.
- The membership check in `push.ts` changes from "member of the subscription's workspace" to "member of the note's
  workspace".

### The app's Settings, Notifications

- This device on or off, as today.
- Five switches for the current workspace, one per group. Each shows whether it follows the role default
  ("default") or the person changed it, with a one-line explanation of the group.
- Under them: "For another workspace, switch to it first", shown only when there are several.
- `GET /app-api/notify-prefs` answers `{ groups: { grp, enabled, isDefault }[] }`.
- `PUT /app-api/notify-prefs { grp, enabled }` answers the same.
- Both act for the caller in their session's workspace, use the `read` scope, and are added to `workspaces.test.ts`.
- The dashboard gets no such page: push lives in the app.

## 5. Edge cases

- **A switch to a workspace the person can no longer open** (removed, archived, or a creator switching in the
  dashboard) gets a 403, and the session keeps its workspace.
- **A session whose workspace was taken away** falls back to the first workspace the person has (`sessionWorkspace`,
  unchanged). The next state or `me` shows the new current workspace.
- **A push for an archived workspace:** none is sent; the tick already skips archived workspaces.
- **Push links from before the update,** without `w`, open in the current workspace as before.
- **A person in exactly one workspace** sees no switcher or picker. The header shows the name only.

## 6. Migration 0021 (neutral schema → SQLite and Postgres)

- It creates `notify_prefs`.
- It drops `push_subs.workspace_id`, which the neutral schema generates for each database. Existing subscriptions are
  kept and, from then on, receive pushes from each workspace their person is a member of.
- `docs/schema.md` is regenerated.

## 7. Tests

**Core unit tests:**
- role defaults;
- the effective setting (a stored row overrides the default; reset deletes the row);
- every builder in `texts/notifications.ts` has a group.

**Cloudflare integration tests (fake world):**
- **Switch routes (both apps):**
  - allowed for a member and for an instance admin;
  - refused for an archived workspace and for a non-member;
  - refused in the dashboard for a creator membership;
  - the session's workspace changes only on success;
  - the Workspaces page's Open still works.
- **Push fan-out:**
  - a note for A never reaches a person who is only in B;
  - a device of a person in A and B gets both workspaces' notes;
  - a muted group is skipped;
  - by default an editor gets no `needs_you`;
  - an instance admin who isn't a member gets none;
  - a removed member's devices stop getting the workspace's notes;
  - push URLs carry `w`, and tags carry the workspace.
- **Prefs routes:** get, put, and reset to default. Both are added to `workspaces.test.ts`.

**Node:** the Postgres test runs migration 0021.

## 8. Docs

- `site/docs/the-app.md`: the picker, and the Notifications settings.
- `site/docs/the-dashboard.md`: the switcher.
- `docs/PLAN.md`: tick the switcher (#18), the picker (#22) and notifications per person (#23), and note which part
  of #24 is covered.
- A changeset (minor) for `core`, `api`, `web`, `dashboard`, `cloudflare`, `node` and `schema`.

## Out of scope (later parts)

- The workspace icon (#34) and display names per workspace (#35).
- Per-workspace OAuth apps and media roots (#21).
- The rest of #24: isolation tests for the cron and the media links.
- Notification settings in the dashboard, and email for anything other than connection problems.
