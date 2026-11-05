# Workspace icon and names per workspace (Phase 13, part 3b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A workspace gets an optional PNG icon shown in the app, the dashboard and its pushes, and people get an
editable name plus a display name per workspace, used everywhere Bongsu names a person.

**Architecture:** One migration (0023) adds `workspace_icons`, `memberships.display_name` and `drafts.user_id`. Core
gets `icon.ts` (PNG checks and storage) and two name helpers in `workspaces.ts`; the API serves the icon at a public
content-hash URL and adds the edit routes; the app and the dashboard show both.

**Tech Stack:** TypeScript, Hono, D1/SQLite/Postgres through the `Db` port, React (app and dashboard), vitest on
workerd (`apps/cloudflare/test`), the neutral schema in `packages/schema`.

**Spec:** `docs/superpowers/specs/2026-11-05-phase13-part3b-icon-names-design.md`

## Global Constraints

- Node 22: `export PATH=$HOME/.nvm/versions/node/v22.14.0/bin:$PATH`.
- `core` and `api` stay runtime-independent: no Node or Cloudflare imports.
- Portable SQL only (`packages/core/test/portable-sql.test.ts`); timestamps come from the app.
- Every query acting for a caller filters by the caller's workspace.
- No personal data: demo names (`Jo`, `Ana`) and `example.com` only.
- No new dependency.
- Conventional Commits, ≤100 characters, lowercase subject; scopes such as `core`, `api`, `web`, `dashboard`, `schema`.
- Never `--no-verify`. Do not push.
- Icon rules, verbatim: PNG signature `89 50 4E 47 0D 0A 1A 0A` then an `IHDR` chunk; at most 204 800 bytes; square;
  192 to 1024 px. Messages: "the icon must be a PNG", "the icon is over 200 KB",
  "the icon must be square (it's 300×200)", "the icon must be 192 to 1024 pixels wide (it's 128)".
- Icon URL: `GET /icon/<hash>.png`, `<hash>` = 64 lowercase hex (SHA-256 of the bytes);
  `Cache-Control: public, max-age=31536000, immutable`; 404 for unknown or malformed.
- Names: trimmed, 1 to 60 characters; empty clears. Fallback: `display_name` → `users.name` → email local part.
- Audit actions: `workspace_icon_set`, `workspace_icon_remove`, `user_name`, `member_name`.
- Service worker cache name: `bongsu-shell-v7`; push `badge` stays `/icon-192.png`.
- Run focused tests locally; the full Cloudflare suite runs in CI (and once in the final review):
  `pnpm --filter @bongsu/cloudflare exec vitest run test/<file> --testTimeout 120000 --maxWorkers=2`.

## Review Focus

1. A PNG whose IHDR claims a size but the file is truncated (fewer than 33 bytes): refused as "not a PNG", no throw
   from reading past the end. Test in Task 2.
2. A name made only of spaces, or with 61 characters after trimming: spaces clear it; 61 is refused with a 400 that
   says the limit. Test in Task 3.
3. A member removed from workspace A who approved something there: `approved_by` still names them (their name or
   email local part), not `null`. Test in Task 4.
4. A user with no name and no email (an old seed row): `memberName` returns `null` and callers show nothing rather
   than "null". Test in Task 3.
5. Uploading the same PNG to two workspaces: both rows share one hash; removing one leaves the other's URL working.
   Test in Task 2.

---

### Task 1: Migration 0023

**Files:**
- Create: `packages/schema/src/migrations/0023_icon_names.ts`
- Modify: `packages/schema/src/migrations/index.ts` (register `{ name: "0023_icon_names", steps: iconNames }`)
- Generated: `migrations/sqlite/0023_icon_names.sql`, `migrations/postgres/0023_icon_names.sql`, `docs/schema.md`,
  `schema.json` (`pnpm --filter @bongsu/schema generate`)
- Test: `packages/schema/test/` (existing generate/consistency tests), `apps/node` migration tests

**Interfaces:**
- Produces: table `workspace_icons (workspace_id text PK, png text NOT NULL, hash text NOT NULL, updated_at timestamp
  NOT NULL)`; columns `memberships.display_name text`, `drafts.user_id text`.

