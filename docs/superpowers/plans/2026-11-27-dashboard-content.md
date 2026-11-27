# Content in the dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admins and editors manage all of a workspace's content from the dashboard with the app's own screens; the
YouTube-only Videos page moves to each account's page.

**Architecture:** The app's content routes are built by one function, mounted at `/app-api` behind the app session and
at `/admin-api/content` behind the dashboard session (same role rules). The app's content screens become a
`<Content>` component in `@bongsu/web` that both the app and the dashboard host.

**Tech Stack:** TypeScript, Hono (`packages/api`), React + Vite (`packages/web`, `packages/dashboard`), Vitest
(Cloudflare pool for `apps/cloudflare/test`, happy-dom for the UIs).

**Spec:** `docs/superpowers/specs/2026-11-27-dashboard-content-design.md` (approved 2026-11-27). GitHub issue: #145.

## Global Constraints

- Five phases, each its own pull request; `main` works after each.
- Sessions stay apart: `bongsu_session` (`app = 'pwa'`, 30 days) only on `/app-api`; `bongsu_admin`
  (`app = 'dashboard'`, 12 hours) only on `/admin-api` (including `/admin-api/content`).
- Role rules from `ROLE_SCOPES` (`packages/api/src/agent/auth.ts`) and the `NEEDS` table, unchanged: admins and
  creators approve, pause, resume; editors don't. Creators never reach `/admin-api` (403 `app: true`).
- Passkeys: the app's rules in both hosts. No `fresh(c)` on `/admin-api/content`; approve, resume and a YouTube release
  run their own ceremony on every call.
- AGENTS.md: workspace isolation tested in `apps/cloudflare/test/workspaces.test.ts`; `core`/`api` runtime-independent;
  a component test for UI changes; Conventional Commits with lowercase subjects (PR titles too); changesets for
  user-visible changes; `pnpm check && pnpm typecheck && pnpm test` pass; Node 22.

## Review Focus

1. An editor sending an encoded path (`/admin-api/content/%61pprove/options`): refused like the plain one (the `NEEDS`
   tag comes from the router, not the raw URL). Test in Task 2.
2. An instance admin whose dashboard session has no workspace calling `/admin-api/content/queue`: 403 `noWorkspace`,
   not a 500. Test in Task 2.
3. A dashboard session in an archived workspace: refused on `/admin-api/content` as on the rest of `/admin-api`.
   Test in Task 2.
4. An expired dashboard session (older than 12 hours): 401 on `/admin-api/content`. Test in Task 2.
5. The app's own routes (push, notification preferences, its time zone, sign-in, invites, `session/*`, connect) are
   not reachable under `/admin-api/content`: 404. Test in Task 2.

---

## Phase 1: the content routes for the dashboard session (one PR)

### Task 1: build the app's routes for a host

**Files:**
- Modify: `packages/api/src/pwa/routes.ts` (`NEEDS`, `appRoutes`, the session middleware, the 77 `/app-api/…` paths)
- Test: the existing suites that use `/app-api` (`apps/cloudflare/test/app.test.ts`, `roles.test.ts`,
  `workspaces.test.ts`, `security.test.ts`, `switch.test.ts`)

**Interfaces:**
- Produces, exported from `packages/api/src/pwa/routes.ts`:
  - `export interface AppHost { prefix: string; app: App }` (`App` from `./session`)
  - `export const PWA_HOST: AppHost = { prefix: "/app-api", app: "pwa" }`
  - `export const CONTENT_HOST: AppHost = { prefix: "/admin-api/content", app: "dashboard" }`
  - `appRoutes(fetcher: typeof fetch, verifiers: Verifiers = realVerifiers, host: AppHost = PWA_HOST): Hono<Vars>`

- [ ] **Step 1: Replace the `/app-api` literal with `host.prefix`** in every route path, in `NEEDS` (built inside
  `appRoutes` from the host), and in the middleware patterns. `PWA_HOST` keeps every path as it is today.
- [ ] **Step 2: Read the host's session.** The session middleware uses `readCookie(header, host.app)` and
  `validSession(db, token, now, host.app)`; `callerFor` passes `{ notCreator: true }` to `sessionWorkspace` when
  `host.app === "dashboard"`.
- [ ] **Step 3: Register the app's own routes only for `app === "pwa"`:** setup, login, logout, `invite/*`,
  `session/*`, `push/*`, `notify-prefs`, `me/timezone`, `me/name`, `me/display-name`, `connections`, `connect/*`,
  `client-error`. Everything else (the lists, `item/*`, `drafts/*`, `uploads/*`, `media-stores`, `approve/*`,
  `youtube/release/*`, `video/metrics`, `stats*`, `calendar`, `day`, `notifications`, `jobs`, `comments*`, `me`,
  `platforms`, `status`, `pause`, `resume/*`) is registered for both.
- [ ] **Step 4: Run the app's suites; nothing changes for the app.**
  Run: `pnpm --filter @bongsu/cloudflare exec vitest run --testTimeout 120000 --maxWorkers=2 test/app.test.ts test/roles.test.ts test/workspaces.test.ts test/security.test.ts test/switch.test.ts`
  Expected: all pass, same counts as on `main`.
