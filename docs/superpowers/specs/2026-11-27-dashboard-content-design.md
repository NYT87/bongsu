# Content in the dashboard: the app's screens for admins and editors

Status: approved by the owner on 2026-11-27. Issue #145, refs #58.

## Intent

The dashboard is where a workspace is set up (connections, accounts, devices, keys, members, settings); the content
(planning, drafts, approving, results, comments) lives only in the phone app. The owner wants admins and editors to
manage **all** the workspace's content from the dashboard, on every platform (Instagram posts, Reels, carousels,
Stories; YouTube videos and Shorts; Threads; Bluesky), exactly as a creator does in the app. Creators keep using only
the app: they don't care about workspaces or configuration.

The dashboard's **Videos** page today is YouTube-only (each channel's uploads read from YouTube, with Change date): it
reads like a content section but covers one platform. It moves onto each YouTube channel's own page under Accounts.

## Goals

- Admins and editors do in the dashboard everything a creator does in the app with content: Today, Calendar, Queue,
  Drafts (new, upload, schedule, refuse), the item page (texts, YouTube fields, title, cover, location, trial, date,
  hold, results, metrics), approving, a YouTube video's page and release date, Stats and the channel page, Comments
  and replies.
- One implementation of each content screen, used by both the app and the dashboard: a feature added later appears in
  both, and they can't drift apart.
- The same rules as the app, by role: admins approve, pause and resume; editors do everything else and leave those to
  someone else (`ROLE_SCOPES`, `packages/api/src/agent/auth.ts`). Approving asks for the person's own passkey, as in
  the app.
- Each account gets a page in Accounts; a YouTube channel's page holds what the Videos page has today. The Videos
  sidebar entry goes.

## Non-goals

- A desktop redesign of the screens. They render in the dashboard's layout with its wider content area; bespoke
  desktop views (a dense posts table, a week grid) can come later on top of the shared screens.
- Push notifications, installing the app, and the app's own Settings (notification preferences, sign-out, its time
  zone): those stay the app's. The dashboard keeps its own Settings and Devices.
- Changing what creators see: a creator signing in to the dashboard is still sent to the app.
- Changing agent keys, MCP or the REST API.

## Anti-goals (a failure even if it works)

- A dashboard session reaching the app's routes, or an app session reaching the dashboard's, beyond the shared content
  routes this design adds on purpose. The two sessions stay apart (12-hour dashboard session, 30-day app session).
- An editor approving, pausing or resuming through the dashboard.
- A second copy of a content screen that has to be kept in step with the app.
- The app getting slower or bigger for its users because the dashboard shares its screens.

## Constraints (from the code today)

- **The app's screens** (`packages/web/src`: Today, Calendar, Queue, Drafts, Item, Video, Stats, Metrics, Chart,
  Comments, YtFields, `common.tsx`, `i18n.ts`) route by hash (`useHash`, `#/queue`, `#/item/<key>`), open each other
  with links or `location.hash`, and depend on module-level state set by the shell: `ZONE`, `PLATFORMS`, `lastList`,
  the i18n locale, `BRAND` (`__APP_BRAND__`, a build-time define), and React context (`MeCtx`, `SharedCtx`, filled by
  `useSharedState` in `App.tsx`). None import push, the service worker or the app's Settings; `PausedBanner` links to
  `#/settings` and `SetupNote` to `/dashboard/start`.
- **Their API client** (`packages/web/src/api.ts`) calls `/app-api/<path>`; `useLoad` caches per day in localStorage.
  Approving, a YouTube release and resuming run their own passkey ceremony on each call.
- **The dashboard** routes by path (`/dashboard/<section>`, `SECTIONS` in `packages/dashboard/src/App.tsx`), calls
  `/admin-api/<path>` (`packages/dashboard/src/api.ts`, `withFreshCheck` for a fresh passkey), has no i18n, and uses
  `@bongsu/web` only for `tokens.css`.
