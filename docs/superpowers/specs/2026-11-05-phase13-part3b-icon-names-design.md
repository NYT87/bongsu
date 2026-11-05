# Phase 13, part 3b: a workspace icon, and people's names per workspace

Issues: #34 (workspace icon), #35 (your name, and a display name per workspace). Builds on part 3a (`aa8968a`).

## Goal

- A workspace can have its own icon, set by its admins. The app's header, the workspace picker, the dashboard's
  switcher and that workspace's pushes show it. The installed app's icon and the manifest stay the instance's.
- A person can change their own name, and be called differently in each workspace. Everywhere Bongsu names a person,
  it uses the name meant for that workspace.

## Decisions (with the owner)

| # | Decision |
|---|---|
| D1 | The icon lives in the database, not the media store: it is a setting, the server can't write to stores, and serving it through S3 or Drive on every page load is slow. AGENTS.md's "One source of truth" gets one line saying so. |
| D2 | People edit their own name and display name in the app's Settings; owners and admins edit any member's display name on the dashboard's Members page. |
| D3 | Besides the places that name people today, 3b names the approver, who paused, a draft's author, and who moved a release. |

## 1. Workspace icon

### Storage

New table `workspace_icons`:

| Column | Type | Notes |
|---|---|---|
| `workspace_id` | text, PK, FK → `workspaces.id` | one icon per workspace |
| `png` | text, not null | the PNG's bytes, base64 (same on SQLite and Postgres) |
| `hash` | text, not null, unique | SHA-256 of the bytes, lowercase hex |
| `updated_at` | integer, not null | unix seconds |

No icon means no row.

### Rules (core, no new dependency)

`checkIcon(bytes: Uint8Array): { width: number }` in `packages/core/src/icon.ts` throws an `IconError` whose message
says why:

- the PNG signature (`89 50 4E 47 0D 0A 1A 0A`) followed by an `IHDR` chunk, else "the icon must be a PNG";
- at most 200 KB (204 800 bytes), else "the icon is over 200 KB";
- width = height, else "the icon must be square (it's 300×200)";
- 192 to 1024 px, else "the icon must be 192 to 1024 pixels wide (it's 128)".

SVG and WebP are refused: SVG can carry scripts and would be served from the app's origin, and WebP needs a parser.

### Setting it

- Dashboard → Settings → General gets an **Icon** card: a preview (or "No icon: the app's own is used"), **Upload**
  (a PNG file input) and **Remove**. Shown to the workspace's owner and admins (the settings area's existing guard).
- `PUT /admin-api/settings/icon`: the request body is the raw PNG (`Content-Type: image/png`), checked with
  `checkIcon`, then upserted. Answers `{ iconUrl }`. Audit row `workspace_icon_set`.
- `DELETE /admin-api/settings/icon`: deletes the row. Audit row `workspace_icon_remove`.
- Both act on the session's workspace only.

### Serving

- `GET /icon/<hash>.png`, public (no session): the PNG with `Content-Type: image/png` and
  `Cache-Control: public, max-age=31536000, immutable`. An unknown hash, or anything not 64 hex characters, is 404.
- The URL is built from the content hash: it can't be guessed, says nothing about the workspace, and changes when the
  icon changes. After a removal the old URL is 404.
- `iconUrl(publicUrl, hash)` gives the absolute URL (pushes need it absolute).

### Where it shows

- `GET /app-api/me`: `workspace.iconUrl` and each `workspaces[].iconUrl` (`null` when none).
- The app's header shows the icon (24 px, rounded) before the workspace's name; the picker shows each workspace's.
- `GET /admin-api/state`: `workspace.iconUrl`; the dashboard sidebar shows it beside the workspace's name or switcher.
- Pushes: `PushNote` gains `icon?: string`. A note from a workspace with an icon carries its absolute `iconUrl`.
  `web/public/sw.js` uses `d.icon || "/icon-192.png"` for `icon`; `badge` stays `/icon-192.png` (Android shows it as a
  one-colour mask). The service worker's cache name goes to `bongsu-shell-v7`.
- The ntfy topic and the audit log are unchanged.

## 2. Names

### Schema

- `memberships.display_name`: nullable text, the name people in that workspace see.
- `users.name` stays, and becomes editable.
- `drafts.user_id`: nullable text, the person who made the draft (app uploads). Agent-key drafts keep `created_by`.

### One rule

