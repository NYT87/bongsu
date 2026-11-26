---
title: The app and the dashboard have one file per screen; keep module state and its setters together
author: NYT87
date: 2026-11-26
branch: refactor/split-ui-files
cost: { minutes: 84, tokens: 457525 }
id: l-93ba30a0
scope: repo
status: active
src: agent
touches:
  - AGENTS.md
  - apps/cloudflare/test/accounts.test.ts
  - apps/cloudflare/test/bluesky.test.ts
  - apps/cloudflare/test/fakenet.test.ts
  - apps/cloudflare/test/inbox.test.ts
  - apps/cloudflare/test/media-folders.test.ts
  - apps/cloudflare/test/metrics.test.ts
  - apps/cloudflare/test/pause.test.ts
  - apps/cloudflare/test/stats.test.ts
  - apps/cloudflare/test/switch.test.ts
---

## Decided
- The PWA's screens are split out of App.tsx (the shell: signed in or not, tabs, workspace picker) into one file each, with what several share in common.tsx. The dashboard's sections are in src/pages/, one file each, shared pieces in pages/common.tsx. A helper used by one screen lives in that screen's file.
- common.tsx never imports a screen, and no screen imports App.tsx: that keeps the imports free of cycles.

## Watch out
- A module-level `let` (ZONE, PLATFORMS, entry, lastList) can't be assigned through an import. The function that assigns it has to live in the same file: setZone, setPlatforms, useHash/tagEntry and setLastList are in common.tsx for that reason.
- The i18n test reads every src/*.tsx file (import.meta.glob ?raw) to catch English left outside t(). A new screen file is covered with no change.
- The repo's TypeScript is 7 (native), which has no JS parser API. For a scripted refactor, install typescript@5 outside the repo (a scratch folder).

In the code: packages/web/src/App.tsx, packages/web/src/common.tsx and one file per screen beside them; packages/dashboard/src/pages/*.tsx; packages/web/test/i18n.test.ts.
