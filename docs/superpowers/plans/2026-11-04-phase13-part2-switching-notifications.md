# Phase 13 part 2: switching workspaces and notifications per person. Implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A person in several workspaces switches between them in the dashboard and the app. Each device gets
pushes from every workspace its person is in, filtered by that person's notification groups. Tapping a push opens
the app in that push's workspace.

**Architecture:**
- **Core:**
  - `workspacesOf` and `mayOpen` decide which workspaces someone can open;
  - `notify-prefs.ts` holds the groups, the defaults by role and the stored changes;
  - `push.ts` sends to the members of the note's workspace whose effective setting for the note's group is on.
- **API:** the dashboard and the app each get `POST …/session/workspace` and add the list of workspaces to their
  state. The app also gets `GET` and `PUT /app-api/notify-prefs`.
- **Migration 0021:** creates `notify_prefs` and drops `push_subs.workspace_id`.

**Tech Stack:** TypeScript, Hono, React (Vite), the neutral schema generator, vitest (core) and
vitest-pool-workers (Cloudflare).

**Spec:** `docs/superpowers/specs/2026-11-04-phase13-part2-switching-notifications-design.md`

## Global Constraints

- Node 22: `export PATH=$HOME/.nvm/versions/node/v22.14.0/bin:$PATH`. Work in `~/workspace/bongsu-p13-2`, branch
  `feat/phase-13-part2`.
- **Runtime independence:** `core` and `api` stay runtime-independent. The database goes through `Db`, and SQL stays
  portable. `packages/core/test/portable-sql.test.ts` must pass: no `unixepoch()` and no `json_each` in app SQL, and
  timestamps come from the app (`nowS`).
- **Guards by route pattern:** they read the router's tags (`c.get("area")`, `c.get("needs")`), never the raw URL.
  `packages/core/test/guards-use-the-router.test.ts` must pass.
- **Every route filters by the caller's workspace.** New routes go into `apps/cloudflare/test/workspaces.test.ts`.
- **Approval stays human.** Nothing here may let an agent key switch workspaces or change someone's notification
  settings: the new routes are session routes only.
