# Phase 13, part 3a: media and OAuth apps per workspace

Issues: #21 (per workspace: the media store root and the OAuth apps; the rest of #21 is already per workspace) and the
rest of #24 (isolation tests for the cron and the media links). Part 3b, later, covers the workspace icon (#34) and
names (#35); the icon's file lives in the workspace's media, so 3b comes after this part.
Status: designed in chat 2026-11-05, waiting for review of this spec.

## Intent

A workspace's media and OAuth apps belong to it. The instance offers default media stores and OAuth apps that every
workspace may use; a workspace can also bring its own (a client's own bucket, Drive or Meta app). Either way, nothing
in one workspace can read, list, publish or link another workspace's files: each workspace has its own folder in the
instance's stores, and a store or app a workspace adds is reachable only from inside it.

There are no running instances yet, so the migration reshapes tables freely and has no compatibility case.

## Decisions

- **A folder per workspace.** Each workspace has `media_folder`, which takes the place of today's fixed `UPLOADS`
  top folder. The layout inside it is unchanged: `inbox/<project>/`, `<project>/…`, `_posted/`.
- **Stores: the instance's, plus a workspace's own.** One `media_store` table holds both, each row with an `id`;
  a workspace's own store has its `workspace_id`. A file reference names its store by that `id`, so it always points
  at exactly one store.
- **OAuth apps: the instance's, else the workspace's own.** A flow uses the workspace's app when it has one for that
  provider, else the instance's.
- **Who:** a workspace's admins (and instance admins, who act as admin in every workspace) set the workspace's folder,
  stores and OAuth apps. The instance's stores and apps stay instance-admin only, as today.
- **`local` stays instance only:** it is the server's own disk.
- **Bongsu never moves files between folders or stores.** Changing a folder says so.

## 1. Model

### Which stores a workspace sees

`mediaStores(env, fetcher, workspaceId)` returns the instance's stores (no `workspace_id`) plus the workspace's own,
and nothing else. A reference to any other store is "missing", as a reference to a store that isn't set up is today.
`mediaStores(env, fetcher)` without a workspace (instance pages, the broken-store check) returns only the instance's
stores; the cron asks per workspace.

The workspace's **default store** is its own store marked default, if any, else the instance's default. Uploads,
items given by path and the inbox use it.

### Store ids

| Store | `id` | `workspace_id` |
|---|---|---|
| the instance's Drive / S3 / local | `drive` / `s3` / `local` | NULL |
| a workspace's own Drive / S3 | `drive-<ws>` / `s3-<ws>`, `<ws>` the workspace id | the workspace |

`MediaRef.store` and `/m/<store>/<file>` carry the id. `/m`'s path pattern widens to allow the `-` and the workspace
id's characters. A workspace has at most one store per kind.

### The folder

- `workspace_settings.media_folder`: set when the workspace is created, from its name (`Demo Studio` →
  `demo-studio`), made unique with `-2`, `-3`….
- Rules: 1–60 characters; letters, digits, `-`, `_` and spaces; not `.` or `..`; unique among workspaces. Refusals
  say why.
- Every path that starts with `UPLOADS` today goes through one helper,
  `mediaPath(folder, rest)` → `<folder>/<rest>`, in core: items given by path (`data.ts`), the inbox, cleanup's
  `_posted`, the stores' Test (`ensureFolder("<folder>/inbox")`), the app's text and the dashboard's.
- In a workspace's own store the same folder is used, so the layout is the same wherever the files are.

### Files stay in their workspace

Every media reference a caller hands in is checked by one core function, `ownsRef(db, stores, workspaceId, ref)`:

1. the ref's store must be in the workspace's stores (`mediaStores(…, workspaceId)`);
2. for an instance store, the file must sit under `<media_folder>/`:
   - S3 and local: the id decodes to a key; it must start with the folder's prefix;
   - Drive: walk the file's parents up to the folder (each step a `stat`, folder ids cached as today); a walk that
     fails or runs out of steps refuses;
3. a workspace's own store holds only that workspace's files, so step 2 is skipped there.

A refusal is 400 "not in this workspace's media". The routes that take a ref: the app's draft and upload
routes, the agent API's `create_draft` / `plan_add` (REST and MCP), and anything else found by grepping for
`MediaRef` inputs while planning. `/m` links stay signed, and only refs that passed `ownsRef` (or were made by Bongsu
itself under the folder) get signed.

### OAuth apps

- New table `workspace_oauth_apps` (below). `appFor(env, provider, workspaceId)` reads the workspace's row for the
  provider's app id, else `oauth_apps`.
- The flow records which one it used in `oauth_states.app_scope` (`workspace` or `instance`); the callback exchanges
  with that one. Removing the workspace's app between start and callback fails that flow with "the OAuth app changed;
  start again" instead of using another app's secret.
- The redirect URL to register is unchanged: it's the instance's callback, whichever app.
- Connections keep working after their app is removed: Google grants carry their own client id and secret, and
  Instagram's token refresh needs no app secret. (Planning confirms both in `providers/`.) Only new connects fall
  back to the instance's app.
- Connecting a workspace's own Drive store uses the workspace's Google app if it has one, else the instance's.

## 2. Dashboard

- **Media** (instance admins): the instance's stores, as today, without the inbox-workspace picker.
- **Settings → Media** (workspace admins), new:
  - the folder, with Save and the note "Bongsu doesn't move files: move them yourself";
  - which store the workspace uses by default (the instance's, or its own);
  - its own store: add S3 or connect Drive, Test, make default, Remove, status. The forms are the Media page's,
    reused.
- **Settings → OAuth apps** (workspace admins), new: the workspace's own Meta and Google apps, with the redirect URLs
  to register in them, Save and Remove. Without one, the page says the workspace uses the instance's (or that the
  instance has none).
- **Scheduler** (instance admins, read-only), a section on the Workspaces page: the three runs with their times
  (`SCHEDULES`), `JOBS_PER_TICK` and `INBOX_WORKSPACES_PER_RUN` as in effect, whether the schedules are off, and the
  last inbox run ("reached 3 of 7 workspaces; the others wait for the next run"). Each limit says which variable sets
  it. Nothing here is editable. Served by `GET /admin-api/scheduler` (instance admins only).
- **Creating a workspace** (setup wizard, Workspaces page): the folder is filled from the name and can be edited.
- Audit rows: `media_folder`, `workspace_store_set`, `workspace_store_remove`, `workspace_oauth_app_set`,
  `workspace_oauth_app_remove`.

Routes (under `/admin-api`, the session's workspace, admin role, guarded by router tags as the other settings
routes): `GET`/`PUT /settings/media-folder`, `GET /workspace/stores`, `PUT`/`DELETE /workspace/stores/:kind`,
`POST /workspace/stores/:kind/test`, `POST /workspace/stores/:kind/default`, `POST /workspace/stores/drive/connect`,
`GET`/`PUT`/`DELETE /workspace/oauth-apps/:id`. Exact names follow the existing routes' style when planning.

## 3. App

- Uploads go to the workspace's default store, under `<folder>/_uploads/` (it was the top folder "Bongsu app uploads"), so they don't land in the inbox.
- The drafts page names the real folder: "drop files in `<folder>/inbox/<project>/`".
- Items given by path resolve in the workspace's default store, under its folder.
- The app's Connect uses the workspace's OAuth app when it has one (the flow is the dashboard's).

## 4. Cron

- **Inbox scan** (`core/inbox.ts`): per active workspace, scan `<folder>/inbox` in each of its stores; a project's
  drafts go to the workspace it was found under. `inbox_workspace` and its lookup are removed. A project with no
  planned items starts on the workspace's first Instagram account, as today.
- **Budget:** the scan keeps the free tier's 50 subrequests in mind. It takes workspaces in turn from a cursor in
  `settings` (`inbox_cursor`) and scans at most `INBOX_WORKSPACES_PER_RUN` of them per run, so many workspaces never
  run over the limit. The inbox folder id cache becomes per store and folder (`inbox_folder:<store>:<folder>`).
- **`INBOX_WORKSPACES_PER_RUN`** follows `JOBS_PER_TICK`: a constant default per runtime (small on Cloudflare, larger
  on Node, in `constants.ts`), overridden by the variable of that name, clamped to a maximum. It is set where the
  instance is deployed (wrangler variables, the Docker environment), never in the dashboard: the right value depends
  on the hosting plan, and a wrong one fails the run quietly.
- **The last inbox run** is recorded in `settings` (`inbox_last`: when, workspaces reached, workspaces waiting), so the
  dashboard can show when the budget was too small.
- **`inbox_seen`** stays keyed by (store, file): a file is in exactly one workspace's folder.
- **Cleanup:** posted media moves to `<folder>/_posted/` in its own store; the item's workspace gives the folder.
- **Broken-store notice:** an instance store's goes to the instance admins (as today); a workspace's own store's goes
  to that workspace's members as a `problems` notification.

## 5. Removing things

- Removing a workspace's own store refuses while an approved, unpublished item uses it, naming the items.
- Removing an instance store keeps today's rule.
- Archiving a workspace leaves its stores and apps in place (restoring brings them back).

## 6. Migration 0022 (neutral schema → SQLite and Postgres)

- **`media_store` rebuilt:**

  | Column | Type | Notes |
  |---|---|---|
  | `id` | id, primary key | `drive`, `s3`, `local`, or `<kind>-<workspace>` |
  | `kind` | text: drive / s3 / local | |
  | `workspace_id` | text, nullable | NULL: the instance's |
  | `is_default` | bool | one per scope: the instance, and each workspace |
  | `settings`, `credentials`, `status`, `last_error`, `last_checked_at`, `updated_at`, `updated_by` | as today | |

  `inbox_workspace` is dropped. Existing rows are copied with `id = kind` and no workspace. "One default per scope"
  is enforced in code (saving a default clears the others in its scope), since a partial unique index isn't in the
  portable subset.
- **`workspace_settings.media_folder`:** text, not null, unique. Existing rows are filled from the workspace's name in
  the migration's data step (made unique as above).
- **`workspace_oauth_apps`:** `workspace_id`, `id` (`meta` / `google`), `client_id`, `client_secret` (encrypted),
  `updated_at`, `updated_by`; primary key (`workspace_id`, `id`).
- **`oauth_states.app_scope`:** text, nullable (`workspace` / `instance`).
- `docs/schema.md` regenerated; the Node Postgres test runs 0022.

## 7. Tests

**Core unit tests:** `mediaPath`; folder name rules and the slug; `ownsRef` with the memory store (inside, outside,
another store, a workspace's own store); the default store per workspace.

**Cloudflare integration tests (fake world):**
- **Cron (#24):**
  - a file in A's inbox never drafts into B, with A and B on the same instance store and on their own stores;
  - cleanup moves A's posted files only into A's `_posted`, in A's store;
  - the scan's cursor and budget across several workspaces: every workspace is reached over successive runs, and no
    run goes over the budget;
  - a broken workspace store notifies that workspace only.
- **Media refs (#24):** for every route that takes a ref, B's own store and a file outside A's folder in an instance
  store are refused; A's own files are accepted.
- **`/m` (#24):** a link for A's file serves it; a forged, expired or other-store signature is refused; no route in A
  hands out a link for B's file.
- **Scheduler:** `GET /admin-api/scheduler` answers the limits in effect (default, variable, clamped) and the last
  inbox run; workspace admins, editors and creators get 403.
- **Stores and apps:** add, test, default, remove (refused while in use) for a workspace's own store; the dashboard
  routes refuse editors and creators; a workspace's OAuth app is used for a flow started in it, the instance's
  otherwise; a removed app mid-flow fails cleanly.
- **`workspaces.test.ts`:** every new route.

**Node:** the Postgres test runs migration 0022.

## 8. Docs

- `docs/media-stores.md`: folders, stores per workspace, references and the check.
- `site/docs`: the dashboard's Media and Settings pages, the app's inbox text.
- The agent API docs: file ids belong to the key's workspace.
- The deploy docs (Cloudflare and Docker): `INBOX_WORKSPACES_PER_RUN` beside `JOBS_PER_TICK`.
- `apps/cloudflare/wrangler.cron.toml`: the triggers' comment points at `core/constants.ts` (it still names the deleted
  `src/config.ts`).
- `docs/PLAN.md`: tick #21 and #24.
- A changeset (minor) for `core`, `api`, `web`, `dashboard`, `cloudflare`, `node` and `schema`.

## Out of scope

- The workspace icon (#34) and names (#35): part 3b.
- Moving files when a folder or a default store changes.
- A `local` store per workspace.
- Tunable schedules (when each run happens, the other runs' per-run limits, renaming "inbox" to "upkeep"): its own
  issue, #64.