- **Sessions**: `bongsu_session` (app) and `bongsu_admin` (dashboard), both HttpOnly, Secure, SameSite=Strict; each
  router reads only its own cookie and `validSession` checks `sessions.app` (`packages/api/src/pwa/session.ts`).
  There's no Origin or CSRF check: SameSite=Strict is the protection. `/app-api` permissions come from the `NEEDS`
  table and `ROLE_SCOPES` (`packages/api/src/pwa/routes.ts`); `/admin-api` from its `area` flags.
- **Passkeys**: an approval accepts any of the user's passkeys and checks the origin against `PUBLIC_URL`
  (`packages/core/src/webauthn.ts`); the dashboard is on that origin under `/dashboard`.
- AGENTS.md: workspace isolation (`apps/cloudflare/test/workspaces.test.ts` extended with new routes), approval stays
  human, a component test for UI changes, `core`/`api` runtime-independent.

## Approaches

1. **Share the app's screens with the dashboard** (chosen by the owner). The content screens become importable from
   `@bongsu/web`; the dashboard renders them under one of its pages, and the content routes are served to a dashboard
   session too. One implementation; the cost is untangling the screens from the app's shell first.
2. **New dashboard-only content pages** on new `/admin-api` routes over the same core functions. Best fit for a large
   screen, but every content feature would exist twice (approving, uploads, YouTube fields) and drift.
3. **Open the app inside the dashboard.** Almost free, but a second sign-in, the phone layout on a big screen, and not
   part of the dashboard.

The owner picked 1: it gives "manage anything like a creator" without two versions to keep in step.

## Design

### Server: the content routes, mounted twice

The handlers behind the content screens' routes (the lists, `item/*`, `drafts/*`, `uploads/*`, `approve/*`,
`youtube/release/*`, `video/metrics`, `stats*`, `calendar`, `day`, `notifications`, `comments*`, `me`, `platforms`,
`status`, `pause`, `resume/*`) are registered from one function that takes how the caller is found. It's mounted:

- at `/app-api/<path>` as today, behind the app session (`bongsu_session`, `app = 'pwa'`);
- at `/admin-api/content/<path>`, behind the dashboard session (`bongsu_admin`, `app = 'dashboard'`), with the
  dashboard's own checks: a creator is refused (`app: true`, as on every dashboard route) and the workspace is the
  dashboard session's.

Both build the same `caller` (workspace, user, role scopes) and go through the same `NEEDS` table and `ROLE_SCOPES`,
so an editor can't approve, pause or resume from either.

**Passkeys: the app's rules, in both** (decided by the owner). Plan edits (texts, dates, drafts, holds) need no recent
passkey check, as in the app; approving, resuming and a YouTube release run their own passkey ceremony on every call,
wherever they're made. The dashboard's 10-minute `fresh(c)` check isn't applied to `/admin-api/content`: the dashboard
session already lasts 12 hours against the app's 30 days, and requiring it would mean a passkey prompt every 10
minutes of content work and a second error path in the shared screens. The app-only routes (push, notification preferences,
sign-in, invites, its time zone, `session/*`, `connections`/`connect/*`) are not mounted for the dashboard, which has
its own.

The passkey ceremonies (`approve/*`, `youtube/release/*`, `resume/*`) work unchanged: any of the user's passkeys,
origin `PUBLIC_URL`.

### The shared screens