- [ ] **Step 1:** Write the migration with three steps, modelled on `0021_notify_prefs.ts` (`createTable`) and
  `0022_workspace_media.ts` (`addColumn`). Descriptions:
  - `workspace_icons`: "A workspace's icon: a PNG (base64), its SHA-256 and when it was set; no row, no icon."
  - `display_name`: "the name people in this workspace see; NULL: the person's name".
  - `drafts.user_id`: "the person who made it (app uploads); NULL for an agent key's".
  - Index: `workspace_icons_hash` on `hash`. Not unique: the same PNG may be the icon of two workspaces.
- [ ] **Step 2:** Run `pnpm --filter @bongsu/schema generate`, then `pnpm --filter @bongsu/schema test`.
  Expected: PASS, with the generated files current.
- [ ] **Step 3:** Run `pnpm --filter @bongsu/node exec vitest run`. Expected: PASS (SQLite and PGlite migrate).
- [ ] **Step 4:** Commit: `feat(schema): workspace icons, display names per workspace, a draft's person (migration 0023)`.

### Task 2: The icon in core, served at /icon/<hash>.png

**Files:**
- Create: `packages/core/src/icon.ts`, `packages/core/test/icon.test.ts`
- Modify: `packages/api/src/app.ts` (route next to `/m`)
- Create: `apps/cloudflare/test/icon.test.ts`

**Interfaces:**
- Produces, in `@bongsu/core/icon`:
  - `class IconError extends Error`
  - `checkIcon(bytes: Uint8Array): { width: number }` (throws `IconError` with the exact messages above)
  - `setIcon(db: Db, workspaceId: string, bytes: Uint8Array, nowS: number): Promise<string>` (returns the hash)
  - `removeIcon(db: Db, workspaceId: string): Promise<boolean>`
  - `iconHashes(db: Db, workspaceIds: string[]): Promise<Map<string, string>>`
  - `iconByHash(db: Db, hash: string): Promise<Uint8Array | null>`
  - `iconUrl(publicUrl: string, hash: string | undefined | null): string | null`, giving `${publicUrl}/icon/${hash}.png`

- [ ] **Step 1: Failing core tests** in `icon.test.ts`. Build PNGs in the test with a small helper
  `png(w, h, extra = 0)`: the signature, an IHDR chunk with `w` and `h` as big-endian u32, and `extra` zero bytes.
  - `checkIcon(png(256, 256))` → `{ width: 256 }`;
  - `png(1024, 1024)` passes, and so does `png(192, 192)`;
  - `png(300, 200)` throws "the icon must be square (it's 300×200)";
  - `png(128, 128)` throws "the icon must be 192 to 1024 pixels wide (it's 128)";
  - `png(2048, 2048)` throws the same message with 2048;
  - `png(256, 256, 204_800)` throws "the icon is over 200 KB";
  - a GIF header (`GIF89a…`), an empty array and the first 20 bytes of a valid PNG each throw "the icon must be a PNG"
    (Review Focus 1).
- [ ] **Step 2:** Run `pnpm --filter @bongsu/core exec vitest run test/icon.test.ts`. Expected: FAIL (no module).
- [ ] **Step 3:** Implement `checkIcon`.
  - Check the size first: it is the cheapest check.
  - Then the signature, then the bytes 12..15 must read `IHDR`, with width at 16..19 and height at 20..23.
  - A file shorter than 24 bytes is "not a PNG".
  - The storage functions use base64 (`btoa`/`atob` over the bytes) and `sha256Hex` from `formats/approved`.
  - `setIcon` checks the icon first, then does `INSERT … ON CONFLICT (workspace_id) DO UPDATE`.
- [ ] **Step 4:** Run the core test. Expected: PASS.
- [ ] **Step 5: Failing integration tests** in `apps/cloudflare/test/icon.test.ts`, using `createApp` the way
  `health.test.ts` does:
  - `setIcon` for workspace A, then `GET /icon/<hash>.png` → 200, `image/png`, the cache header above, bytes equal;
  - an unknown 64-hex hash → 404;
  - `GET /icon/xyz.png` → 404;
  - after `removeIcon` → 404;
  - the same bytes set for A and B, A removed: B's URL is still 200 (Review Focus 5).
- [ ] **Step 6:** Add `app.get("/icon/:file", …)` in `app.ts`.
  - Match `^([0-9a-f]{64})\.png$`.
  - Answer with `iconByHash`, else 404 with no body detail.
- [ ] **Step 7:** Run the test. Expected: PASS. Commit: `feat(core,api): a workspace icon, checked as a png and served at /icon/<hash>.png`.