- **No personal data:** demo accounts and `example.com` only.
- **Biome style:** 2 spaces, double quotes, 120 columns. Comments explain why.
- **Commits:**
  - Conventional Commits, `type(scope): summary`, at most 100 characters. Scopes come from AGENTS.md.
  - Each commit body has `Refs #<issue>` (#18, #22, #23 or #24) and ends with
    `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
  - Don't skip hooks, and don't push.
- **The five groups,** exactly as named: `needs_you`, `problems`, `published`, `inbox`, `digest`.
- **Role defaults:** admins and creators get all five groups. Editors get every group except `needs_you`.
- **Integration test command:**
  `pnpm --filter @bongsu/cloudflare exec vitest run <files> --testTimeout 120000 --maxWorkers=2`.

## Review Focus

1. **A device subscribed before 0021 that belongs to someone who has since left every workspace:** it must get
   nothing. The membership check moves from the subscription's workspace to the note's. Test in Task 3.
2. **A push link opened while signed out, or by a different person on a shared phone:** the switch call gets a 401
   or 403. The app must show sign-in or "You're no longer in that workspace", never a blank page. Test in Task 6.
3. **Setting a group back to its role default:** this deletes the row, so a later role change moves the group.
   Changing someone's role after they muted a group keeps the mute. Test in Task 4.
4. **Two workspaces with the same item key** (both have `reel:2026-11-05-a`): their pushes don't replace each other,
   because the tag carries the workspace, and each opens its own workspace. Test in Task 3.
5. **An instance admin who isn't a member:** they can switch in both apps, but get no pushes from that workspace.
   The dashboard's list for a creator membership leaves it out. Tests in Tasks 2 and 3.

---

### Task 1: Migration 0021, notification groups and settings in core

**Files:**
- Create: `packages/schema/src/migrations/0021_notify_prefs.ts`
- Modify: `packages/schema/src/migrations/index.ts`, then generate `migrations/sqlite/0021_notify_prefs.sql`,
  `migrations/postgres/0021_notify_prefs.sql` and `docs/schema.md` (`pnpm --filter @bongsu/schema generate`)
- Create: `packages/core/src/notify-prefs.ts`
- Modify: `packages/core/src/texts/notifications.ts`, adding `group` to `Note` and to every builder
- Test: `packages/core/test/notifications.test.ts`, `packages/core/test/notify-prefs.test.ts` (new)

**Interfaces:**
- Produces, in `packages/core/src/notify-prefs.ts`:
  - `export const NOTE_GROUPS = ["needs_you", "problems", "published", "inbox", "digest"] as const`
  - `export type NoteGroup = (typeof NOTE_GROUPS)[number]`
  - `export const isNoteGroup = (v: unknown): v is NoteGroup`
  - `export function roleDefault(role: Role, grp: NoteGroup): boolean`
  - `export async function effectivePrefs(db: Db, workspaceId: string, userId: string, role: Role): Promise<{ grp: NoteGroup; enabled: boolean; isDefault: boolean }[]>`, in `NOTE_GROUPS` order
  - `export async function setPref(db: Db, workspaceId: string, userId: string, role: Role, grp: NoteGroup, enabled: boolean, nowS: number): Promise<void>`. It deletes the row when `enabled === roleDefault(role, grp)`, and otherwise upserts it.
  - `export async function receivers(db: Db, workspaceId: string, grp: NoteGroup): Promise<string[]>`: the user ids of
    the workspace's members whose effective setting for `grp` is on. Members come from `memberships`, so instance
    admins who aren't members are excluded.
- Produces: the `Note` interface gains `group: NoteGroup`, which is required.

- [ ] **Step 1: Write migration 0021.**
  - A `createTable: "notify_prefs"` step with `workspace_id`, `user_id`, `grp` (all `text`, `notNull`), `enabled`
    (`int`, `notNull`) and `updated_at` (`timestamp`, `notNull`). The primary key is
    (`workspace_id`, `user_id`, `grp`); follow how `0018_people.ts` declares composite keys.
  - A `sql` step: `ALTER TABLE push_subs DROP COLUMN workspace_id;`, the same text for `sqlite` and `postgres`, with
    `apply: (t) => { delete t.push_subs.columns.workspace_id; }`.
  - Describe both in a header comment that says why.
  - Register it in `index.ts`, then run `pnpm --filter @bongsu/schema generate`.
- [ ] **Step 2: Run the schema tests.** Run `pnpm --filter @bongsu/schema test`. Expected: PASS, with the generated
  files committed alongside.
- [ ] **Step 3: Write the failing tests.**
  - `notify-prefs.test.ts`:
    - `roleDefault("editor","needs_you") === false`;
    - every other role and group pair is `true`.
  - `notifications.test.ts`, "every builder has a group": call each exported builder of `texts/notifications.ts`
    with sample arguments and expect `isNoteGroup(note.group)`. Then check these:
    - `jobHeld` and `shortsWaiting` are `needs_you`;
    - `jobFailed` and `connectionProblem` are `problems`;
    - `published` is `published`;
    - `newDrafts` and `releaseMoved` are `inbox`;
    - `digest` is `digest`;
    - `mediaStoreProblem` keeps a group too (`problems`), even though `notifyInstanceAdmins` ignores it.
- [ ] **Step 4: Run them.** Run `pnpm --filter @bongsu/core exec vitest run test/notify-prefs.test.ts test/notifications.test.ts`.
  Expected: FAIL (the module and the `group` field are missing).
- [ ] **Step 5: Implement `notify-prefs.ts`, and add `group` to `Note` and its builders.** The mapping is the spec's
  table in §4, and `mediaStoreProblem` gets `problems`.
  - `effectivePrefs` reads that person's rows.
  - `receivers` reads two things in two portable queries: the members with their role
    (`SELECT user_id, role FROM memberships WHERE workspace_id = ?1`) and the rows for `grp`
    (`SELECT user_id, enabled FROM notify_prefs WHERE workspace_id = ?1 AND grp = ?2`). It combines them in code.
- [ ] **Step 6: Run the tests again and run typecheck.** Run the Step 4 command, then `pnpm typecheck`. Expected:
  PASS, and typecheck flags every hand-built `Note` literal still missing `group`. Fix each one with the right group.
- [ ] **Step 7: Commit.**
  `feat(core,schema): notification groups, role defaults and per-person settings (migration 0021)`, with `Refs #23`.

### Task 2: Which workspaces someone can open, and switching to one

**Files:**
- Modify: `packages/core/src/workspaces.ts`
- Modify: `packages/api/src/dashboard/routes.ts`, adding the `session` area, `POST /admin-api/session/workspace`, and
  `workspaces` and `workspace` in `/admin-api/state`. `POST /admin-api/workspaces/:id/open` becomes an alias that
  calls the same function.
- Modify: `packages/api/src/pwa/routes.ts`, adding `NEEDS` `["/app-api/session/*", null]`,
  `POST /app-api/session/workspace`, and `workspace` and `workspaces` in `/app-api/me`
- Test: `apps/cloudflare/test/switch.test.ts` (new), `apps/cloudflare/test/workspaces.test.ts`

**Interfaces:**
- Consumes: `setSessionWorkspace(db, token, workspaceId)` from `packages/api/src/pwa/session.ts`, which already exists.
- Produces, in `packages/core/src/workspaces.ts`:
  - `export type OpenableWorkspace = { id: string; name: string; role: Role }`
  - `export async function workspacesOf(db: Db, userId: string, opts?: { notCreator?: boolean }): Promise<OpenableWorkspace[]>`, ordered by name
  - `export async function mayOpen(db: Db, userId: string, workspaceId: string, opts?: { notCreator?: boolean }): Promise<OpenableWorkspace | null>`
  - `workspacesOf` filters the same rows `mayOpen` checks, so the two can't drift apart. Use one SQL fragment, or
    build `workspacesOf` on a shared query.
- Produces in the API, consumed by Tasks 5 and 6:
  - **`POST /admin-api/session/workspace`, body `{ id: string }`:**
    - answers 200 `{ ok: true, id }`;
    - answers 403 `{ error: "you can't open that workspace" }` when `mayOpen` refuses;
    - audits `workspace_open` in the target workspace when the caller isn't a member there (an instance admin coming
      in), as `/open` does today.
  - **`POST /app-api/session/workspace`:** the same body and answers, without `notCreator`.
  - **`/admin-api/state` adds:** `workspace: { id, name } | null` and
    `workspaces: OpenableWorkspace[]` (`notCreator: true`).
  - **`/app-api/me` adds:** `workspace: { id, name } | null` and `workspaces: OpenableWorkspace[]`.

