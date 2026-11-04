# Phase 13 part 1: people, roles, invites and workspaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An instance admin runs a multi-workspace Bongsu: the first run makes them, they create workspaces and invite each one's admin; admins invite editors and creators; each role sees and does only what the spec's table allows, in its own workspace.

**Architecture:** One migration (0018) adds the instance admin flag, the new role values, archiving, per-workspace pause, invites and a session's workspace, and removes the empty seeded `default` workspace and `owner` user. The dashboard and the PWA resolve a request's workspace and role once (a session's workspace, else the user's first) and check it against three guards: instance, managing, content. Invites are a core module used by both apps.

**Tech Stack:** TypeScript, Hono (`packages/api`), the `Db` port (`packages/core`), the neutral schema (`packages/schema`), React (`packages/dashboard`, `packages/web`), vitest with `@cloudflare/vitest-pool-workers` (`apps/cloudflare/test`).

**Spec:** `docs/superpowers/specs/2026-11-04-phase13-people-roles-design.md`

## Global Constraints

- Workspace roles: `admin`, `editor`, `creator`; instance power is `users.instance_admin`, not a role.
- `ROLE_SCOPES`: admin and creator `["read","draft","plan","pause","reschedule","metrics","approve","resume"]`; editor `["read","draft","plan","reschedule","metrics"]`. No token ever approves (the app's passkey does).
- Agent keys: one workspace, content only; no user, role or workspace endpoints on `/v1` or `/mcp`.
- Invites: valid 7 days (`INVITE_S = 7 * 86400`), token stored as sha256, one use; never reveal whether an email has an account.
- A workspace keeps at least one admin; only an instance admin may remove or demote the last one.
- Membership, role, invite, archive and instance-admin changes ask for a fresh passkey (`FRESH_S`, dashboard `fresh(c)`).
- Portable SQL only (`packages/core/test/portable-sql.test.ts`); times as unix seconds; every row written for a caller carries the caller's `workspace_id`.
- Node 22 for every command: `export PATH=$HOME/.nvm/versions/node/v22.14.0/bin:$PATH`.
- Commits: Conventional Commits, lowercase subject, at most 100 characters; `Refs #18` / `#19` / `#20` / `#33` in bodies.
- Locally run the test files a task touches; the PR's CI runs the full suite.

## Review Focus

- A user in two workspaces with different roles: every check uses the role in the request's workspace, never the first membership's. (Task 3 test.)
- An instance admin who is a member of no workspace opens one from the Workspaces page and acts with admin rights there, and nothing they do lands in another workspace. (Task 3 and Task 8 tests.)
- A removed member's open sessions, CLI tokens and push devices stop working in that workspace at once, not at expiry. (Task 7 test.)
- An invite link used twice, after revocation, after 7 days, or for an email that already belongs to a member: refused, and the answers don't reveal whether the email has an account. (Task 7 test.)
- An archived workspace: the tick publishes nothing for it, its agent keys get 401, its members can't open it, and restoring brings it back unchanged. (Task 8 test.)

---

### Task 1: Migration 0018 and the tests' own seed

**Files:**
- Create: `packages/schema/src/migrations/0018_people.ts`
- Modify: `packages/schema/src/migrations/index.ts` (append `{ name: "0018_people", steps: people }`)
- Generated: `migrations/sqlite/0018_people.sql`, `migrations/postgres/0018_people.sql`, `docs/schema.md`, `packages/schema/schema.json` (`pnpm --filter @bongsu/schema generate`)
- Modify: `apps/cloudflare/test/apply-migrations.ts`, `apps/node/test/*.test.ts` where they rely on the seeded rows
- Test: `packages/schema/test/sqlite.test.ts`, `packages/schema/test/postgres.test.ts`

**Interfaces:**
- Produces (schema): `users.instance_admin` bool default 0; `memberships.role` values `admin/editor/creator`; `workspaces.archived_at` timestamp NULL; `workspace_settings.paused` json NULL; `sessions.workspace_id` text NULL; `media_store.inbox_workspace` text NULL; table `invites` (`token_hash` id pk, `workspace_id` id not null → workspaces.id, `email` text not null, `role` text not null values admin/editor/creator, `invited_by` text not null, `created_at` timestamp not null, `expires_at` timestamp not null, `used_at` timestamp, `used_by` text, `revoked_at` timestamp; index `invites_workspace` (workspace_id)).

- [ ] **Step 1: Write the failing test** in `packages/schema/test/sqlite.test.ts`: `it("0018 converts roles, moves the pause and drops the empty seed")`. Apply migrations up to 0017 on a fresh SQLite, insert a `paused` settings row and an `approver` and a `viewer` membership for a second workspace `b` with users `bea`/`cy`, apply 0018, then assert: `SELECT role FROM memberships WHERE workspace_id='b' ORDER BY user_id` → `[{role:"creator"},{role:"editor"}]`; `SELECT paused FROM workspace_settings WHERE workspace_id='default'` → the moved JSON (when `default` held data) and no `settings` row `paused`; on a second fresh database with nothing added, `SELECT COUNT(*) FROM workspaces` → 0 and `SELECT COUNT(*) FROM users` → 0.
- [ ] **Step 2: Run it** — `pnpm --filter @bongsu/schema exec vitest run test/sqlite.test.ts` — Expected: FAIL (no 0018).
- [ ] **Step 3: Write `0018_people.ts`**: `addColumn` steps for the five columns, `createTable: "invites"`, and `sql` steps per dialect:
  - roles: SQLite rebuilds `memberships` (new table with `CHECK (role IN ('admin','editor','creator'))`, `INSERT … SELECT … CASE role WHEN 'owner' THEN 'admin' WHEN 'approver' THEN 'creator' WHEN 'viewer' THEN 'editor' ELSE role END`, drop, rename, recreate its primary key); Postgres `UPDATE` the values, then `ALTER TABLE memberships DROP CONSTRAINT memberships_role_check, ADD CONSTRAINT memberships_role_check CHECK (…)`; `apply` sets `t.memberships.columns.role.values = ["admin","editor","creator"]`.
  - pause: `UPDATE workspace_settings SET paused = (SELECT value FROM settings WHERE key = 'paused') WHERE workspace_id = 'default'`; `DELETE FROM settings WHERE key = 'paused'`.
  - the seed: delete the `default` workspace (its `workspace_settings`, its memberships) and the `owner` user when the workspace has no accounts, plan_items, drafts, connections or memberships other than `owner`, and `owner` has no email (written as `DELETE … WHERE NOT EXISTS (…)` chains, portable).
- [ ] **Step 4: Generate and run** — `pnpm --filter @bongsu/schema generate && pnpm --filter @bongsu/schema exec vitest run --testTimeout 120000` — Expected: PASS (36+ tests, the generated-files test included).
- [ ] **Step 5: Give the test suites their seed**: in `apps/cloudflare/test/apply-migrations.ts`, after the migrations, insert workspace `default` ('Default'), its `workspace_settings` (Asia/Seoul, 8, en), user `owner` (`instance_admin` 1), membership `(default, owner, admin)`, all `ON CONFLICT DO NOTHING`; the same rows in the Node tests' setup where they use `default`/`owner`. Run `pnpm --filter @bongsu/cloudflare exec vitest run test/health.test.ts test/workspaces.test.ts` — Expected: PASS.
- [ ] **Step 6: Commit** — `feat(schema): migration 0018: instance admins, new roles, invites, archiving, pause per workspace`

### Task 2: Roles, scopes and the three guards

**Files:**
- Create: `packages/core/src/roles.ts`
- Modify: `packages/api/src/agent/auth.ts` (`ROLE_SCOPES`), `packages/api/src/dashboard/routes.ts` (guards, creators refused), `packages/api/src/pwa/routes.ts` (`NEEDS` unchanged scopes, `callerFor`), `packages/dashboard/src/App.tsx` (sidebar by role)
- Test: `apps/cloudflare/test/roles.test.ts` (new), `apps/cloudflare/test/security.test.ts` (update the `roles` describe)

**Interfaces:**
- Produces: `export const ROLES = ["admin", "editor", "creator"] as const; export type Role = (typeof ROLES)[number]` and `export async function isInstanceAdmin(db: Db, userId: string): Promise<boolean>` in `core/roles.ts`; `ROLE_SCOPES: Record<Role, Scope[]>`; dashboard context variable `instanceAdmin: boolean` set beside `role`.
- Guards (dashboard, after the session middleware): `INSTANCE = /^\/admin-api\/(workspaces|media-stores|oauth-apps|instance-admins)/` → `instanceAdmin` for every method (GET included: the instance's settings aren't the workspace's); `MANAGING = /^\/admin-api\/(members|invites|keys|accounts|videos|connections|settings|connect\/)/` → non-GET needs `role === "admin"` or `instanceAdmin`; a session whose role is `creator` (and not instance admin) gets 403 `{ error: "creators use the Bongsu app", app: true }` on every `/admin-api/*` route except `/admin-api/state` and `/admin-api/signout`.

- [ ] **Step 1: Write the failing tests** in `roles.test.ts`, one `it` per row of the spec's table, for `admin`, `editor`, `creator` and an instance admin with no membership: e.g. `expect((await asRole("editor")("/admin-api/connections", {...})).status).toBe(403)`, `expect((await asRole("creator")("/admin-api/overview")).status).toBe(403)` with `json.app === true`, `expect((await asRole("admin")("/admin-api/media-stores")).status).toBe(403)`, `expect((await asInstanceAdmin()("/admin-api/media-stores")).status).toBe(200)`, PWA: editor `/app-api/approve/options` → 403, creator → 404 (allowed; no item), editor `/app-api/pause` → 403.
- [ ] **Step 2: Run** `pnpm --filter @bongsu/cloudflare exec vitest run test/roles.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `core/roles.ts`, the new `ROLE_SCOPES`, the dashboard guards and the creators' refusal; the dashboard hides the Instance group unless `/admin-api/state` says `instanceAdmin: true`, and shows "Creators use the Bongsu app" with a link to `/` on a 403 with `app: true`. Update the `security.test.ts` roles test to the new roles.
- [ ] **Step 4: Run** `… vitest run test/roles.test.ts test/security.test.ts test/dashboard.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit** — `feat(api,dashboard): admin, editor and creator roles, and the instance admin, in every route`

### Task 3: A request's workspace

**Files:**
- Modify: `packages/core/src/workspaces.ts`, `packages/api/src/pwa/session.ts`, `packages/api/src/dashboard/routes.ts` (session middleware), `packages/api/src/pwa/routes.ts` (`callerFor`, `me`)
- Test: `apps/cloudflare/test/roles.test.ts`

**Interfaces:**
- Produces: `export async function sessionWorkspace(db: Db, s: { userId: string; workspaceId: string | null }): Promise<{ workspaceId: string; role: Role | null; instanceAdmin: boolean } | null>` in `core/workspaces.ts`: the session's `workspace_id` when the user is a member there or an instance admin and the workspace isn't archived, else the user's first non-archived membership, else null; `role` is the membership's (`"admin"` for an instance admin without one). `Session` gains `workspaceId: string | null`; `export async function setSessionWorkspace(db: Db, token: string, workspaceId: string): Promise<void>`.
- The PWA's `me(c)` no longer falls back to `OWNER` for signed-in routes: a request without a caller is 401 (the `OWNER` constant stays only for the signed-out routes that need none).

- [ ] **Step 1: Failing test** `it("uses the role of the request's workspace for a user in two")`: user `dee` is `editor` in `default` and `admin` in `b`; a dashboard session with `workspace_id = 'b'` can `POST /admin-api/settings` (200), the same user with `workspace_id = 'default'` gets 403; `sessionWorkspace` returns null for a user whose only workspace is archived.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** `sessionWorkspace`, `setSessionWorkspace`, `validSession` returning `workspaceId`; both middlewares call `sessionWorkspace` and 403 `{ error: "you're not a member of any workspace", noWorkspace: true }` when it's null.
- [ ] **Step 4: Run** `… vitest run test/roles.test.ts test/workspaces.test.ts test/app.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit** — `feat(core,api): every request works in its session's workspace, with that workspace's role`

### Task 4: First run: an instance admin, then the first workspace

**Files:**
- Create: `packages/core/src/people.ts` (users and workspaces: create, rename, archive)
- Modify: `packages/api/src/dashboard/routes.ts` (bootstrap, `/admin-api/state`, `POST /admin-api/workspaces`), `packages/dashboard/src/App.tsx`, `packages/dashboard/src/pages.tsx` (`FirstWorkspace`)
- Test: `apps/cloudflare/test/first-run.test.ts` (new)

**Interfaces:**
- Produces: `export async function createUser(db: Db, o: { email: string; name: string | null; instanceAdmin?: boolean }, nowS: number): Promise<string>` (id `u_<16 hex>`); `export async function createWorkspace(db: Db, o: { name: string; timezone: string; createdBy: string }, nowS: number): Promise<string>` (id `w_<16 hex>`, with its `workspace_settings` row: the zone given, digest 8, `en`); `export async function addMember(db: Db, workspaceId: string, userId: string, role: Role, nowS: number): Promise<void>`.
- `/admin-api/state` adds `instanceAdmin: boolean` and `noWorkspace: boolean`. `POST /admin-api/workspaces` `{ name, timezone, admin: "me" | <email> }` → `{ id, invite?: { url } }` (instance admins; `admin: <email>` makes an invite through Task 7's `createInvite`, so this route gets that branch in Task 7).
- Bootstrap: `registrationOptions(…, { id: <new id> })` with the user created at verify (`createUser(…, { instanceAdmin: true })`), no membership; the `bootstrap_done` flag stays.

- [ ] **Step 1: Failing test** `it("bootstraps an instance admin with no workspace, who creates the first one as its admin")`: on a database with no users/workspaces (delete the test seed in a `beforeEach`), bootstrap → `state` is `{ signedIn: true, instanceAdmin: true, noWorkspace: true }`; `POST /admin-api/workspaces { name: "Demo Travel", timezone: "Europe/Madrid", admin: "me" }` → 200; then `state.noWorkspace` is false, `GET /admin-api/settings` → `{ timezone: "Europe/Madrid" }`, and `SELECT role FROM memberships` → `admin`.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** `people.ts`, the bootstrap change, the state fields, the route; in the dashboard, `noWorkspace` shows `FirstWorkspace` (name, time zone from the browser, first admin: "Me" radio or an email) instead of the sidebar.
- [ ] **Step 4: Run** `… vitest run test/first-run.test.ts test/dashboard.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit** — `feat(core,api,dashboard): the first run: the setup token makes an instance admin, who creates the first workspace`

### Task 5: No silent fallback to `default`

**Files:**
- Modify: every non-test use of `DEFAULT_WORKSPACE` and of the user id `"owner"` outside the migration's data move: `packages/core/src/{accounts,connections,data,inbox,tick,workspaces}.ts`, `packages/core/src/media/manage.ts`, `packages/api/src/pwa/{approve,routes,schedule,uploads}.ts`, `packages/api/src/dashboard/routes.ts`, `packages/api/src/pwa/session.ts` (`createSession` requires `userId`)
- Modify: `packages/core/src/media/index.ts` (`StoreRow.inboxWorkspace`), dashboard Media page (an "Inbox feeds" select per store)
- Test: `apps/cloudflare/test/media-stores.test.ts`, `apps/cloudflare/test/inbox.test.ts`, `packages/core/test/no-default-fallback.test.ts` (new)

**Interfaces:**
- Produces: `export async function inboxWorkspace(db: Db, store: string, project: string): Promise<string | null>`: the workspace of a plan item whose folder ends with `/<project>`, else `media_store.inbox_workspace` of that store, else null (the draft waits). `checkStores` notifies through `notifyInstanceAdmins(env, fetcher, note, nowS)` (mail to every `instance_admin` with an email when a `Mailer` is set; always the audit row with `workspace_id` NULL).

- [ ] **Step 1: Failing tests**: `no-default-fallback.test.ts` greps `packages/core/src` and `packages/api/src` for `DEFAULT_WORKSPACE` and `"owner"`/`'owner'` used as a user id and fails on any file outside an allowlist (`accounts.ts` export of the constant, the migration's code); `inbox.test.ts` `it("drafts a known project into its plan's workspace, an unknown one into the store's inbox workspace, and waits without one")`; `media-stores.test.ts` `it("tells the instance admins when a store breaks")` with a mailer stub: one mail to the instance admin's email.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Replace each fallback** with the caller's workspace (routes), the item's or account's (core jobs), `inboxWorkspace` (inbox), `notifyInstanceAdmins` (store check); `POST /admin-api/media-stores/:kind/inbox` `{ workspace: id | null }` for instance admins.
- [ ] **Step 4: Run** `pnpm --filter @bongsu/core test && … vitest run test/inbox.test.ts test/media-stores.test.ts test/workspaces.test.ts test/app.test.ts test/tick.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit** — `refactor(core,api): nothing falls back to the default workspace; the inbox's drafts go to their workspace`

### Task 6: Pause and resume per workspace

**Files:**
- Modify: `packages/core/src/data.ts` (`pausedState`, `setPaused`, `clearPaused` take `workspaceId`), `packages/core/src/tick.ts`, `packages/api/src/agent/ops.ts`, `packages/api/src/pwa/routes.ts` (pause, resume), `packages/core/src/digest.ts`
- Test: `apps/cloudflare/test/pause.test.ts` (new)

**Interfaces:**
- Produces: `pausedState(db: Db, workspaceId: string): Promise<{ reason: string; by: string; at: string } | null>`, `setPaused(db, workspaceId, reason, by, now): Promise<boolean>`, `clearPaused(db, workspaceId): Promise<boolean>`; the tick reads the paused and archived workspaces once per run and skips their jobs (`jobs.workspace_id`), Shorts comments included.

- [ ] **Step 1: Failing test** `it("pausing one workspace holds only its jobs; resuming only resumes it")`: two approved Reels due, one per workspace; pause `b` from the app as its creator; one tick → `default`'s job advances, `b`'s stays `pending`; `/v1/status` with a `b` key → `paused: true`, with a `default` key → false; resume in `b` → its job advances next tick.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** the signatures and the tick's skip; the audit rows carry the workspace.
- [ ] **Step 4: Run** `… vitest run test/pause.test.ts test/tick.test.ts test/api.test.ts test/app.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit** — `feat(core,api): pause and resume one workspace, not the whole instance`

### Task 7: Invites and the Members page

**Files:**
- Create: `packages/core/src/invites.ts`
- Modify: `packages/api/src/dashboard/routes.ts` (members, invites, invite acceptance), `packages/api/src/pwa/routes.ts` (invite acceptance for creators), `packages/dashboard/src/pages.tsx` (`Members`, `AcceptInvite`), `packages/dashboard/src/App.tsx` (`/dashboard/invite/<token>`), `packages/web/src/App.tsx` (`/#/invite/<token>`), `packages/web/src/i18n.ts`, `packages/core/src/texts/` (the invite email)
- Test: `apps/cloudflare/test/invites.test.ts` (new)

**Interfaces:**
- Produces: `export const INVITE_S = 7 * 86400`; `export async function createInvite(env: Env, fetcher: typeof fetch, o: { workspaceId: string; email: string; role: Role; invitedBy: string }, nowS: number): Promise<{ url: string }>` (url `<PUBLIC_URL>/dashboard/invite/<token>` for admin/editor, `<PUBLIC_URL>/#/invite/<token>` for creator; mailed when a `Mailer` is set); `export async function inviteFor(db: Db, token: string, nowS: number): Promise<{ workspaceName: string; role: Role; email: string } | null>`; `export async function acceptInvite(db: Db, token: string, userId: string, nowS: number): Promise<{ workspaceId: string; role: Role }>` (throws `InviteError` when used, revoked, expired); `export async function removeMember(db: Db, workspaceId: string, userId: string, by: { instanceAdmin: boolean }): Promise<void>` (deletes the membership, the user's sessions with that `workspace_id`, their `api_keys` with that `workspace_id` and `user_id`, their `push_subs` in it; refuses the last admin unless `by.instanceAdmin`); `setRole(db, workspaceId, userId, role, by)` with the same last-admin rule.
- Routes (dashboard, MANAGING): `GET /admin-api/members` → `{ members: { userId, email, name, role }[], invites: { id, email, role, expiresAt }[] }`; `POST /admin-api/invites { email, role }` → `{ url }`; `POST /admin-api/invites/:id/revoke`; `POST /admin-api/members/:userId { role }`; `POST /admin-api/members/:userId/remove`. Acceptance, signed out: `GET /admin-api/invite/:token` and `GET /app-api/invite/:token` → `{ workspace, role }` (or 404, the same answer for every failure); `POST …/invite/:token/options` and `…/verify` (new email: name + passkey, creates the user; an existing user: sign in with their passkey, then join).

- [ ] **Step 1: Failing tests**: `it("invites a new person as creator, who signs up in the app and lands in the workspace")`; `it("lets an existing user join with their passkey, without saying the email exists")` (the options answer for a known and an unknown email has the same shape); `it("refuses an invite used, revoked or older than 7 days")` (404 each); `it("keeps the last admin")` (admin removing themself → 409; the instance admin → 200); `it("cuts a removed member off at once")` (their dashboard session gets 403 `noWorkspace`, their CLI token 401, their push device gets nothing); editors get 403 on every member route.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** `invites.ts`, the routes (`fresh(c)` on invite, role change, remove, revoke), the Members page (list, Invite form with role select, Copy link, Revoke, Change role, Remove with confirm), the acceptance pages in both apps; `POST /admin-api/workspaces` gets its `admin: <email>` branch.
- [ ] **Step 4: Run** `… vitest run test/invites.test.ts test/first-run.test.ts test/roles.test.ts test/push.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit** — `feat(core,api,dashboard,web): members and invites: a one-time link per person, roles changed and removed by admins`

### Task 8: The Workspaces page and archiving

**Files:**
- Modify: `packages/core/src/people.ts` (`renameWorkspace`, `archiveWorkspace`, `restoreWorkspace`, `setInstanceAdmin`), `packages/api/src/dashboard/routes.ts`, `packages/api/src/agent/auth.ts` (keys of an archived workspace refused), `packages/core/src/tick.ts` (archived skipped, with Task 6's read), `packages/dashboard/src/pages.tsx` (`Workspaces`), `packages/dashboard/src/App.tsx` (the Instance group: Workspaces, Media, OAuth apps)
- Test: `apps/cloudflare/test/workspaces-admin.test.ts` (new)

**Interfaces:**
- Produces: routes (INSTANCE guard): `GET /admin-api/workspaces` → `{ workspaces: { id, name, members, accounts, createdAt, archivedAt }[] }`; `POST /admin-api/workspaces/:id { name }`; `POST /admin-api/workspaces/:id/admins { email }` → `{ url }`; `POST /admin-api/workspaces/:id/archive`, `/restore`; `POST /admin-api/workspaces/:id/open` (sets the session's workspace, `setSessionWorkspace`); `POST /admin-api/instance-admins { userId, on: boolean }` (never removes the last one).

- [ ] **Step 1: Failing test** `it("archives a workspace: nothing publishes, its keys and members are refused, restoring brings it back")` with an approved Reel due in `b`, a `b` agent key and a `b` member; and `it("opens any workspace for an instance admin who isn't a member, acting as its admin")`.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** the core functions, routes, the key refusal (`authenticate` joins `workspaces` and rejects `archived_at IS NOT NULL`), the page (table, Create, Rename, Add admin with Copy link, Archive/Restore with confirm, Open), the sidebar group.
- [ ] **Step 4: Run** `… vitest run test/workspaces-admin.test.ts test/pause.test.ts test/security.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit** — `feat(core,api,dashboard): the instance admin's Workspaces page: create, rename, add admins, archive, open`

### Task 9: Creators connect their accounts in the app

**Files:**
- Modify: `packages/core/src/connections.ts` (`startConnect` takes `back: "dashboard" | "app"`, kept in `oauth_states`), `packages/api/src/dashboard/routes.ts` (the callback redirects by `back`), `packages/api/src/pwa/routes.ts` (`POST /app-api/connect/:provider/start`, admins and creators), `packages/web/src/App.tsx` (Settings: Connect Instagram, Connect YouTube, Reconnect; the `?connected=`/`?error=` return), `packages/web/src/i18n.ts`
- Test: `apps/cloudflare/test/connect.test.ts`

**Interfaces:**
- Consumes: `authorizeUrl`, `takeState` (`core/connections.ts`). `oauth_states.connection_id` is unchanged; the return target is stored by encoding the flow as `<provider>` or `<provider>@app` in `oauth_states.provider` (no schema change), and `takeState` accepts either for that provider.

- [ ] **Step 1: Failing test** `it("connects a creator's YouTube channel from the app into their workspace and returns to the app")`: a creator in `b` starts from `/app-api/connect/youtube/start` → Google URL; the callback (no cookie) → 302 to `https://bongsu.test/#/settings?connected=…`; the new account's `workspace_id` is `b`; an editor gets 403 on the start route.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** the route, the `back` handling and the app's Settings section (shown to admins and creators; without the instance's OAuth app it says the instance admin must add it).
- [ ] **Step 4: Run** `… vitest run test/connect.test.ts test/roles.test.ts` and `pnpm --filter @bongsu/web test` — Expected: PASS.
- [ ] **Step 5: Commit** — `feat(core,api,web): creators connect their own accounts from the app`

### Task 10: Docs, PLAN, changeset, isolation

**Files:**
- Modify: `site/docs/the-dashboard.md` (Workspaces, Members, the Instance group, first run), `site/docs/the-app.md` (invites, connecting, pause per workspace), `site/docs/security.md` (roles table, instance admin), `site/docs/deploy-cloudflare.md` and `site/docs/self-hosting.md` (the first run), `docs/PLAN.md` (Phase 13 boxes for #18, #19, #20 ticked; #33's creator part), `apps/cloudflare/test/workspaces.test.ts` (every new route checked for isolation)
- Create: `.changeset/phase-13-people.md` (minor for core, api, web, dashboard, cloudflare, node, schema; the update steps: migration 0018, roles converted, `owner` becomes an instance admin only on a fresh instance)

- [ ] **Step 1:** Extend `workspaces.test.ts` with the members, invites, workspaces and connect-from-the-app routes: a `b` admin can't list, invite into, rename or archive `default`, and gets 404 for `default`'s invite ids.
- [ ] **Step 2: Run** `… vitest run test/workspaces.test.ts` — Expected: PASS.
- [ ] **Step 3:** Write the docs and the changeset; `pnpm site` — Expected: `build-site: public/ ready` (no dead links).
- [ ] **Step 4:** `pnpm check && pnpm typecheck` and `pnpm --filter @bongsu/core test`, `@bongsu/schema`, `@bongsu/web`, `@bongsu/node` — Expected: PASS.
- [ ] **Step 5: Commit** — `docs(docs): people, roles, invites and workspaces in the guides; Phase 13 part 1 ticked`
