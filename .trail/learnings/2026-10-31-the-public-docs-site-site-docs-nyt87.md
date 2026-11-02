---
title: "The public docs site: site/docs, the renderer, the move (Phase 8 part 1)"
author: NYT87
date: 2026-10-31
branch: feat/phase-8-public-docs
cost: { minutes: 77, tokens: 272190 }
touches:
  - scripts/docs-lib.mjs
  - scripts/build-docs.mjs
  - scripts/build-site.sh
  - site/docs/nav.json
  - packages/dashboard/src/docs.tsx
  - Dockerfile
  - ".dockerignore"
---

## Decided
- The user-facing guides live once in `site/docs/*.md` (moved with `git mv`); `docs/` is internal only. The dashboard bundles the same files (`import.meta.glob("../../../site/docs/*.md")`), so `/dashboard/docs/<name>` and the providers' `GuideLink`s keep their names; the Docker build copies `site/` (and `.dockerignore` keeps `site/*` out except `site/docs`).
- The site build stays a shell script: `scripts/build-site.sh` renders the landing page, then `node scripts/build-docs.mjs` (I/O only) renders every guide through the pure `scripts/docs-lib.mjs` (`marked`, a root devDependency at the dashboard's version). `pageHtml` leaves `{{REPO_URL}}` for the script's sed, which runs over the docs pages too, before the `{{` check. `node --test scripts/docs-lib.test.mjs` is `pnpm test:site`; the `check` CI job runs it and `pnpm site`.
- Link rule in the renderer: `x.md[#y]` → a page link when `x` is a public guide (`../x/` from a page, `x/` from the index), a repository blob link when it isn't, text for anything else; `assets/…` and images get the same base prefix. So internal docs are still linked from the public pages, as repository links.
- `site/docs/nav.json` orders the sidebar (sections with empty page lists are allowed and hidden); a page's title is its `# ` heading; `README.md` is the index and is not rendered as a page of its own.
- Commitlint has no `site` scope: site work commits under `docs`.

## Tried and ruled out
- Copying the guides so both `docs/` and `site/docs/` have them: ruled out (one source of truth; the index links across instead).
- A static site generator for the docs: ruled out ("one small Markdown dependency at most", nothing third-party on the pages).

## Watch out
- The reference grep for the old paths must use `(?<!site/)docs/<name>\.md`, since the new paths contain `docs/<name>.md`.
- The guard for the move is the dashboard's built bundle (grep a guide sentence in `packages/web/dist/dashboard/assets/*.js`); `pnpm --filter @bongsu/web build` empties the dashboard's dist, so run the dashboard build last.
- A literal `{{` in any guide now fails `pnpm site` (the placeholder check); page H1s double as sidebar labels, so keep them short.
- The `pages` CI job needs the install (`corepack enable && pnpm install`): `scripts/build-site.sh` runs `build-docs.mjs`, which imports `marked`, so do not override `before_script` or `cache` there.
- `pnpm site` also fails on dead in-site links and anchors and on a bare `x.md` link to a guide that is not a public page; write internal guides as `../../docs/x.md` and root files as `../../SECURITY.md`.
- Public pages must carry no email, phase number or mention of the original private scripts: `site/docs/security.md` points at `SECURITY.md` (a confidential GitLab issue), not an address.