- [ ] **Step 1: Write the failing tests in `switch.test.ts`.** Seed the workspaces `default` and `w2` with the helpers
  from `world.ts`, plus `createWorkspace` and `addMember` from `@bongsu/core/people`. Cover these:
  - **an admin of both:**
    - `/admin-api/state.workspaces` lists both by name;
    - switching to `w2` answers 200;
    - after the switch, `/admin-api/state.workspace.id === "w2"`, and a workspace route such as
      `/admin-api/accounts` reads `w2`'s rows.
  - **a creator in `w2` and an admin in `default`:**
    - the dashboard's list leaves `w2` out, and switching to it there answers 403;
    - the app's list includes `w2`, and the app's switch answers 200.
  - **archived and non-member:** an archived workspace and a workspace the person isn't in both answer 403, and
    the session keeps its workspace.
  - **an instance admin:**
    - switches to a workspace they aren't a member of: 200;
    - a `workspace_open` audit row lands in it;
    - `/admin-api/workspaces/:id/open` still answers as before.
  - **separate sessions:** a switch in the app doesn't change the dashboard session's workspace.
  - **signed out:** the app's switch answers 401.
- [ ] **Step 2: Run them.** Run the integration command on `test/switch.test.ts`. Expected: FAIL (404 on the new
  routes).
- [ ] **Step 3: Implement `workspacesOf` and `mayOpen`, the two routes, and the state and `me` fields.**
  - The dashboard route's area is `session: { noWorkspace: true }` in `AREAS`, so someone whose session lost its
    workspace can still switch.
  - In `workspaces.test.ts`, add both switch routes to the cross-workspace checks: the target must be one the caller
    can open.
