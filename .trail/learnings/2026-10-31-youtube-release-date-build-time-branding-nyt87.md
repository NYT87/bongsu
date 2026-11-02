---
title: "YouTube release date, build-time branding and the i18n scaffold (Phase 7 part 2)"
author: NYT87
date: 2026-10-31
branch: feat/phase-7-part-2
cost: { minutes: 114, tokens: 409566 }
touches:
  - packages/core/src/release.ts
  - "packages/core/src/clients/youtube.ts#setReleaseDate"
  - packages/api/src/agent/tools.ts
  - packages/api/src/pwa/routes.ts
  - packages/api/src/dashboard/routes.ts
  - packages/web/brand.ts
  - packages/web/src/i18n.ts
  - apps/cloudflare/test/release.test.ts
---

## Decided
- One core operation, `moveRelease` (packages/core/src/release.ts), does the YouTube read-then-write (`videos.update` resets every status field it isn't sent, so `setReleaseDate` reads the status and sends it back whole with only `publishAt` changed), the calendar-cache patch, the audit row and the notification. The PWA, the dashboard and the agent API only authenticate and translate times.
- The video is found through the workspace's cached channel uploads (`findUpload`): a video of another workspace is simply "missing" (404), so the workspace check costs nothing extra and comes before any credential use.
- Agent keys get the `reschedule` scope only by opt-in (never in a default set; owners' and admins' CLI tokens have it) and must leave `RELEASE_LEAD_S` (1 h). For a key a past time therefore answers 400 (lead) before YouTube's 409 (past); the owner, with no lead, gets 409.
- The PWA's passkey challenge for the move reuses the "approve" purpose with `data.action = "release"` and the resolved `at` bound in the challenge; verify moves only what was bound (the same pattern as resume).
- Branding is build-time (`BONGSU_APP_NAME`, `BONGSU_THEME_COLOR` read in vite.config.ts through the pure `brand.ts`), because the manifest, title and theme colour are read by the browser before sign-in; the manifest is generated into dist/ and no longer lives in public/.
- i18n: `en` in `src/i18n.ts` is the typed source of truth; catalogue lookups happen at render time (`EMPTY` getters, `TABS` keys, `statusWord()`), because the locale arrives with `/app-api/me`, after module load.

## Tried and ruled out
- Near-future dates (2026-11) in tests that go through the fake world's `videos.update`: the fake checks `publishAt` against the real clock, so they fail by themselves within days. Far-future (2099) dates throughout release.test.ts.
- A hand-listed expectation for MCP `tools/list`: an opt-in scope made it stale; the test now filters the registry by the key's scopes.

## Watch out
- Any new agent tool with a scope outside the default set changes what `tools/list` shows a key: api.test.ts's expectation derives from `TOOLS` filtered by the key's scopes, keep it that way.
- Run the whole Cloudflare suite before calling a task done; the scope regression above was in a file the task's own tests didn't cover.
- `pnpm dev` of the PWA no longer serves /manifest.webmanifest (generated at build only).
- The dashboard's Videos GET maps a private video to "scheduled" only when it has a `publishAt` (`when`); a private draft is "private" and unlisted stays "unlisted" (the final review caught the first version labelling drafts as scheduled).
- The two "Cancel" buttons still literal in App.tsx sit in components whose local state is named `t` (shadows the import): rename the state when moving them (#144).
- CI's commitlint job lints the merge request title too (it can become the merge commit): a title whose subject starts with a capitalised word ("…: YouTube release date…") fails `subject-case`; start it lowercase ("…: move a YouTube release date…").