### Task 3: Names in core, and editing them

**Files:**
- Modify: `packages/core/src/workspaces.ts`
- Create: `packages/core/test/names.test.ts`
- Modify: `packages/api/src/pwa/routes.ts` (`POST /app-api/me/name`, `POST /app-api/me/display-name`, `me.you`)
- Modify: `packages/api/src/dashboard/routes.ts` (`POST /admin-api/members/:userId/name`)
- Modify: `packages/api/src/dashboard/routes.ts` and `packages/api/src/pwa/invite.ts`: the first-run and invite name
  limit goes from 80 to `NAME_MAX`
- Create: `apps/cloudflare/test/names.test.ts`

**Interfaces:**
- Produces, in `@bongsu/core/workspaces`:
  - `NAME_MAX = 60`
  - `checkName(raw: unknown): string | null`: trims; `""` → `null`; over 60 or not a string → throws `NameError`
    "a name is 1 to 60 characters"
  - `memberName(db: Db, userId: string, workspaceId: string): Promise<string | null>`
  - `memberNames(db: Db, userIds: string[], workspaceId: string): Promise<Map<string, string>>` (one query: `users`
    LEFT JOIN `memberships` on the workspace; `jsonList` for the ids, as `latestApprovals` does)
  - `setUserName(db, userId, name: string | null): Promise<void>`
  - `setDisplayName(db, workspaceId, userId, name: string | null): Promise<boolean>` (false: not a member)
- Produces, on `GET /app-api/me`: `you: { name: string | null; displayName: string | null; shownAs: string | null }`

- [ ] **Step 1: Failing core tests** in `names.test.ts`. Use the core test `Db` the other core tests use; if none
  runs SQL, put these cases in `apps/cloudflare/test/names.test.ts` instead.
  - Fallback chain: a display name wins; then the name; then `jo` for `jo@example.com`.
  - Unknown user → `null`.
  - A user with neither name nor email → `null` (Review Focus 4).
  - A display name set in A is not used in B.
  - A non-member is named by name, else email local part.
  - `memberNames` gives the same as `memberName` for three users at once.
  - `checkName`: `"  Jo  "` → `"Jo"`; `"   "` → `null`; 60 characters pass; 61 throw (Review Focus 2).
- [ ] **Step 2:** Run them. Expected: FAIL. **Step 3:** Implement. **Step 4:** Run them. Expected: PASS.
- [ ] **Step 5: Failing route tests** in `apps/cloudflare/test/names.test.ts`, with the `as(userId, workspaceId)`
  helper pattern from `notify-prefs.test.ts`:
  - `POST /app-api/me/name {name:"Jo"}` → 200, and `me.you.name === "Jo"`.
  - `{name:""}` clears it.
  - 61 characters → 400 with "a name is 1 to 60 characters".
  - `POST /app-api/me/display-name {name:"J. Park"}` in A → `me.you.shownAs === "J. Park"` in A, and not in B.
  - A visiting instance admin who isn't a member gets 403 on display-name.
  - Audit rows: `user_name` and `member_name`, with `workspace_id` A for the display name.
  - `POST /admin-api/members/:userId/name`: an admin of A → 200; an editor of A → 403 (the members area); a userId not
    in A → 404; an admin of B renaming A's member, with a B session → 404.
  - An agent key on each route → 401 or 403.
- [ ] **Step 6:** Implement the routes, then run. Expected: PASS.
- [ ] **Step 7:** Commit: `feat(core,api): edit your name and a display name per workspace`.

### Task 4: Name people everywhere

**Files:**
- Modify: `packages/api/src/dashboard/routes.ts`: members list (~836), `/admin-api/state` user (~274), audit `who`
  (~1884)
- Modify: `packages/core/src/invites.ts` (~59-67, the inviter in the invited workspace)
- Modify: `packages/core/src/data.ts` (`ApprovalRow`/`toApproval` read `user_id` as `approvedByUser`; `pausedState`
  keeps `userId`; `setPaused` takes `by: { userId?: string; text: string }`)
- Modify: `packages/api/src/agent/ops.ts`:
  - `get_item` `approval.approved_by`;
  - `status` `paused_by`;
  - `pause` stores `userId`;
  - remove `personName` (use `memberName`);
  - `listDrafts` gains `by`