- [ ] **Step 5: Commit** `refactor(api): build the app's routes for a host`

### Task 2: mount the content routes in the dashboard router

**Files:**
- Modify: `packages/api/src/dashboard/routes.ts` (after the `/admin-api/*` middleware, before the first route)
- Create: `apps/cloudflare/test/dashboard-content.test.ts`

**Interfaces:**
- Consumes: `appRoutes`, `CONTENT_HOST` (Task 1).
- Produces: `/admin-api/content/<path>` for every route Task 1 registers for both hosts.

- [ ] **Step 1: Write the failing tests** in `dashboard-content.test.ts`, with real session rows
  (`createSession(env.DB, now, { app, userId })`), the fake world and `seedReel`:
  - `"a dashboard session reads the queue the app reads"`: `GET /admin-api/content/queue` (admin, dashboard session)
    equals `GET /app-api/queue` (same user, app session).
  - `"each session works only on its own side"`: dashboard session on `/app-api/queue` → 401; app session on
    `/admin-api/content/queue` → 401.
  - `"a creator is sent to the app"`: creator's dashboard session on `/admin-api/content/queue` → 403 with
    `app: true`.
  - `"an editor plans but doesn't approve, pause or resume"`: editor's dashboard session: `POST
    /admin-api/content/approve/options`, `…/%61pprove/options`, `…/pause`, `…/resume/options` → 403 naming the scope;
    `POST /admin-api/content/item/hold` on a seeded item → 200.
  - `"an admin approves from the dashboard with any of their passkeys"`: `approve/options` then `approve/verify`
    (fake verifiers, as `app.test.ts` does) under `/admin-api/content` → the approval row names the user.
  - `"the app's own routes aren't there"`: `push/subscribe`, `notify-prefs`, `me/timezone`, `login/options`,
    `session/workspace`, `connect/youtube/start` under `/admin-api/content` → 404.
  - `"refused like the rest of /admin-api"`: an instance admin with no workspace → 403 `noWorkspace`; a session in
    an archived workspace → refused (as `roles.test.ts` checks for `/admin-api`); a dashboard session older than 12
    hours → 401.
- [ ] **Step 2: Run them; they fail** (404 on `/admin-api/content/*`).
  Run: `pnpm --filter @bongsu/cloudflare exec vitest run --testTimeout 120000 test/dashboard-content.test.ts`
- [ ] **Step 3: Mount** `app.route("/", appRoutes(fetcher, verifiers, CONTENT_HOST))` in `adminRoutes` right after its
  `/admin-api/*` middleware, so the dashboard's session check and creator refusal run first. No `AREAS` entry: content
  is any member's, and `managing` must not apply (editors plan).
- [ ] **Step 4: Run them; they pass**, plus `dashboard.test.ts` and `roles.test.ts`.
- [ ] **Step 5: Commit** `feat(api): serve the app's content routes to the dashboard session`

### Task 3: workspace isolation for the content routes

**Files:**
- Modify: `apps/cloudflare/test/workspaces.test.ts` (`describe("the owner's apps follow the signed-in user's workspace (Phase 4b)")`)

- [ ] **Step 1: Write the test** `"the dashboard's content routes see only the user's workspace"`: a dashboard session
  in workspace B: `GET /admin-api/content/item?key=<A's item>` → 404; `POST /admin-api/content/item/texts` and
  `…/drafts/<A's draft>/schedule` → 404; `GET /admin-api/content/queue` lists none of A's items.
- [ ] **Step 2: Run it; it passes** (the routes filter by the caller's workspace already). If it fails, the fix goes
  in Task 1's `callerFor`, not in the test.
- [ ] **Step 3: Commit** `test(cloudflare): the dashboard's content routes stay in the user's workspace`

### Task 4: docs and the pull request

**Files:**
- Modify: `site/docs/security.md` (the roles section: the content routes serve both sessions, roles unchanged),
  `docs/architecture.md` (the app's routes mounted twice)

- [ ] **Step 1: Write the two paragraphs.** No changeset: nothing a user sees changes yet.
- [ ] **Step 2: `pnpm check && pnpm typecheck`, the Cloudflare suites touched above, `trail check`.**
- [ ] **Step 3: Commit, push `feat/dashboard-content-api`, open the PR** titled
  `feat(api): serve the app's content routes to the dashboard session`, `Refs #145`.

---

## Phase 2: the shared content in `@bongsu/web` (one PR)

The app's `SignedIn` (`packages/web/src/App.tsx`) mixes the content (the shared lists, the page each `#/` route shows,
its title, `MeCtx`/`SharedCtx`) with the phone app's chrome (header, tabs, workspace sheet, Settings). The content part
moves to `packages/web/src/content.tsx`, exported as `@bongsu/web/content`; the app keeps its chrome and uses it. No
visible change.

**Ruling (plan):** module-level state stays in its own file with its setter (the learning on module `let`s): the API
base in `api.ts`, the brand and the cache scope in `common.tsx`.

### Task 5: the API base and the cache scope

**Files:** Modify `packages/web/src/api.ts`, `packages/web/src/common.tsx`. Test: `packages/web/test/content.test.tsx`
(new).

**Interfaces (produces):**
- `api.ts`: `export function setApiBase(base: string): void` (default `"/app-api"`); `api()` fetches `${base}/${path}`.
- `common.tsx`: `export function setCacheScope(scope: string): void` (default `""`); the cache key becomes
  `bongsu-cache:<day>:<scope>:<path>`, so `cachePrune` (by day) keeps working.
- `common.tsx`: `export let BRAND` defaulting to `__APP_BRAND__` when defined, else `{ name: "Bongsu", themeColor:
  "#131f2a" }`; `export function setBrand(b: { name: string; themeColor: string }): void`.

- [ ] Test `"the API base decides where every call goes"`: `setApiBase("/admin-api/content")`, `api("queue")` → fetch
  called with `/admin-api/content/queue`; back to `/app-api` after `setApiBase("/app-api")`.
- [ ] Test `"two scopes never read each other's cache"`: `setCacheScope("a")`, `cachePut("queue", 1)`;
  `setCacheScope("b")` → `cacheGet("queue")` is null; back to `"a"` → 1.
- [ ] Run (fail), implement, run (pass): `pnpm --filter @bongsu/web exec vitest run test/content.test.tsx`.
- [ ] Commit `refactor(web): an API base, a cache scope and a brand the host sets`.

### Task 6: the content module

**Files:** Create `packages/web/src/content.tsx`; modify `packages/web/src/App.tsx`, `packages/web/package.json`
(`exports["./content"] = "./src/content.tsx"`). Test: `packages/web/test/content.test.tsx`.

**Interfaces (produces), from `content.tsx`:**
- `export interface ContentHost { apiBase: string; brand?: { name: string; themeColor: string } }`
- `export async function bootContent(host: ContentHost, me: Me): Promise<void>`: sets the API base, brand, zone,
  locale, platforms (`/platforms`), and the cache scope `${apiBase}|${me.workspace?.id ?? ""}`. The app's `refreshMe`
  calls it after loading `me`.
- `export function useSharedState(): Shared` (moved from `App.tsx`).
- `export function contentRoute(route: string, onTitle: (key: string, title: string | null) => void): { page:
  ReactNode; title: string } | null`: the page and title for a content route (Today, Calendar, Queue, Drafts, Item,
  Video, Stats, channel page, Comments); null for one that isn't content (`/settings`, which the app keeps).
- `export function ContentProviders({ me, shared, children })`: `MeCtx` and `SharedCtx`.

- [ ] Test `"the content routes and their titles"`: `contentRoute("/queue", …)` → Queue's page and title;
  `"/item/reel%3Ax"` → the item page; `"/settings"` → null.
- [ ] Test `"the content screens run on another host"`: `bootContent({ apiBase: "/admin-api/content" }, me)` then
  render `ContentProviders` + `contentRoute("/queue")` with `fetch` faked at `/admin-api/content/` → the queue's
  items render and no request goes to `/app-api`.
- [ ] Move the code; `SignedIn` uses `useSharedState`, `contentRoute` (falling back to its Settings page) and
  `ContentProviders`; `refreshMe` uses `bootContent({ apiBase: "/app-api" }, me)`.
- [ ] Run `pnpm --filter @bongsu/web test` (all, including `screens.test.tsx`), `pnpm --filter @bongsu/web build`,
  `pnpm typecheck`.
- [ ] Commit `refactor(web): the content screens as a module both hosts can use`; push, PR
  `refactor(web): share the app's content screens`, `Refs #145`. No changeset (nothing visible changes).

## Phase 3: the dashboard's Content page (one PR, outline)

- `/dashboard/content` renders `<Content apiBase="/admin-api/content" …>` keyed by the workspace; sidebar entries Today,
  Calendar, Queue, Drafts, Stats, Comments (links to `/dashboard/content#/…`) above the setup sections; the app's
  picker hidden.
- Wider layout: the screens' max width lifted inside the dashboard; the Calendar a full month.
- Pause and resume on the dashboard's Settings for admins, through `/admin-api/content/pause` and `resume/*`.
- Tests (`packages/dashboard/test/pages.test.tsx`): Today, Queue and an item render with `fetch` faked at
  `/admin-api/content/`; approving runs the ceremony there; an editor sees no Approve. Changeset.

## Phase 4: the account page; Videos removed (one PR, outline)

- `/dashboard/accounts/<id>`: the account's settings (enable, disable, remove, caption rules) and a link to
  `/dashboard/content#/stats/<platform>/<id>`.
- Delete `packages/dashboard/src/pages/Videos.tsx`, its sidebar entry, `/admin-api/videos` and
  `/admin-api/videos/:id/release` and their tests; `/dashboard/videos` redirects to `/dashboard/accounts`.
- Tests: the account page renders and links; `/dashboard/videos` lands on Accounts. Changeset.

## Phase 5: docs (one PR, outline)

- `site/docs/the-dashboard.md` (the content pages, the account page, no Videos), `site/docs/the-app.md` (the same
  screens in the dashboard), screenshots refreshed with `pnpm screenshots`.
