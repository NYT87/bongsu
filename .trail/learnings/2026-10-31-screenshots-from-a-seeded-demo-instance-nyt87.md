---
title: "Screenshots from a seeded demo instance; the user, agent and operations guides (Phase 8 part 2)"
author: NYT87
date: 2026-10-31
branch: feat/phase-8-guides
cost: { minutes: 158, tokens: 337107 }
touches:
  - scripts/screenshots/seed.mjs
  - scripts/screenshots/capture.mjs
  - scripts/screenshots/screens.json
  - packages/dashboard/src/docs.tsx
  - apps/node/src/main.ts
  - site/docs/nav.json
  - README.md
---

## Decided
- `pnpm screenshots` builds the docs' images from a seeded local instance: `seed.mjs` migrates a fresh SQLite file with `apps/node`'s own migrations and writes demo rows with `better-sqlite3` (approvals hash the texts and media the way `approve.ts` does, so the app shows them as approved), `serve.mjs` runs the Node app on 127.0.0.1:8787 with `MEDIA_STORE=local`, `DRY_RUN=1` and `SCHEDULES=off` from an allowlisted environment, `capture.mjs` runs inside `mcr.microsoft.com/playwright:v1.57.0-noble` (`--network host`, the session cookies passed as env) and captures `screens.json` in both themes. The PWA shots size the viewport to the page so the fixed tab bar and approve bar sit once at the bottom; `crop: "viewport"` makes the README copies (today, item) the same height.
- `SCHEDULES=off` was added to the Node app for this (documented in configuration.md): without it the inbox cron would poll Composio for the demo's posted item within fifteen minutes.
- The dashboard bundles the guides' screenshots (an `image` renderer in `docs.tsx` resolving `assets/…` through a Vite `?url` glob; ~6 MB more in the dashboard build) rather than showing broken images; unknown paths render as alt text.
- The site build now also fails on a missing image, and the console-step images in the Meta/Google guides stay inside their `<!-- screenshot -->` comments until the owner adds the files.
- The README's Cloudflare quick start let `deploy-secrets` generate and print `SETUP_TOKEN` (since #149; setting it first with `wrangler secret put` in both Worker configs stays an option: `deploy-secrets` keeps existing secrets and throws if a secret is set in only one Worker); the CLI is publishable (Phase 10) but every `npx bongsu` in the public guides stays the from-source form until the first npm release.
- Rulings on the guides' content (as of Phase 10): a failed job reopens on a passkey approval made after the failure unless it may be live (#148); `withdraw_draft` withdraws any open draft of the workspace (#147); the dashboard's "Waiting for approval" counts re-approve items too (#146); `deploy-secrets` prints the `SETUP_TOKEN` it generates (#149).

## Tried and ruled out
- A flat single-colour demo clip: the item page's players read as broken black boxes; a gradient clip (ffmpeg `gradients`, 50 KB) instead.
- Spreading `process.env` into the demo server: a developer's `DATABASE_URL` would have pointed it at a real database.
- SVG placeholders or bare `![]()` references for the console steps: broken or noisy images on a public page.

## Watch out
- `grep "{{"` over `public/` must skip binary files (`-I`): the screenshots' bytes match otherwise and `pnpm site` fails.
- The Playwright image has the browsers but not the npm package: `capture.mjs` installs `playwright@<image version>` inside the container, so a run needs the network once per run.
- The PWA's own `scrollbar-gutter: stable` leaves a 15 px strip in tall-viewport captures; the capture overrides it and launches Chromium with `--hide-scrollbars`.
- Docs in `site/docs` are read by GitLab as files too: internal links must be `../../docs/x.md`, not bare names.
- Guides are checked against the code by the reviewers: quote labels from `i18n.ts`/`pages.tsx`, and every command from a guide or `main.ts`.