- Modify: `packages/api/src/pwa/uploads.ts` (drafts INSERT writes `user_id`)
- Modify: `packages/core/src/release.ts` (`by` = mover's `memberName`, else the key's name)
- Tests: `apps/cloudflare/test/names.test.ts` (extend), `release.test.ts`, `pause.test.ts`, `invites.test.ts`

**Interfaces:**
- Consumes: `memberName`, `memberNames` (Task 3).
- Produces:
  - `get_item` → `approval.approved_by: string | null`;
  - `status` → `paused_by: string | null`;
  - `listDrafts` rows → `by: string | null`;
  - `/admin-api/members` → `members[].name` is the shown name, plus a new `displayName`;
  - `/admin-api/state` → `user.name` is the shown name in the workspace.

- [ ] **Step 1: Failing tests:**
  - Members: Ana with a display name in A shows it in A's list, and her plain name in B's.
  - Audit `who` uses the row's workspace.
  - The invite mail's "by" is the inviter's display name in that workspace.
  - Approved by: approve as Ana in the app, then `get_item` gives `approval.approved_by === "Ana"`. An approval with
    `user_id` NULL gives `null`. After Ana is removed from A it still gives her name (Review Focus 3).
  - Pause by Ana: `status.paused_by === "Ana"`. A row with old JSON `{reason, by:"Owner", at}` gives `"Owner"`.
    Paused by a key: `API key "demo-agent"`.
  - An app upload draft: `listDrafts` gives `by === "Ana"`; an agent draft gives the key's name.
  - Release moved by Ana: the notification text says "by Ana"; by a key, the key's name.
- [ ] **Step 2:** Run them. Expected: FAIL. **Step 3:** Implement. **Step 4:** Run these files plus `approve`-related
  ones (`grep -l approve apps/cloudflare/test`). Expected: PASS.
- [ ] **Step 5:** Commit: `feat(core,api): name people by their name in the workspace: approvals, pauses, drafts, releases, members, audit`.

### Task 5: The icon through the API and pushes

**Files:**
- Modify: `packages/api/src/dashboard/routes.ts`:
  - `PUT /admin-api/settings/icon` (raw `image/png` body, max 204 800 bytes read; answers `{ iconUrl }`);
  - `DELETE /admin-api/settings/icon`;
  - `GET /admin-api/settings` gains `iconUrl`;
  - `/admin-api/state` `workspace.iconUrl` and `workspaces[].iconUrl`.