- [ ] **Step 4: Run the tests again.** Run the integration command on `test/switch.test.ts test/workspaces.test.ts`.
  Expected: PASS.
- [ ] **Step 5: Commit.** `feat(core,api): switch the session's workspace in the dashboard and the app`, with
  `Refs #18` and `Refs #22`.

### Task 3: Pushes go to each workspace's members by group, and name their workspace

**Files:**
- Modify: `packages/core/src/push.ts`
  - `PushAudience` becomes `{ workspaceId: string; group: NoteGroup } | { userId: string }`.
  - The query for a workspace: `receivers()` from Task 1, then
    `SELECT id, endpoint, p256dh, auth, user_id FROM push_subs WHERE user_id IN (…)`, built with placeholders in
    portable SQL.
  - Fix the header comment.
- Modify: `packages/core/src/notify.ts`
  - Pass `{ workspaceId, group: note.group }`.
  - Add `w` to every URL.
  - Make the tag `<workspaceId>:<target>`.
  - Prefix the title with the workspace's name for people in more than one workspace. This makes the payload per
    recipient, so `sendPush` takes a `titleFor(userId)` hook, or `notify.ts` groups the recipients. Choose whichever
    keeps `push.ts` free of workspace naming.
  - Correct the top comment.
- Modify: `packages/api/src/pwa/routes.ts`
  - The subscribe route no longer writes `workspace_id`; update its comment.
  - The test push uses `{ userId }`.
- Modify: `packages/core/src/invites.ts` (member removal): delete that person's `notify_prefs` rows for the workspace
  instead of their `push_subs` rows.
- Test: `apps/cloudflare/test/push.test.ts`, adapting the existing cases and adding new ones

**Interfaces:**
- Consumes: `receivers`, `NoteGroup` and `Note.group` from Task 1, and `workspacesOf` from Task 2 (to count a person's
  workspaces for the title).
- Produces: `export function withWorkspace(url: string, workspaceId: string): string` in `notify.ts`. It turns
  `/#/item/x` into `/?w=<id>#/item/x`. It leaves absolute URLs to other sites, such as Studio, unchanged.

- [ ] **Step 1: Write the failing tests in `push.test.ts`.** Start by replacing "goes only to the devices of the
  workspace a notification is about" and "stops at a user who left the workspace…" with the fan-out cases.
  **Who receives:**
  - a note for `default` reaches a person in both workspaces whose device subscribed while in `w2`;
  - it never reaches a person who is only in `w2`;
  - a group the person muted (`setPref(…, false)`) sends nothing to them;
  - an editor gets no `needs_you` note by default, and does get a `problems` one;
  - an instance admin who isn't a member gets nothing;
  - after `removeMember`, the person's devices stop getting the workspace's notes, and their `notify_prefs` rows for
    it are gone.

  **Payload** (decrypt it with the fake push service in `world.ts`, as the existing tests do):
  - `url` is `/?w=default#/item/…`;
  - `tag` is `default:reel:…`;
  - the title starts with `Demo Studio · ` for the person in two workspaces, and has no prefix for a person in one.

  **Other cases:**
  - Two workspaces with the same item key: the tags differ.
  - The test push still reaches only the caller's own devices.
  - Core unit test: `withWorkspace("https://studio.youtube.com/video/x/comments", "w")` is returned unchanged.
- [ ] **Step 2: Run them.** Run the integration command on `test/push.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement the changes listed under Files.**
- [ ] **Step 4: Run the tests again.** Run the integration command on
  `test/push.test.ts test/ntfy.test.ts test/workspaces.test.ts test/app.test.ts`, then `pnpm typecheck` and
  `pnpm check`. Expected: PASS. The ntfy titles must not change.
- [ ] **Step 5: Commit.**
  `feat(core,api): pushes reach each workspace's members by their groups, and say which workspace`, with `Refs #22`,
  `Refs #23` and `Refs #24`.

### Task 4: The app's notification settings routes

