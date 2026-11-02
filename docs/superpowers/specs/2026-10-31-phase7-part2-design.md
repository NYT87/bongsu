# Phase 7, part 2: a YouTube video's release date, the app's branding at build time, the i18n scaffold

The second half of Phase 7 (`docs/PLAN.md`): #134 (move a scheduled YouTube video's release date from the PWA, the
dashboard and the agent API), #75 (the PWA's name, icon and colours without touching the code) and #76 (the i18n
scaffold, English first). Decided with the owner on 2026-10-31: all three surfaces for #134 including a videos page in
the dashboard; branding through build variables (name, theme colour, icon files), the design itself untouched; the
i18n scaffold moves the app's chrome now and leaves the rest of the strings to a follow-up task.

## #134 Moving a YouTube release date

A scheduled upload is private on YouTube with a `publishAt`; the app shows it as a **Goes public** row read from the
channel's uploads. The owner moves its date without YouTube Studio; an agent key may too, by the owner's choice
(issue #134, decision of 2026-10-29), inside guard rails.

### Core

- `clients/youtube.ts`: `setReleaseDate(videoId, atIso): Promise<{ from: string }>`: `videos.list` (`part=status`)
  for the current status, then `videos.update` (`part=status`, PUT) sending that status back with only `publishAt`
  changed (`videos.update` resets any status field it isn't sent). Refuses, as `ReleaseError` with a reason, a video
  that isn't found (`missing`), isn't private with a `publishAt` (`not_scheduled`), or a time not in the future
  (`past`). 50 quota units; the `youtube.force-ssl` scope already granted covers it.
- `calendar.ts` exports `channelUploads(env, fetcher, account, refresh)` (today's private `uploadsCached`) and
  `findUpload(env, fetcher, workspaceId, videoId)`: the workspace's YouTube accounts' cached uploads, refreshed once
  when the id isn't there; `{ account, upload } | null`. Every surface finds the video through it, so a video of
  another workspace is simply "not found".
- `release.ts`: `moveRelease(env, fetcher, req)` with
  `req = { workspaceId, videoId, at (unix), nowS, tz, actor: { kind: "owner", userId } | { kind: "key", id, name } }`:
  finds the upload (`404 not found` otherwise), for a key requires `at - nowS >= RELEASE_LEAD_S` (`constants.ts`,
  1 hour: "agents can't effectively publish now"), calls `setReleaseDate` with the account's connection, patches the
  cached upload's `when` so the calendar moves at once, writes the audit row (`release_move`, target
  `youtube:<videoId>`, detail `{ account, title, from, to }`, actor `owner` + user, or `key:<id>`) and sends the
  notification. Answers `{ video, title, account, due, due_at, from, from_at }` (`due` in `tz`, `due_at` UTC ISO).
  `ReleaseError` maps to 409 (`not_scheduled`, `past`), 404 (`missing`) and 400 (`lead`).
- `texts/notifications.ts`: `releaseMoved(title, from, to, by)` → title `Release moved: <title>`, text
  `from <from> to <to>, by <by>` (`by`: "you" for the owner, the key's name for a key); no target (opens the app).

### PWA

- `/app-api/youtube/release/options` `{ video, date, time }` → the passkey challenge (`purpose "approve"`, data
  `{ action: "release", video, at }`) after resolving the time with `dueFrom` in the caller's zone; `/verify` checks
  the challenge's action and calls `moveRelease` with the bound `at` (what the owner saw is what moves).
- `VideoPage`: a **Release date** card (like an item's `Reschedule`) shown only for `status === "scheduled"`:
  "Goes public <when>", **Change date** → date and time fields in the caller's zone, **Save new date** → the
  passkey prompt → "Moved to <when>." and the calendar reloads. A `ReleaseError` reads as the server's message.

### Dashboard

- `GET /admin-api/videos`: every YouTube account of the workspace with its uploads (`channelUploads`, `?refresh=1`
  re-reads), each `{ id, title, status: public | scheduled | private, when, when_at, short, url }`, times in the
  user's zone; `warnings` for a channel that couldn't be read.
- `POST /admin-api/videos/:id/release` `{ date, time }` after `fresh(c)` (the passkey check of the last 10 minutes,
  like keys): `moveRelease` as the owner. The MANAGING gate covers `/admin-api/videos/` (owners and admins).
- A **Videos** section (sidebar, after Accounts): one table per channel, newest first: title, Short/Video, state pill,
  the time, and for a scheduled one a **Change date** action (date and time fields in a row, saved with
  `withFreshCheck`). "Check YouTube now" refreshes.

### Agent API

- Scope `reschedule` beside `read`, `draft`, `plan`, `pause`: not given by default; the dashboard's key form lists it
  with the note "move a YouTube release date". CLI tokens of owners and admins have it (they act as their person).
- Tool `youtube_reschedule` (`POST /v1/youtube/reschedule`): `{ video, at | date (+ time) }` read with `dueFrom` in
  the caller's zone; answers `moveRelease`'s result. The lead time applies to every bearer-token caller.
- `docs/agents.md` (scope and tool rows), `docs/security.md` (the exception and its guard rails), `docs/youtube.md`
  (the feature, the quota), `packages/web/DESIGN.md` and `PRODUCT.md` (YouTube rows are no longer read-only).

### Tests

- Fake world: `PUT /youtube/v3/videos?part=status`: asserts the body carries the stored status unchanged except
  `publishAt`, refuses (400) a public video or a `publishAt` in the past, updates `ytUploads`. `videos.list` with
  `part=status` only (today's privacy handler) also returns `publishAt`.
- `apps/cloudflare/test/release.test.ts`: the client's read-then-write; the PWA's options/verify (a challenge of
  another action refused; the time bound to the challenge); the dashboard route (fresh check, refresh); the API
  (no scope 403, with scope 200, lead time 400, past 409, public video 409, unknown 404); the calendar and the
  dashboard list reflect the move; the audit row and the notification; `date`/`time` in the caller's zone against
  `at`.
- `workspaces.test.ts`: an agent key of workspace B can't move workspace A's video (404).
- `packages/core/test/notifications.test.ts`: `releaseMoved`.

## #75 Branding at build time

The PWA's name and colours are read by the browser before anyone signs in (the manifest, the title, the theme
colour), so they are build inputs, not rows: one instance is one brand. Two variables, read by `vite.config.ts`:

| Variable | Default | Used for |
|---|---|---|
| `BONGSU_APP_NAME` | `Bongsu` | `<title>`, the manifest's `name` and `short_name`, the header's label, the sign-in title, the Android notifications hint |
| `BONGSU_THEME_COLOR` | `#131f2a` | `<meta name="theme-color">`, the manifest's `theme_color` and `background_color` |

- `packages/web/brand.ts`: `brand(env)` → `{ name, themeColor }` (a bad colour falls back to the default) and
  `manifestFor(brand)` (the manifest as data, from today's file); `vite.config.ts` injects them into `index.html`
  (`transformIndexHtml`), writes `dist/manifest.webmanifest` (the file leaves `public/`) and defines `__APP_BRAND__`
  for `App.tsx`. `pnpm --filter @bongsu/web test` runs `packages/web/test/brand.test.ts` (vitest, already in the
  workspace).
- Icons: drop-in files in `packages/web/public/` (`favicon.svg`, `icon-*.png`, `apple-touch-icon.png`), documented;
  the dashboard keeps the Bongsu mark (it's the admin tool of a Bongsu instance).
- The design (colours, type, layout) stays: `--accent` and the rest of `tokens.css` are not variables.
- `docs/configuration.md` gets a "Branding" section (the two variables, the icon files, where to set them for
  Cloudflare's build and the Dockerfile's `ARG`s); `docs/deploy-cloudflare.md` and `docs/self-hosting.md` link to it.

## #76 The i18n scaffold

- `packages/web/src/i18n.ts`: the English catalogue `en` (the source of truth, typed), `t(key, vars?)` with `{name}`
  interpolation and `plural(n, one, other)`; `setLocale(l)` picks the catalogue (English for an unknown one) and sets
  `document.documentElement.lang`; `dateLocale()` is the locale the `toLocaleDateString` calls use instead of `"en"`.
  A second language is a `locales/<code>.ts` with the same keys (`Record<keyof typeof en, …>`: a missing key is a
  type error), listed in one map.
- `GET /app-api/me` adds `locale` (`workspace_settings.locale`, `en` today); the app calls `setLocale` when `me`
  loads.
- Moved now: the app's chrome. The tabs, the header's labels, sign-in and setup, `SettingsPage`, `EMPTY` and
  `SetupNote`, the shared verbs (Cancel, Save, Loading…, Change date, Save new date, Open on YouTube) and
  `STATUS_WORD`. About sixty strings; no wording changes.
- The rest of `App.tsx` moves in a follow-up (a new Phase 7 box and GitLab issue: "i18n: the rest of the app's
  strings"), and `DESIGN.md` states the rule: new UI text goes through `t()`.
- `packages/web/test/i18n.test.ts`: interpolation, plural, unknown key returns the key, unknown locale falls back,
  `lang` set.

## Docs and bookkeeping

- `docs/PLAN.md`: tick #75, #76, #134 ("done 2026-10-31"); add the follow-up box for the remaining strings.
- Changesets: `@bongsu/core`, `@bongsu/api`, `@bongsu/web`, `@bongsu/dashboard` minor (a YouTube release date from
  the app, the dashboard and the API with the `reschedule` scope; branding at build time; the i18n scaffold).
- One merge request after part 1's, `feat(core,api,web,dashboard): YouTube release date, branding, i18n scaffold`,
  closing #75, #76, #134.

## Out of scope

Making a video public now or changing its privacy (YouTube Studio); YouTube uploads (Phase 14); branding per
workspace (Phase 13); a second UI language; the dashboard's own i18n; translating notifications.