- Modify: `packages/api/src/pwa/routes.ts`: `me.workspace.iconUrl`, `me.workspaces[].iconUrl`
- Modify: `packages/core/src/push.ts` (`PushNote.icon?: string`), `packages/core/src/notify.ts` (set `icon`
  from the note's workspace)
- Modify: `apps/cloudflare/test/push.test.ts`; create `apps/cloudflare/test/workspace-icon.test.ts`

**Interfaces:**
- Consumes: `setIcon`, `removeIcon`, `iconHashes`, `iconUrl`, `IconError` (Task 2).
- Produces: `iconUrl: string | null` on `me.workspace`, `me.workspaces[]`, `state.workspace`, `state.workspaces[]`
  and `GET /admin-api/settings`; push payload field `icon` (absolute URL) when the workspace has an icon.

- [ ] **Step 1: Failing tests:**
  - An admin of A PUTs a valid PNG → 200, with an `iconUrl` that GETs 200.
  - A 300×200 PNG → 400 "the icon must be square (it's 300×200)".
  - A body over 204 800 bytes → 400 "the icon is over 200 KB".
  - An editor → 403.
  - DELETE → 200 and `iconUrl: null`.
  - Audit rows: `workspace_icon_set`, `workspace_icon_remove`.
  - `me` in A shows A's `iconUrl`, and B's entry in `workspaces[]` shows B's (or `null`).
  - A push from A, decrypted as in `push.test.ts`, has `icon === <A's absolute iconUrl>`.
  - A push from B, which has no icon, has no `icon` field.
- [ ] **Step 2:** Run. FAIL. **Step 3:** Implement. Read the body as `arrayBuffer` and refuse over the limit before
  `checkIcon`. **Step 4:** Run. PASS.
- [ ] **Step 5:** Commit: `feat(api,core): set a workspace's icon in the dashboard; pushes carry it`.

### Task 6: Dashboard UI

**Files:**
- Modify: `packages/dashboard/src/pages.tsx`: `GeneralSettings` gets an Icon `Card`; `Members` gets an "Edit name"
  action per member, opening an inline field with Save and Cancel and the placeholder "Shown here as …"
- Modify: `packages/dashboard/src/App.tsx`: the sidebar shows `state.workspace.iconUrl` (20 px) before the workspace's
  name or switcher

**Interfaces:**
- Consumes: the routes from Tasks 3–5.

- [ ] **Step 1: The Icon card.**
  - With an icon: a 64 px preview. Without one: "No icon: the app's own is used."
  - Upload is a `<input type="file" accept="image/png">`. It PUTs the file with `Content-Type: image/png`.
  - Remove is shown only when there is an icon.
  - Errors appear in the card.
- [ ] **Step 2: The Members name edit.** It is shown to owners and admins; the members area already guards the route.
- [ ] **Step 3:** Run `pnpm typecheck` and `pnpm check`. Expected: PASS. `packages/dashboard` has no test runner.
- [ ] **Step 4:** Commit: `feat(dashboard): a workspace icon in settings and the sidebar, members' names`.

### Task 7: App UI and the service worker

**Files:**
- Modify: `packages/web/src/App.tsx`:
  - `Me` type: `you`, `workspace.iconUrl`, `workspaces[].iconUrl`;
  - header icon, 24 px, rounded, before `ws-name`;
  - `WorkspaceSheet` gets each workspace's icon, and `shownAs` when it differs from `you.name`;
  - a `YouCard` first in `SettingsPage`;
  - the item page: "Approved by {name}, {when}" when `approval.approved_by` is set;
  - the header banner: "Paused by {name}" when `paused_by` is set;
  - the drafts list shows `by` in place of `created_by`
- Modify: `packages/web/src/i18n.ts` (new strings, every locale the file has)
- Modify: `packages/web/public/sw.js` (`icon: d.icon || "/icon-192.png"`, cache `bongsu-shell-v7`)
- Test: `packages/web/test/` (existing runner): an i18n key test if the existing tests check key parity

**Interfaces:**
- Consumes: the `me`, `status`, `get_item` and `listDrafts` fields from Tasks 3–5.

- [ ] **Step 1:** Write the `YouCard` and the Save calls.
  - It has two fields: "Name" and "Shown in {workspace} as", the second with `you.name` or the email local part as its
    placeholder.
  - Errors show inline.
- [ ] **Step 2:** Do the header, the picker, the item page, the banner and the drafts list.
- [ ] **Step 3:** Change `sw.js`.
- [ ] **Step 4:** Run `pnpm --filter @bongsu/web test`, `pnpm typecheck` and `pnpm check`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(web): your name and display name, workspace icons, who approved and who paused`.

### Task 8: Isolation, docs, changeset

**Files:**
- Modify: `apps/cloudflare/test/workspaces.test.ts`
- Modify:
  - `site/docs/the-app.md`;
  - `site/docs/the-dashboard.md`;
  - `docs/architecture.md` (the route list: `/icon/<hash>.png`);
  - `AGENTS.md` ("One source of truth": "the workspace icon is a setting, kept in the database");
  - `docs/PLAN.md` (tick the icon and names boxes, with `#34` and `#35`)
- Create: `.changeset/phase-13-part3b.md` (minor for core, api, web, dashboard, cloudflare, node, schema)

- [ ] **Step 1: Failing isolation tests** (add a block to `workspaces.test.ts`):
  - A's `iconUrl` and display names never appear in B's `me`, `/admin-api/state`, members or audit.
  - A B session can't PUT or DELETE A's icon: the route acts on B's own icon, and A's row is unchanged.
  - A B admin's `POST /admin-api/members/<A-only user>/name` → 404.
  - A push from A carries A's icon and A's names.
  - Agent keys get 401 or 403 on every new route.
- [ ] **Step 2:** Run. If anything fails, fix the leak in the owning code, not the test.
- [ ] **Step 3:** Write the docs and the changeset: user-facing, plain sentences, the upgrade note "nothing to do".
- [ ] **Step 4:** Run `pnpm check`, `pnpm typecheck`, `pnpm test:site`, and the core, schema and node tests.
  Then run the Cloudflare files touched in Tasks 2–8. Expected: all PASS.
- [ ] **Step 5:** Commit: `test(cloudflare): isolation for workspace icons and names` and
  `docs(docs): workspace icons and names per workspace` (two commits).