**Files:**
- Modify: `packages/api/src/pwa/routes.ts`: add `GET /app-api/notify-prefs` and `PUT /app-api/notify-prefs`, and add
  `["/app-api/notify-prefs", null]` to `NEEDS`, since a person's own settings need no scope.
- Test: `apps/cloudflare/test/notify-prefs.test.ts` (new), `apps/cloudflare/test/workspaces.test.ts`

**Interfaces:**
- Consumes: `effectivePrefs`, `setPref` and `isNoteGroup` from Task 1, and the caller's `workspaceId`, `userId` and
  `role`.
- Produces:
  - `GET` answers `{ groups: { grp, enabled, isDefault }[] }`.
  - `PUT { grp, enabled }` answers the same.
  - It answers 400 `{ error: "unknown group" }` for a group that doesn't exist, and 400 for an `enabled` that isn't a
    boolean.

- [ ] **Step 1: Write the failing tests.**
  - An editor's `GET` shows `needs_you` off and default.
  - `PUT problems false`, then `GET`: the group is off and not default.
  - `PUT problems true` (its default) deletes the row: `isDefault` is true again, and `notify_prefs` has no row.
  - **Review Focus 3:** an admin mutes `published`; their role becomes editor (`setRole`); `published` stays off,
    and `needs_you` follows the new default (off).
  - An unknown group gets a 400. Signed out gets a 401.
  - In `workspaces.test.ts`: settings in `w2` don't change `default`'s, and each GET reads the session's workspace.
- [ ] **Step 2: Run them.** Run the integration command on `test/notify-prefs.test.ts`. Expected: FAIL (404).
- [ ] **Step 3: Implement both routes.**
- [ ] **Step 4: Run the tests again.** Run the integration command on
  `test/notify-prefs.test.ts test/workspaces.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit.** `feat(api): the app reads and changes a person's notification groups`, with `Refs #23`.

### Task 5: The dashboard's switcher

**Files:**
- Modify: `packages/dashboard/src/App.tsx` (the sidebar header and the state type), `packages/dashboard/src/api.ts`
  (`switchWorkspace(id)`), and `packages/dashboard/src/pages.tsx` (the Workspaces page's Open calls
  `switchWorkspace`)
- Test: the dashboard has no component tests. The behaviour is covered by Task 2, so verify by building and running.

**Interfaces:**
- Consumes: `state.workspaces`, `state.workspace` and `POST /admin-api/session/workspace` from Task 2.

- [ ] **Step 1: Build the switcher.**
  - Show the workspace's name in the sidebar header as plain text when `state.workspaces.length <= 1`.
  - With more than one workspace, show a `<select>` with the name as its label, or the dashboard's existing menu
    component from `ui.tsx` if there is one, listing each workspace's name and role.
  - On change, call `switchWorkspace`, reload the state, and stay on the page when it belongs to no workspace
    (Workspaces, Media, OAuth apps, Devices). Otherwise go to Overview.
  - Show the API's 403 message in the dashboard's existing error banner.
  - Follow `packages/dashboard`'s existing patterns and styles. Keyboard and screen reader: a labelled control.
- [ ] **Step 2: Verify.**
  - Run `pnpm --filter @bongsu/dashboard build`, `pnpm typecheck` and `pnpm check`. Expected: PASS.
  - Run `pnpm screenshots --keep` (it seeds a single workspace). The header must show the name with no switcher.
- [ ] **Step 3: Commit.** `feat(dashboard): a workspace switcher in the sidebar for people in several`, with `Refs #18`.

### Task 6: The app's picker, push links and notification settings

**Files:**
- Modify: `packages/web/src/App.tsx`
  - the header: the workspace name and the picker sheet;
  - starting the app: read `w` from `location.search`;
  - Settings: the Notifications switches.
- Modify: `packages/web/src/api.ts`: `switchWorkspace(id)`, `notifyPrefs()` and `setNotifyPref(grp, enabled)`.
- Modify: `packages/web/src/i18n.ts`: every new string in each locale the file has. Copy:
  - group labels: "Needs you", "Problems", "Published and results", "New drafts and comments", "Daily digest";
  - one line each explaining the group;
  - "Default for your role";
  - "For another workspace, switch to it first.";
  - "You're no longer in that workspace.";
  - "Switch workspace".
