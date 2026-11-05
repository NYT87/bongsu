# Phase 13 part 3a: media and OAuth apps per workspace — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each workspace's media and OAuth apps belong to it: a folder per workspace in the instance's stores, a
workspace's own stores and OAuth apps reachable only from inside it, a cron that keeps workspaces apart and within its
budget, and a read-only Scheduler section for instance admins.

**Architecture:** `media_store` gets an `id` and a nullable `workspace_id`; `mediaStores(env, fetcher, workspaceId)`
returns the instance's stores plus the workspace's own. Every `UPLOADS` path goes through `mediaPath(folder, rest)`
with the workspace's `media_folder`. One check, `ownsRef`, guards every media reference a caller hands in. OAuth apps
resolve workspace-first, with the choice recorded on the flow (`oauth_states.app_scope`).

**Tech Stack:** TypeScript, Hono (`packages/api`), React + Vite (`packages/dashboard`, `packages/web`), the neutral
schema (`packages/schema`), Vitest with the Workers pool and the fake world (`apps/cloudflare/test`), better-sqlite3
and PGlite (`apps/node`).

**Spec:** `docs/superpowers/specs/2026-11-05-phase13-part3a-media-oauth-per-workspace-design.md`

## Global Constraints

- Node 22: `export PATH=$HOME/.nvm/versions/node/v22.14.0/bin:$PATH` before any `pnpm`.
- Run the focused tests locally (`pnpm --filter @bongsu/cloudflare exec vitest run test/<file> --testTimeout 120000
  --maxWorkers=2`, `pnpm --filter @bongsu/core test`); `pnpm check` and `pnpm typecheck` before each commit. CI runs the
  full suite.
- Portable SQL only (`packages/core/test/portable-sql.test.ts`): no `unixepoch()`, `json_each`, partial indexes;
  timestamps from the app.
- Guards use the router's area tags (`AREAS` in `packages/api/src/dashboard/routes.ts`), never the raw URL.
- `core` and `api` stay runtime-independent.
- No personal data: demo accounts (`demo_travel`, …), `example.com`, workspace names like "Demo Studio".
- Conventional Commits ≤ 100 characters, scopes from AGENTS.md, body `Refs #21` / `Refs #24`, ending with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never `--no-verify`. Commit only; never push.
- Workspace ids are `w_<16 hex>` (`createWorkspace`), plus the seeded `default`.
- Folder rule (spec §1): 1–60 characters; letters, digits, `-`, `_` and spaces; not `.` or `..`; unique among
  workspaces.
- Store ids: `drive` / `s3` / `local` for the instance's; `drive-<workspaceId>` / `s3-<workspaceId>` for a workspace's
  own (no `local`).
- Refusal text for a foreign reference, exactly: `not in this workspace's media`.

## Rulings made while planning (the spec is silent or slightly off)