In `packages/core/src/workspaces.ts`:

- `memberName(db, userId, workspaceId): Promise<string | null>`: the membership's `display_name`, else `users.name`,
  else the email's local part (before `@`), else `null` for an unknown user.
- `memberNames(db, userIds, workspaceId): Promise<Map<string, string>>`: the same for a list, in one query.
- A person who is no longer a member is named by `users.name`, else the email's local part.

Every place that names a person uses these, except the passkey prompt (`userDisplayName` in `pwa/webauthn.ts`),
which stays on `users.name`, else the email: a passkey belongs to the person, not to a workspace.

### Editing

Names are trimmed and 1 to 60 characters; an empty one clears the value (back to the fallback). A longer name stored
before (the first-run and invite forms allow 80) keeps working until edited; those forms move to 60.

| Route | Who | Does | Audit |
|---|---|---|---|
| `POST /app-api/me/name` `{ name }` | any signed-in person | sets `users.name` | `user_name` |
| `POST /app-api/me/display-name` `{ name }` | a member of the session's workspace | sets their `display_name` there | `member_name` |
| `POST /admin-api/members/:userId/name` `{ name }` | owner or admin of the session's workspace | sets that member's `display_name` | `member_name` |

The last one is 404 for someone who isn't a member of the session's workspace. None of the routes is open to agent
keys. A visiting instance admin who isn't a member gets 403 on the display-name route, like the notification settings.

`GET /app-api/me` gains `you: { name, displayName, shownAs }` (`shownAs` = `memberName` in the current workspace).

### App

Settings gets a **You** card first: **Name** (yours, everywhere) and **Shown in &lt;workspace&gt; as** (placeholder:
your name, else your email's local part), each with Save. The picker shows `shownAs` under each workspace's name only
where it differs from the name.

### Where people are named

| Place | Now | After |
|---|---|---|
| Dashboard members list | name, else email | `memberNames` in the workspace; email beneath; an Edit name action for owners and admins |
| Dashboard sidebar | name, else email | `memberName` in the session's workspace |
| Audit list `who` | name, else email | `memberNames` in the row's workspace; a key's name for key rows (as now) |
| Invite email | inviter's name, else email | `memberName` of the inviter in the invited workspace |
| Approved by | not shown | item page: "Approved by Jo, 3 Nov 14:00"; `get_item`'s `approval.approved_by` (name or `null`). From `approvals.user_id`; an approval with none keeps today's text |
| Who paused | stored, not shown | a pause stores `userId` (or the key's name) in `workspace_settings.paused`; the app's banner says "Paused by Jo"; `get_status` gains `paused_by`. An old pause with only `by` shows that text |
| Draft author | literal "owner" | app uploads store `drafts.user_id`; the drafts list shows `memberName`; agent drafts show the key's name |
| Release moved | "by you" to everyone | "by Jo" (the mover's `memberName`), or the key's name |

## 3. Migration, tests, docs

- **Migration 0023** (neutral schema, generated for SQLite and Postgres): `workspace_icons`,
  `memberships.display_name`, `drafts.user_id`. No backfill.
- **Isolation** (`apps/cloudflare/test/workspaces.test.ts`):
  - workspace A's icon URL and display names never appear in B's `me`, members, audit or state;
  - an admin of B can't set or remove A's icon, or rename A's members;
  - a push from A carries A's icon and names;
  - agent keys can't reach any new route.
- **Other tests:**
  - `checkIcon`: every refusal (core unit);
  - the name fallback chain;
  - the 60-character rule;
  - the texts naming approver, pauser, draft author and release mover;
  - old pause rows and approvals with no person;
  - `/icon/<hash>.png` (hit, miss, bad hash, cache header, removed icon).
- **Docs:**
  - `site/docs/the-app.md` (You card);
  - `site/docs/the-dashboard.md` (Icon card, member names);
  - `docs/schema.md` (regenerated);
  - the route list in `docs/` that names `/m` and `/health`;
  - AGENTS.md ("One source of truth": the workspace icon is a setting in the database);
  - `docs/PLAN.md` boxes;
  - the changeset `.changeset/phase-13-part3b.md`.

## Out of scope

- A colour per workspace (The One Signal Rule in `packages/web/DESIGN.md`).
- A per-workspace manifest or installed icon.
- Renaming the workspace (exists).
- Names in the CLI.
- Naming commenters: they are Instagram and YouTube users, not Bongsu people.