- Test: `packages/web` unit tests, if they cover helpers (`pnpm --filter @bongsu/web test`). Add a test for the
  helper that reads `w` and strips it from the URL.

**Interfaces:**
- Consumes: `me.workspace`, `me.workspaces` and `POST /app-api/session/workspace` from Task 2, and the
  `/app-api/notify-prefs` routes from Task 4.
- Produces: `export function takeWorkspaceParam(loc: { search: string; hash: string }): { w: string | null; cleaned: string }`
  in `packages/web/src/api.ts`, or a small new module if `api.ts` isn't the place.

- [ ] **Step 1: Write the failing test** for `takeWorkspaceParam`:
  - `?w=w2` with `#/item/reel%3Ax` gives `w2` and `cleaned` `/#/item/reel%3Ax`;
  - no `w` gives `null`, and the URL is unchanged;
  - `w` alongside other params keeps the others.
- [ ] **Step 2: Run it.** Run `pnpm --filter @bongsu/web test`. Expected: FAIL.
- [ ] **Step 3: Implement the helper and its use at app start.**
  - When `w` is present and differs from `me.workspace.id`, call `switchWorkspace`, reload `me`, and
    `history.replaceState` to the cleaned URL. Then route.
  - On a 403, show "You're no longer in that workspace." with a link to the queue.
  - On a 401, the normal sign-in screen.
  - Never show a blank page (Review Focus 2).
- [ ] **Step 4: Build the header and picker.**
  - The header shows `me.workspace.name`.
  - With more than one workspace, tapping the name opens a sheet with the workspaces and roles. Choosing one switches,
    reloads `me`, and goes to the queue.
  - Follow `packages/web/PRODUCT.md` and `DESIGN.md`, and the app's existing sheet component.
- [ ] **Step 5: Add Settings → Notifications.**
  - Five switches from `notifyPrefs()`, each with its label, its line, and "Default for your role" when `isDefault`.
  - A toggle calls `setNotifyPref`.
  - The "switch first" line shows only with more than one workspace.
  - It sits beside the existing device push toggle, which stays as it is.
- [ ] **Step 6: Verify.**
  - Run `pnpm --filter @bongsu/web test`, `pnpm --filter @bongsu/web build`, `pnpm typecheck` and `pnpm check`.
    Expected: PASS.
  - Run `pnpm screenshots --keep` and check the app's Settings page renders the five switches.
- [ ] **Step 7: Commit.**
  `feat(web): a workspace picker, push links that open their workspace, and notification settings`, with `Refs #22`
  and `Refs #23`.

### Task 7: Postgres, docs, the plan and the changeset

**Files:**
- Modify: `apps/node/test/postgres.test.ts`, if it lists migrations or tables. Assert that `notify_prefs` exists and
  that `push_subs` has no `workspace_id`.
- Modify: `site/docs/the-app.md` (the picker; Settings → Notifications with the five groups and the role defaults)
  and `site/docs/the-dashboard.md` (the switcher).
- Modify: `docs/PLAN.md` (Phase 13): tick the switcher item, the PWA picker item and "Notifications per user and
  workspace". On the isolation item, note that the notification part is covered and that the cron and media links
  remain.
- Create: `.changeset/phase-13-part2.md`, a minor bump for `@bongsu/core`, `api`, `web`, `dashboard`, `cloudflare`,
  `node` and `schema`, in the style of the part 1 changeset. Include an "Updating" note: existing push subscriptions
  now get every workspace their person is in, and editors no longer get `needs_you` by default.

- [ ] **Step 1: Postgres.** Run `pnpm --filter @bongsu/node exec vitest run test/postgres.test.ts`. Expected: PASS
  with 0021 applied. It's skipped when no Postgres is available, so say so in the report.
- [ ] **Step 2: Docs, plan and changeset.** Then run `pnpm test:site` and `pnpm check`. Expected: PASS.
- [ ] **Step 3: Commit.** `docs(docs): switching workspaces and notification groups, plan and changeset`, with
  `Refs #18`, `Refs #22` and `Refs #23`.