1. **App uploads** today go to a top folder `Bongsu app uploads` (`APP_FOLDER`, `pwa/uploads.ts`), not to the inbox.
   They move to `<media_folder>/_uploads` (the inbox scan skips `_` folders and this isn't under `inbox/` anyway). The
   spec's §3 "under `<folder>/inbox/<project>/`" is corrected to this in Task 10's docs pass.
2. **Existing workspaces' folder** (migration data step): `UPLOADS` for the seeded `default` workspace, the workspace
   id for any other (portable SQL can't slug a name). New workspaces get the slug from their name. There are no running
   instances, so this only touches dev and test data, and it keeps every existing `UPLOADS/...` fixture valid.
3. **`media_folder` is nullable in the database** (adding a NOT NULL column without a default fails on SQLite with rows
   present) with a unique index; `createWorkspace` always sets it, and `workspaceSettings` falls back to the workspace
   id if a row has none.
4. **The Scheduler's limits come from what the cron recorded**, not from the API's own env: on Cloudflare the
   variables (`JOBS_PER_TICK`, `INBOX_WORKSPACES_PER_RUN`) live on the cron Worker, which the dashboard's Worker can't
   read. Each tick writes `tick_last:<instagram|shorts>` and the inbox run `inbox_last` in `settings`.
5. **Drive caches become per store.** `folderIds` (in `drive.ts`) is keyed by path alone and the settings key
   `drive_upload_folder:<name>` too: with two Drive stores (the instance's and a workspace's) they'd collide. Both get
   the store id in their key.
6. **`MediaStore` gains `inside(id, folderPath)`**, so S3 and local answer from the key without a request, and Drive
   and memory walk `parent`. `ownsRef` uses it.
7. **Scheduling a draft** (`pwa/schedule.ts`) also runs `ownsRef` on its media, as a last check: a draft's payload may
   predate this change or come from a path that skipped it.

## Review Focus

1. **Two Drive stores in one Worker** (instance and a workspace's): a folder resolved for one must never be served for
   the other. Test in Task 2: two `DriveStore`s on different grants resolve the same path to different ids.
2. **A folder renamed while items wait:** items given by path now resolve under the new folder and show "not in the
   media store yet"; nothing crashes and nothing reads another workspace's folder. Test in Task 3.
3. **A workspace's own store removed while a draft references it:** the draft shows the file as missing ("…on the
   s3-w_… store, which isn't set up"); scheduling it refuses. Test in Task 4.
4. **The cursor after a workspace is archived or added:** the scan keeps going round without skipping or repeating
   one forever. Test in Task 5 (archive the workspace the cursor points at).
5. **An OAuth flow started in workspace A finished after the user switched to B:** the grant still lands in A with A's
   app (state carries both). Test in Task 6.

---

### Task 1: Migration 0022 and the folder per workspace

**Files:**
- Create: `packages/schema/src/migrations/0022_workspace_media.ts`
- Modify: `packages/schema/src/migrations/index.ts` (register it), `migrations/sqlite/`, `migrations/postgres/`,
  `docs/schema.md` (generated: `pnpm --filter @bongsu/schema generate`)
- Create: `packages/core/src/media/folders.ts`
- Modify: `packages/core/src/workspaces.ts` (`WorkspaceSettings.mediaFolder`, `setMediaFolder`),
  `packages/core/src/people.ts` (`createWorkspace` sets the folder), `scripts/dev-seed.sh`,
  `scripts/screenshots/seed.mjs`
- Test: `packages/core/test/folders.test.ts`, `packages/schema/test/` (existing generate/snapshot tests),
  `apps/node/test/postgres.test.ts` (runs 0022)

**Interfaces:**
- Produces:
  - `mediaPath(folder: string, rest = ""): string` → `"<folder>"` or `"<folder>/<rest>"` (rest without leading `/`).
  - `checkFolderName(name: string): string` → the trimmed name, or throws `FolderError` with why.
  - `folderSlug(name: string): string` → lowercase, spaces → `-`, other disallowed characters dropped, cut to 60,
    `"workspace"` when empty.
  - `uniqueFolder(db: Db, base: string, exceptWorkspace?: string): Promise<string>` → `base`, else `base-2`, `base-3`…
  - `class FolderError extends Error`.
  - `WorkspaceSettings.mediaFolder: string` (`workspaceSettings`, falling back to the workspace id).
  - `setMediaFolder(db: Db, workspaceId: string, name: string, nowS: number): Promise<string>`: checks, refuses a name
    another workspace has (`FolderError("another workspace uses <name>")`), saves, returns it.
  - `createWorkspace(db, { name, timezone, createdBy, mediaFolder? }, nowS)`: `mediaFolder` checked if given, else
    `uniqueFolder(db, folderSlug(name))`.
- Schema after 0022:
  - `media_store`: `id` (id, primary key), `kind` (text: drive / s3 / local, not null), `workspace_id` (text,
    nullable), `is_default`, `settings`, `credentials`, `status`, `last_error`, `last_checked_at`, `updated_at`,
    `updated_by`. No `inbox_workspace`.
  - `workspace_settings.media_folder` (text, nullable) with a unique index `workspace_settings_media_folder`.
  - `workspace_oauth_apps` (`workspace_id` text, `id` text, `client_id` text, `client_secret` text "encrypted
    (core/crypto.ts)", `updated_at` timestamp, `updated_by` text nullable; primary key (`workspace_id`, `id`)).
  - `oauth_states.app_scope` (text, nullable; values `workspace` / `instance`).

- [ ] **Step 1: Write the failing core tests** in `packages/core/test/folders.test.ts`:
  `mediaPath("UPLOADS", "inbox")` is `"UPLOADS/inbox"`, `mediaPath("demo-studio")` is `"demo-studio"`;
  `folderSlug("Demo Studio")` is `"demo-studio"`, `folderSlug("Ünïcode / x")` keeps only allowed characters,
  `folderSlug("///")` is `"workspace"`; `checkFolderName` refuses `""`, `"."`, `".."`, `"a/b"`, a 61-character name,
  and accepts `"Client A_2"`.
- [ ] **Step 2: Run them, expect failures** (`pnpm --filter @bongsu/core exec vitest run test/folders.test.ts`).
- [ ] **Step 3: Write `folders.ts`** with the signatures above.
- [ ] **Step 4: Write migration 0022.** `media_store` is rebuilt with one `sql` step (same text for both dialects):
  create `media_store_new`, copy (`id = kind`, `workspace_id = NULL`), drop `media_store`, rename; its `apply` sets the
  new columns on `t.media_store` and deletes `inbox_workspace`. `media_folder`: `addColumn`, then a `sql` step
  `UPDATE workspace_settings SET media_folder = CASE WHEN workspace_id = 'default' THEN 'UPLOADS' ELSE workspace_id
  END`, then `createIndex` (unique). `workspace_oauth_apps`: `createTable`. `app_scope`: `addColumn`. Each with a
  description for `docs/schema.md`. Regenerate.
- [ ] **Step 5: Wire `createWorkspace`, `workspaceSettings`, `setMediaFolder`;** add `media_folder` to both seeds
  (`'UPLOADS'` for `default`).
- [ ] **Step 6: Run** core tests, `pnpm --filter @bongsu/schema test`, `pnpm --filter @bongsu/node exec vitest run
  test/postgres.test.ts`, and the Cloudflare `first-run.test.ts` + `workspaces-admin.test.ts` (workspace creation).
  Add to `workspaces-admin.test.ts`: two workspaces named "Demo Studio" and "Demo Studio" get `demo-studio` and
  `demo-studio-2`.
- [ ] **Step 7: Commit** `feat(schema,core): a media folder per workspace, stores and OAuth apps scoped by workspace`.

### Task 2: Stores scoped by workspace

**Files:**
- Modify: `packages/core/src/media/index.ts`, `packages/core/src/media/manage.ts`, `packages/core/src/media/store.ts`
  (`inside`), `packages/core/src/media/drive.ts`, `packages/core/src/media/s3.ts`, `packages/core/src/media/memory.ts`,
  `packages/core/src/media/conformance.ts`, `apps/node/src/local-store.ts`, `packages/api/src/dashboard/routes.ts`
  (instance Media routes), `packages/dashboard/src/pages.tsx` (Media page: drop the inbox picker)
- Test: `packages/core/test/media-memory.test.ts`, `packages/core/test/media-s3.test.ts`,
  `apps/cloudflare/test/media-stores.test.ts`, `apps/node/test/node.test.ts` (local store conformance)

**Interfaces:**
- Consumes: Task 1's schema.
- Produces:
  - `type StoreScope = { workspaceId: string | null }`; `storeId(kind: StoreKind, workspaceId: string | null): string`.
  - `StoreRow` gains `id: string`, `workspaceId: string | null`; loses `inboxWorkspace`.
  - `storeRows(db: Db, scope?: StoreScope): Promise<StoreRow[]>`: no scope = every row; `{workspaceId: null}` = the
    instance's; `{workspaceId: w}` = the instance's plus w's own.
  - `mediaStores(env, fetcher, workspaceId?: string | null): Promise<MediaStores>`: without it (or null) the instance's
    stores only. `MediaStores.default`: the workspace's own default if any, else the instance's default.
  - `buildStore(env, fetcher, kind, settings, credentials, id = kind)`: each store class takes its `id`.
  - `MediaStore.inside(id: string, folderPath: string): Promise<boolean>`: true when the file is anywhere below the
    folder.
  - `manage.ts`, each taking a `StoreScope` after `env` (instance pages pass `{workspaceId: null}`):
    `saveStore(env, fetcher, scope, kind, settings, credentials, userId, nowS)`,
    `setDefaultStore(env, scope, kind, nowS)` (clears the other defaults in that scope only),
    `removeStore(env, scope, kind, nowS)`, `savedCredentials(env, scope, kind)`,
    `waitingApprovalsIn(env, id)` (by store id). `setInboxWorkspace` is deleted.
  - `removeStore` with a workspace scope throws `StoreError("<n> approved items use this store: <keys>")` while an
    approved, unpublished item references it.
  - `checkStores`: an instance store's problem goes to `notifyInstanceAdmins` (as today); a workspace store's to that
    workspace through `Notifier.send(mediaStoreProblem(...), workspaceId)` with group `problems`. It checks
    `mediaPath(<a folder>)` is reachable by testing the store's root listing instead of `UPLOADS` (a store no longer has
    one fixed top folder): `store.list` of the root succeeds.

- [ ] **Step 1: Write the failing tests.** In the conformance cases: `inside(file, "UPLOADS/inbox")` true,
  `inside(file, "UPLOADS/_posted")` false, `inside(file, "UPLOADS/inbox/tr")` false (a prefix of a folder name isn't
  the folder). In `media-stores.test.ts`: a workspace store row and an instance row of the same kind both load, with
  ids `s3` and `s3-<ws>`; `mediaStores(env, f, A)` holds `s3` and `s3-A` but not `s3-B`; `mediaStores(env, f)` holds
  only `s3`; making A's own store default leaves the instance default untouched; removing A's store with an approved
  unpublished item refuses with the item's key; a broken A store notifies A's members only (fake push), an instance
  one the instance admins. Review Focus 1: two `DriveStore`s on different grants resolve `UPLOADS/inbox` to their own
  folder ids (fake Drive in `world.ts`).
- [ ] **Step 2: Run, expect failures.**
- [ ] **Step 3: Implement** the interfaces above. Drive: `folderIds` key `${this.id}:${path}` and
  `drive_upload_folder:${this.id}:${name}`; `removeStore` clears `inbox_folder:<id>:%` and
  `drive_upload_folder:<id>:%`. S3/local `inside`: decode the id, compare with the folder key plus `/`. Drive/memory:
  resolve the folder, walk `stat(...).parent` at most 20 steps.
- [ ] **Step 4: Instance Media routes** keep their paths, pass `{workspaceId: null}`, drop `inboxWorkspace` and
  `workspaces` from `GET /admin-api/media-stores` and the `/:kind/inbox` route; the dashboard's Media page drops the
  picker.
- [ ] **Step 5: Run** the tests above plus `phase12.test.ts`, `inbox.test.ts` (still green: Task 5 rewrites the scan).
- [ ] **Step 6: Commit** `feat(core,api,dashboard): media stores scoped by workspace`.

### Task 3: Every path under the workspace's folder

**Files:**
- Modify: `packages/core/src/data.ts` (`contentPaths`), `packages/core/src/tick.ts`, `packages/core/src/cleanup.ts`,
  `packages/api/src/pwa/approve.ts`, `packages/api/src/pwa/uploads.ts`, `packages/api/src/pwa/routes.ts` (drafts,
  uploads list, item page), `packages/api/src/agent/ops.ts`, `packages/core/src/media/manage.ts` (`testStore`)
- Test: `apps/cloudflare/test/content.test.ts`, `tick.test.ts`, `phase12.test.ts`, `workspaces.test.ts`

**Interfaces:**
- Consumes: `mediaPath`, `WorkspaceSettings.mediaFolder` (Task 1); `mediaStores(env, fetcher, workspaceId)` (Task 2).
- Produces:
  - `contentPaths(i, folder: string)`: `media` is `mediaPath(folder, "<folder>/exports/…")` /
    `mediaPath(folder, dir)` instead of `UPLOADS/…`. Every caller passes the item's workspace's `mediaFolder`.
  - `APP_FOLDER` is replaced by `appUploads(folder: string) = mediaPath(folder, "_uploads")` (ruling 1).
  - `cleanMedia` moves to `mediaPath(<item's workspace folder>, "_posted")`.
  - `testStore(env, fetcher, kind, settings, credentials, folder = "UPLOADS")` ensures `<folder>/inbox`.
  - Every request-time `mediaStores(...)` call passes the caller's workspace; the tick and cleanup pass the item's.
    `/m` (`app.ts`) keeps `mediaStores(env, fetcher)` plus a lookup by id across all rows: add
    `mediaStoreById(env, fetcher, id): Promise<MediaStore | null>` in `media/index.ts` and use it in `serveMedia`
    (signature: `serveMedia(req, secret, lookup: (id: string) => Promise<MediaStore | null>, nowS)`).

- [ ] **Step 1: Write the failing tests.** Workspace A (`UPLOADS`) and B (`client-b`) share the instance S3 store:
  an item by path in B resolves `client-b/<project>/<name>` and never A's same-named folder; the tick publishes B's
  item from `client-b/…`; cleanup moves B's posted file into `client-b/_posted`; an app upload in B lands in
  `client-b/_uploads` and a draft from it in A is refused (`isn't an upload of this app`). Review Focus 2: after
  `setMediaFolder(B, "client-b2")` B's item shows "not in the media store yet: client-b2/…".
- [ ] **Step 2: Run, expect failures.**
- [ ] **Step 3: Implement.** `serveMedia`'s path pattern becomes `/^\/m\/([a-z0-9][a-z0-9_-]{1,40})\/…/`; the
  signature input stays `${store}/${id}.${exp}`.
- [ ] **Step 4: Run** the four test files and `app.test.ts` (the `/m` route).
- [ ] **Step 5: Commit** `feat(core,api): every media path under the workspace's folder`.

### Task 4: Files stay in their workspace (`ownsRef`)

**Files:**
- Create: `packages/core/src/media/owns.ts`
- Modify: `packages/api/src/agent/ops.ts` (`create_draft` media), `packages/api/src/pwa/uploads.ts`
  (`draftFromUploads`), `packages/api/src/pwa/schedule.ts` (ruling 7), `packages/api/src/agent/mcp*` if it builds
  drafts separately (grep `defaultKind(`)
- Test: `packages/core/test/owns.test.ts`, `apps/cloudflare/test/workspaces.test.ts`, `api.test.ts`

**Interfaces:**
- Consumes: Task 2's `MediaStores`, `inside`; Task 1's folder.
- Produces:
  - `ownsRef(stores: MediaStores, folder: string, ref: Pick<MediaRef, "store" | "id">): Promise<boolean>`:
    false when `stores.get(ref.store)` is null; true for a store whose row has a workspace (its own); else
    `store.inside(ref.id, folder)`. Errors and timeouts → false.
  - `MediaStores.isOwn(id: string): boolean` (the store has a `workspace_id`) for the step above.
  - `assertOwns(stores, folder, refs): Promise<void>` throws `MediaError(400, "not in this workspace's media")`.
  - The agent API's `create_draft` takes file ids in the workspace's default store (`mediaStores(…, ws).default`, not
    `defaultKind`).

- [ ] **Step 1: Write the failing tests.** Core (memory stores): inside the folder true, outside false, another
  store false, own store true, a Drive walk that throws false. Cloudflare, for the agent REST `POST /v1/drafts`, the MCP
  `create_draft` tool, the app's `POST /app-api/drafts/new` and `POST /app-api/drafts/:id/schedule`: a file in B's
  folder, a file in B's own store and a file at the store's root are each refused with 400 `not in this workspace's
  media`; A's file is accepted. Review Focus 3: A's own store removed → the draft's item page lists the file as missing
  and scheduling refuses. `/m`: a link `mediaUrl` signed for A's file serves it; the same path with B's file id and A's
  signature is 403; an expired one 403.
- [ ] **Step 2: Run, expect failures.**
- [ ] **Step 3: Implement** and call `assertOwns` at each entry point.
- [ ] **Step 4: Run** the tests, `security.test.ts`, `content.test.ts`.
- [ ] **Step 5: Commit** `feat(core,api): media references must be in the caller's workspace`.

### Task 5: The inbox per workspace, within budget

**Files:**
- Modify: `packages/core/src/inbox.ts`, `packages/core/src/constants.ts`, `packages/core/src/env.ts`,
  `apps/node/src/env.ts`, `packages/core/src/tick.ts` (`tick_last:<kind>`), `packages/core/src/schedules.ts` (log
  text), `apps/cloudflare/wrangler.cron.toml` (comment → `core/constants.ts`)
- Test: `apps/cloudflare/test/inbox.test.ts`, `tick.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces:
  - `INBOX_WORKSPACES_PER_RUN = 3`, `NODE_INBOX_WORKSPACES_PER_RUN = 20`, `INBOX_WORKSPACES_PER_RUN_MAX = 100` in
    `constants.ts`; `Env.INBOX_WORKSPACES_PER_RUN?: string`; `inboxWorkspacesPerRun(env): number` beside
    `jobsPerTick` (same parsing and clamping).
  - `scanInbox` loops over active workspaces ordered by id, starting after `settings.inbox_cursor`, at most
    `inboxWorkspacesPerRun(env)` of them, and over each one's stores; drafts go to the workspace scanned.
    `inboxWorkspace` and `inbox_workspace` are gone. Folder cache key `inbox_folder:<storeId>:<folder>`.
  - Returns `{ drafted, waiting, reached: string[], waitingWorkspaces: number, note? }` and writes
    `settings.inbox_last` = JSON `{ at, reached: n, total: n, limit: n }`.
  - The tick writes `settings.tick_last:<instagram|shorts>` = JSON `{ at, jobsPerTick }` (one upsert per run).

- [ ] **Step 1: Write the failing tests.** A and B on the same instance store, each with `inbox/trip/a.mp4`: A's file
  drafts into A only, B's into B only; A on the instance store and B on its own store: same. With 5 workspaces and
  `INBOX_WORKSPACES_PER_RUN=2`: three runs reach all five, none reaches more than two, `inbox_last` says `reached 2,
  total 5, limit 2`. Review Focus 4: archive the workspace the cursor points at; the next runs still reach the others
  and no workspace is skipped twice in a row. `inboxWorkspacesPerRun`: `"0"`, `"x"`, `"500"` give 3, 3, 100. The tick
  writes `tick_last:instagram` with its `jobsPerTick`.
- [ ] **Step 2: Run, expect failures.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `inbox.test.ts`, `tick.test.ts`, `scenario.test.ts`.
- [ ] **Step 5: Commit** `feat(core,cloudflare,node): the inbox scans each workspace's folder, within a budget`.

### Task 6: OAuth apps per workspace

**Files:**
- Modify: `packages/core/src/connections.ts`, `packages/core/src/media/manage.ts` (Drive connect),
  `packages/api/src/pwa/routes.ts` (the app's "ready" apps), `packages/api/src/dashboard/routes.ts` (overview's
  `oauthApp` flag, connections' `appsReady`)
- Test: `apps/cloudflare/test/connect.test.ts`, `phase12.test.ts`

**Interfaces:**
- Consumes: Task 1's tables, Task 2's scoped `saveStore`.
- Produces:
  - `workspaceOAuthApps(db, workspaceId, publicUrl)` (shape of `oauthApps`, plus `instance: boolean` per app: whether
    the instance has one), `saveWorkspaceOAuthApp(env, workspaceId, id, clientId, clientSecret, userId, nowS)`,
    `removeWorkspaceOAuthApp(db, workspaceId, id)`.
  - `oauthApp(env, appId, redirect, o: { workspaceId: string | null; scope?: "workspace" | "instance" })` →
    `{ clientId, clientSecret, redirectUri, scope }`: with no `scope`, the workspace's row first, else the instance's;
    with `scope`, only that one (`ConnectError("the OAuth app changed: start again")` when it's gone).
  - `authorizeUrl` stores `app_scope`; `takeState` returns `appScope`; `finishConnect` and `finishDriveConnect`
    exchange with `oauthApp(…, { workspaceId: st.workspaceId, scope: st.appScope ?? "instance" })`.
  - `startDriveConnect(env, userId, workspaceId: string | null, nowS)`; `finishDriveConnect` saves into the flow's
    scope, and for a workspace re-checks the user is still its admin (as `finishConnect` does with `mayConnect`).
  - "Ready" lists (app and dashboard) = instance app ids ∪ the workspace's.

- [ ] **Step 1: Write the failing tests.** A has its own Meta app, B none, the instance has one: a flow started in A
  sends A's client id to the fake Meta and exchanges with A's secret; one in B uses the instance's. A's app removed
  between start and callback: the callback fails with `the OAuth app changed: start again`. Review Focus 5: a flow
  started in A, the session switched to B before the callback: the connection lands in A, exchanged with A's app.
  Drive: connecting A's own Drive uses A's Google app and saves row `drive-A`; a creator of A finishing that flow is
  refused. An existing connection keeps refreshing after its workspace app is removed (Google grant carries its app).
- [ ] **Step 2: Run, expect failures.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `connect.test.ts`, `phase12.test.ts`, `providers.test.ts`.
- [ ] **Step 5: Commit** `feat(core,api): OAuth apps per workspace, the flow keeps the app it started with`.

### Task 7: Workspace settings routes and the Scheduler route

**Files:**
- Modify: `packages/api/src/dashboard/routes.ts`, `packages/core/src/audit*` if action names are typed (grep
  `"media_store_save"`)
- Test: `apps/cloudflare/test/workspaces.test.ts`, `roles.test.ts`, new `apps/cloudflare/test/workspace-media.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 2, 5, 6.
- Produces (all under the `settings` area: workspace admins and instance admins; editors and creators 403; agent keys
  never reach `/admin-api`):
  - `GET /admin-api/settings/media` → `{ folder, stores: [{ id, kind, own, default, status,
    lastError, lastCheckedAt, settings, waitingApprovals }], offered, googleApp }` (instance stores listed with `own:
    false`, read-only).
  - `PUT /admin-api/settings/media/folder { folder }` → `{ folder }`; audit `media_folder`.
  - `POST /admin-api/settings/media/stores/:kind/test`, `POST /admin-api/settings/media/stores/:kind` (save, `fresh`),
    `POST /admin-api/settings/media/stores/drive/start` (`fresh`), `POST /admin-api/settings/media/stores/:kind/default`,
    `POST /admin-api/settings/media/default-instance` (use the instance's default again),
    `POST /admin-api/settings/media/stores/:kind/remove` (`fresh`). `:kind` is `s3` or `drive` only (404 for `local`).
    Audit `workspace_store_set`, `workspace_store_remove`.
  - `GET /admin-api/settings/oauth-apps`, `POST /admin-api/settings/oauth-apps/:id` (`fresh`),
    `POST /admin-api/settings/oauth-apps/:id/remove` (`fresh`). Audit `workspace_oauth_app_set`,
    `workspace_oauth_app_remove`.
  - `GET /admin-api/scheduler` (new area `scheduler: { instance: true }`) → `{ runs: [{ name: "instagram" | "shorts" |
    "inbox", cron }], jobsPerTick: { value, at } | null, inboxWorkspacesPerRun: { value, at } | null, inboxLast: { at,
    reached, total, limit } | null, variables: { jobsPerTick: "JOBS_PER_TICK", inboxWorkspacesPerRun:
    "INBOX_WORKSPACES_PER_RUN" } }` from `SCHEDULES`/`CRON_*` and the `settings` rows of Task 5 (ruling 4).
  - The Drive callback (`/admin-api/media-stores/drive/callback`) serves both scopes (Task 6 decides from the state).
  - The Workspaces page's create route accepts an optional `folder`.

- [ ] **Step 1: Write the failing tests** in `workspace-media.test.ts`: an admin of A sets the folder, adds an S3
  store (fake S3), makes it default, removes it; an editor and a creator get 403 on each; A's admin never sees B's own
  store in `GET /settings/media`; a folder B already uses is refused. `GET /admin-api/scheduler`: instance admin gets
  the runs and, after one tick and one inbox run, their recorded values; a workspace admin gets 403. Add every new
  route to `workspaces.test.ts`'s cross-workspace checks.
- [ ] **Step 2: Run, expect failures.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the three test files and `dashboard.test.ts`.
- [ ] **Step 5: Commit** `feat(api): workspace media, OAuth apps and the scheduler in the dashboard API`.

### Task 8: Dashboard pages

**Files:**
- Modify: `packages/dashboard/src/pages.tsx` (or the split files it imports), its nav, `packages/dashboard/src/api.ts`
  (types)
- Test: `packages/dashboard` tests if present (grep `vitest` in its `package.json`); otherwise the screenshot run
  (`scripts/screenshots`) checked by eye

**Interfaces:**
- Consumes: Task 7's routes.

- [ ] **Step 1: Settings → Media**: folder field with Save and the line "Bongsu doesn't move files: move them
  yourself"; the default store choice (the instance's or the workspace's own); add S3 / Connect Drive, Test, Make
  default, Remove, status; the S3 form and the Drive button reuse the Media page's components.
- [ ] **Step 2: Settings → OAuth apps**: Meta and Google, each with the redirect URL to register, Save, Remove; with no
  workspace app: "Uses the instance's app" or "The instance has none: add yours".
- [ ] **Step 3: Workspaces page**: the create form's Folder field, filled from the name as it's typed (slug, editable);
  the read-only **Scheduler** section: the three runs and times, each limit with its value, when it was recorded and the
  variable that sets it, the last inbox run ("reached 3 of 7 workspaces; the others wait for the next run"), and "not
  run yet" when nothing is recorded.
- [ ] **Step 4: Run** `pnpm --filter @bongsu/dashboard build`, `pnpm check`, `pnpm typecheck`, and the screenshot
  run; look at the three screens.
- [ ] **Step 5: Commit** `feat(dashboard): workspace Media and OAuth apps settings, the Scheduler section`.

### Task 9: The app

**Files:**
- Modify: `packages/api/src/pwa/routes.ts` (`me`), `packages/web/src/App.tsx` (drafts text), `packages/web/src/i18n.ts`
- Test: `apps/cloudflare/test/app.test.ts` or the `me` tests (grep `"/app-api/me"`), `packages/web` tests

**Interfaces:**
- Produces: `GET /app-api/me` → `workspace: { id, name, mediaFolder }`.

- [ ] **Step 1: Failing test**: `me` in B answers `mediaFolder: "client-b"`.
- [ ] **Step 2: Implement**; the drafts page shows `<mediaFolder>/inbox/<project>/` instead of `UPLOADS/inbox/…`.
- [ ] **Step 3: Run** the `me` test and `pnpm --filter @bongsu/web test`.
- [ ] **Step 4: Commit** `feat(api,web): the app names the workspace's media folder`.

### Task 10: Docs, plan and changeset

**Files:**
- Modify: `docs/media-stores.md`, `site/docs/` (the dashboard's Media and Settings pages, the app's drafts, the agent
  API's file ids, `configuration.md`: `INBOX_WORKSPACES_PER_RUN` beside `JOBS_PER_TICK`), `docs/PLAN.md` (tick #21;
  #24 done), the spec (ruling 1's correction), `packages/web/PRODUCT.md` (`UPLOADS/…` wording)
- Create: `.changeset/phase-13-part3a.md` (minor: core, api, web, dashboard, cloudflare, node, schema)

- [ ] **Step 1: Write the docs**; grep for leftover `UPLOADS` in `site/docs`, `docs`, `packages/web/PRODUCT.md` and
  `packages/dashboard/src` and reword each as "the workspace's folder (`UPLOADS` in the first one)".
- [ ] **Step 2: Run** `pnpm check`, `pnpm --filter @bongsu/site test` (or the docs build), `pnpm typecheck`.
- [ ] **Step 3: Commit** `docs(docs): media folders, stores and OAuth apps per workspace`.