- `packages/web` exports its content screens and what they need through an entry, `@bongsu/web/content`: a
  `<Content>` component that renders the hash-routed screens (Today, Calendar, Queue, Drafts, Item, Video, Stats,
  channel page, Comments) and takes from its host:
  - `apiBase` (`/app-api` or `/admin-api/content`): `api.ts` and the passkey ceremonies use it;
  - `brand` (the app's name and colour) instead of the `__APP_BRAND__` define;
  - the links that leave the screens: where "Settings" (the paused banner) and "set up" (`SetupNote`) go;
  - which screens to show (the dashboard leaves out none of the content ones).
- The app's shell (`App.tsx`) becomes a host of `<Content>` with `apiBase: "/app-api"`; nothing changes for its users.
  Its `useSharedState`, `refreshMe` (zone, locale, platforms) and `lastList` move into `<Content>`, since both hosts
  need them.
- `useLoad`'s localStorage cache gets the host and the workspace in its key, so the app and the dashboard, or two
  workspaces, never read each other's cached answers in the same browser.
- **Which workspace**: the host's. In the dashboard, its switcher drives `<Content>`: a switch remounts it (keyed by
  the workspace, as the app's shell is) and `<Content>` hides the app's own workspace picker. The app keeps its picker.
  *(Builder's call: anything else could show one workspace's cached plan while the dashboard is in another.)*

### The dashboard

- A **Content** page at `/dashboard/content` renders `<Content apiBase="/admin-api/content">` in the main area; its
  screens keep their hash routes (`/dashboard/content#/queue`, `#/item/<key>`). The sidebar gets the content entries
  at the top, named as in the app (Today, Calendar, Queue, Drafts, Stats, Comments: links to `/dashboard/content#/…`),
  above the setup sections. The workspace switcher and the dashboard's header stay.
- The screens use the dashboard's wider main column: their CSS caps at the phone width today; inside the dashboard
  they take the page width, with the Calendar as a full month.
- **Pause and resume** (the app's Settings has them) go on the dashboard's Settings for admins, through the same
  routes.
- **Accounts**: each row opens `/dashboard/accounts/<id>`, the account's page: its settings that the table shows today
  (enable, disable, remove, caption rules) and a link to its page among the shared screens
  (`/dashboard/content#/stats/<platform>/<id>`, the app's channel page). A YouTube video's release date is changed on
  the shared Video page (`youtube/release/*`), so the dashboard's own Videos code goes: the page, its sidebar entry,
  `/admin-api/videos` and `/admin-api/videos/:id/release` and their tests. `/dashboard/videos` redirects to Accounts.
  *(Builder's call: keeping the dashboard's Videos code would leave two implementations of Change date, which the
  anti-goals rule out.)*
- The overview (`/dashboard`) keeps its setup checklist; a link to Today joins it once set up.

### Tests

- `apps/cloudflare/test`: a dashboard session reaches `/admin-api/content/*` and is refused on `/app-api/*`; an app
  session is refused on `/admin-api/content/*` (both directions, real session rows); an editor is refused approve,
  pause and resume through `/admin-api/content`; a creator's dashboard session is refused there; the new routes added
  to `workspaces.test.ts` (another workspace's item, draft, comment never reached).
- `packages/web/test`: the app still renders its screens through `<Content apiBase="/app-api">`; the cache key
  carries the host.
- `packages/dashboard/test`: the Content page renders Today, Queue and an item through the dashboard with `fetch`
  faked at `/admin-api/content/`; approving runs the ceremony against that base; an account's page shows a YouTube
  channel's uploads and Change date; `/dashboard/videos` lands on Accounts.

### Docs

`site/docs/the-dashboard.md` (the content pages, the account page, no Videos), `site/docs/the-app.md` (where the same
screens are), `site/docs/security.md` (the content routes serve both sessions; roles unchanged), `docs/architecture.md`
(the shared screens and the double mount).

## Phases

1. Server: the content routes from one function, mounted at `/admin-api/content`; the session and role tests.
2. `packages/web`: `<Content>` with its host inputs; the app becomes its host. No visible change.
3. The dashboard's Content page and sidebar entries; pause and resume in its Settings.
4. The account page; Videos moved into it and removed from the sidebar.
5. Docs.

Each phase is its own pull request and leaves `main` working.

## Left to the builder

- The exact route list that's mounted twice (the content screens' routes, from section 6 of the research: shell
  lists, Today, Calendar, Queue, Drafts, Item, Video, Stats, Comments, Metrics), and how the one registering function
  is shaped.
- How `<Content>` passes its host inputs (props, a context) and how the module-level state moves without breaking
  the rule that a module's `let` is set in its own file.
- The CSS for the wider layout.
