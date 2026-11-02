# Phase 8 part 2 (user guides, agent guides, running an instance, the README) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A screenshot pipeline on a seeded local instance, the public guides for using Bongsu, for agents and for running an instance over time, `agents.md` and `cli.md` moved to the site, and a README with screenshots, features, a quick start and a comparison by category.

**Architecture:** `scripts/screenshots/` seeds a SQLite instance with `apps/node`'s driver, serves it with the Node app and the local media store, and captures screens with Playwright in its official Docker image; the guides are Markdown in `site/docs/` written from the product docs and the code; the README is rewritten around three screenshots.

**Tech Stack:** Node 22 ESM, `better-sqlite3` (via `apps/node`), the Node app (`apps/node/dist/server.mjs`), Docker (`mcr.microsoft.com/playwright:v1.57.0-noble`), ffmpeg (host, once, for the demo clip), the existing site build (`pnpm site`, `pnpm test:site`).

**Spec:** `docs/superpowers/specs/2026-10-31-phase8-guides-design.md`

## Global Constraints

- No new repository dependency; nothing in the pipeline touches a real account, database or the network beyond `localhost`; demo data only (`demo_travel`, `demo_running`, `main`, `owner@example.com`, `claude-code`); the demo media show no real people or brands.
- Every claim in a guide is true to the code and the product docs at HEAD (`packages/web/PRODUCT.md`, `packages/web/DESIGN.md`, `packages/dashboard/DESIGN.md`, the routes, `packages/core/src/constants.ts`); UI labels are quoted as the app shows them (`t()` catalogue in `packages/web/src/i18n.ts`, the dashboard's `pages.tsx`).
- Public pages: no email, phase number, private project or internal path; internal links in the `../../docs/x.md` form; `pnpm site` passes (it checks links and anchors); the voice is plain, calm, exact.
- Moves with `git mv`; every reference to `docs/agents.md` and `docs/cli.md` follows (`grep -rnP "(?<!site/)docs/(agents|cli)\.md" --exclude-dir={node_modules,graft,.trail,.superpowers,dist,.wrangler,public} --exclude-dir=superpowers .` prints nothing).
- Conventional Commits (scope `docs`; subjects start lowercase), `Refs #131` / `#132` / `#133` / `#81` / `#130`; hooks never skipped; `pnpm screenshots` is not in CI.
- Before the last commit: `pnpm check && pnpm typecheck && pnpm test:site && pnpm site && pnpm build && pnpm --filter @bongsu/dashboard build` and the reference grep.

## Review Focus

1. A screenshot shows nothing that looks like a real person, handle or brand, and no secret (the session tokens never appear on screen; the agent key page shows a demo key only once in the seed, not in a screenshot). Check in Task 2 (the capture list avoids the key-creation dialog; a review of the PNGs).
2. The seed is idempotent and isolated: running `pnpm screenshots` twice gives the same screens, and nothing is written outside the scratch directory and the two assets folders. Test in Task 1.
3. A guide step that names a button or label matches the app (e.g. "Save new date", "Check YouTube now", "Needs you"): a reader following it finds the control. Check in Tasks 3–5 (a grep of each quoted label against the catalogue or pages).
4. The README's quick starts actually run: the Cloudflare one against `deploy-cloudflare.md`'s steps, the Docker one against `self-hosting.md` and `docker-compose.yml`. Check in Task 6.
5. After the moves, the MCP server's instructions and the dashboard's "Setup guide"/docs links still resolve (`/dashboard/docs/api-reference`, `/dashboard/docs/cli`); `packages/api/src/agent/routes.ts` or `tools.ts` may name `docs/agents.md` in the MCP instructions text. Test in Task 4 (the grep plus the dashboard build).

---

### Task 1: The demo instance: seed and serve (pipeline part 1)

**Files:**
- Create: `scripts/screenshots/seed.mjs`, `scripts/screenshots/serve.mjs`, `scripts/screenshots/index.mjs`, `scripts/screenshots/demo/` (SVG stills `still-1.svg` … `still-4.svg`, a cover `cover.svg`, `reel.mp4` made with `ffmpeg -f lavfi -i color=c=0x131f2a:s=1080x1920:d=3 -f lavfi -i sine=f=440:d=3 -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest reel.mp4` once and committed; under 100 KB), `scripts/screenshots/seed.test.mjs`
- Modify: `package.json` (`"screenshots": "node scripts/screenshots/index.mjs"`, `"test:site"` also runs `scripts/screenshots/seed.test.mjs`), `docs/development.md` (a "Screenshots" section), `.gitignore` (`scripts/screenshots/.scratch/`)

**Interfaces:**
- Produces: `seed.mjs` exports `seedDemo(scratchDir: string, now = new Date()): Promise<{ dbPath, mediaDir, pwaToken, dashboardToken, itemKey, approvedKey, videoId }>`: runs `node apps/node/dist/server.mjs migrate` with `DATABASE_PATH=<scratch>/bongsu.sqlite` (building `apps/node` first if `dist/server.mjs` is missing), opens the file with `better-sqlite3` (import from `apps/node/node_modules/better-sqlite3`), inserts the rows the spec lists (dates relative to `now` in `Asia/Seoul`; texts in the items' columns; approvals hashing the texts and media as `packages/core/src/formats/approved.ts` does, import it), copies `demo/` files to `<mediaDir>/UPLOADS/<folder>/exports/shorts/instagram/<name>.mp4` and `…/posts/<name>/*.svg` as the items' paths require (read `contentPaths` in `packages/core/src/data.ts` for the exact layout), writes `passkeys` (a dummy credential for user `owner`), `settings bootstrap_done`, two `sessions` rows (tokens returned; hashes stored; `app` `pwa` and `dashboard`; `verified_at = now`), an `api_keys` row (`claude-code`, scopes read/draft/plan) and a CLI token row. Idempotent: deletes and recreates the scratch file. `serve.mjs` exports `serve(scratch, env): Promise<{ stop(): Promise<void> }>` spawning `node apps/node/dist/server.mjs` with the env the spec lists and polling `http://127.0.0.1:8787/health` for up to 30 s. `index.mjs`: `seed` → `serve` → `capture` (Task 2) → stop; `--keep` skips the stop and prints the URL and cookies.
- Consumes: `apps/node/src/main.ts`'s env names (`DATABASE_PATH`, `MEDIA_STORE`, `MEDIA_DIR`, `PUBLIC_URL`, `RP_ID`, `DRY_RUN`, `SETUP_TOKEN`), `packages/core/src/formats/approved.ts` (`sha256Hex`, the approval fingerprint), `packages/api/src/pwa/session.ts` (cookie names `COOKIE[app]`; export them if not exported).

- [ ] **Step 1: Write the failing test** `seed.test.mjs` (`node:test`): `seedDemo(tmp)` then open the SQLite file read-only and assert: 2 Instagram + 1 YouTube account; ≥ 8 plan items of which ≥ 3 approved, 1 on hold, 1 posted (a `posted` row with results); 2 drafts; 2 sessions (one per app) whose `token_hash` equals `sha256Hex(token)`; `settings.bootstrap_done` present; 1 passkey; the media files exist at the items' paths; running `seedDemo(tmp)` again yields identical counts and tokens that differ (fresh sessions) — Review Focus 2.
- [ ] **Step 2: Run** `node --test scripts/screenshots/seed.test.mjs`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `seed.mjs`, `serve.mjs`, `index.mjs` (capture wired in Task 2; until then `index.mjs --keep` seeds and serves), the demo media, the scripts and docs.
- [ ] **Step 4: Run** the test (PASS), then `pnpm screenshots --keep` and open `http://localhost:8787/#/` with the printed PWA cookie set (e.g. `curl -b "<cookie>" http://127.0.0.1:8787/app-api/me` → `signedIn: true, accounts: 3`) and `/admin-api/state` with the dashboard cookie → `signedIn: true`. Stop it.
- [ ] **Step 5: Commit** `feat(docs): a seeded demo instance for screenshots` (`Refs #81`).

### Task 2: Capture with Playwright in Docker (pipeline part 2)

**Files:**
- Create: `scripts/screenshots/capture.mjs`, `scripts/screenshots/screens.json`
- Modify: `scripts/screenshots/index.mjs`, `docs/development.md` (the Docker and `sg docker` note; `pngquant` optional)
- Output (committed): `site/docs/assets/app/*.png`, `docs/assets/readme/*.png`

**Interfaces:**
- Consumes: Task 1's `seedDemo` result (`pwaToken`, `dashboardToken`, `itemKey`, `approvedKey`, `videoId`).
- Produces: `screens.json` = `[{ "name": "today", "app": "pwa", "url": "/#/" }, { "name": "calendar", … "/#/calendar" }, { "name": "queue" …}, { "name": "drafts" …}, { "name": "item", "url": "/#/item/{itemKey}" }, { "name": "item-approved", "url": "/#/item/{approvedKey}" }, { "name": "video", "url": "/#/video/main/{videoId}?d={videoDate}" }, { "name": "comments", "url": "/#/comments" }, { "name": "settings", "url": "/#/settings" }, { "name": "overview", "app": "dashboard", "url": "/dashboard/" }, { "name": "connections", "url": "/dashboard/connections" }, { "name": "accounts" …}, { "name": "videos" …}, { "name": "keys" …}, { "name": "settings" …}, { "name": "docs", "url": "/dashboard/docs/the-app" }]`; `capture.mjs` (runs inside the Playwright image: `docker run --rm --network host -v <repo>/scripts/screenshots:/work -v <repo>/site/docs/assets/app:/out/app -v <repo>/docs/assets/readme:/out/readme mcr.microsoft.com/playwright:v1.57.0-noble node /work/capture.mjs`, with `sg docker -c` when `docker info` fails on permissions) reads `screens.json` and the tokens from env, adds the cookies for `localhost`, and for each screen × `["light","dark"]` sets `colorScheme`, viewport (PWA 390×844 @2, dashboard 1280×800 @1), waits for `networkidle` plus the app's loading text to disappear, and saves `<name>-<theme>.png`; the README's three go to `/out/readme` as well. `index.mjs` runs it after `serve`.

- [ ] **Step 1: Write the check** (no unit test can run Playwright here): `index.mjs` asserts after capture that every `screens.json` entry produced both PNGs and that each is under 600 KB; a missing file fails the run naming the screen.
- [ ] **Step 2: Run** `pnpm screenshots`. Expected: the first run fails until `capture.mjs` exists (the assertion names every screen).
- [ ] **Step 3: Implement** `capture.mjs`, `screens.json`, the wiring. Run `pnpm screenshots`: 32 PNGs. Look at each (Read the PNGs): no loading state, no empty page, the dark theme really dark, no token visible (Review Focus 1); redo a screen whose wait was too short.
- [ ] **Step 4: Run** `pnpm screenshots` a second time: the same set (Review Focus 2); `pnpm check` (Biome on the `.mjs`).
- [ ] **Step 5: Commit** `feat(docs): screenshots of the app and the dashboard from the demo instance` (`Refs #81, #131`), the PNGs included.

### Task 3: Using Bongsu (#131)

**Files:**
- Create: `site/docs/the-app.md`, `site/docs/captions-and-checks.md`, `site/docs/the-dashboard.md`
- Modify: `site/docs/nav.json` (Use Bongsu: the three), `site/docs/README.md` (rows)
- Facts: `packages/web/PRODUCT.md`, `packages/web/DESIGN.md`, `packages/web/src/i18n.ts` (labels), `packages/web/src/App.tsx` (flows: `useApprove`, `Reschedule`, `ReleaseDate`, pause/resume, hold, notifications settings), `packages/core/src/formats/caption-lint.ts` (every check, its FAIL/WARN), `packages/core/src/constants.ts` (`CATCH_UP_S`), `packages/dashboard/src/pages.tsx` and `DESIGN.md`

- [ ] **Step 1: Write** the three guides per the spec's outlines, each section with its screenshot (`![Today](assets/app/today-light.png)` with a `<picture>`-free plain image; the dark twin isn't embedded in guides), every quoted label checked against the catalogue (`grep -n '"<label>"' packages/web/src/i18n.ts packages/web/src/App.tsx packages/dashboard/src/pages.tsx`) — Review Focus 3; the caption guide's table of checks generated by reading `lintCaption` (check name, what it looks at, FAIL or WARN, the message).
- [ ] **Step 2: Run** `pnpm test:site && pnpm site` (anchors and links). Expected: PASS.
- [ ] **Step 3: Commit** `docs(docs): using Bongsu: the phone app, captions and checks, the dashboard` (`Refs #131`).

### Task 4: Agents (#132)

**Files:**
- Move: `docs/agents.md` → `site/docs/api-reference.md`, `docs/cli.md` → `site/docs/cli.md`
- Create: `site/docs/connect-claude.md`, `site/docs/what-agents-can-do.md`
- Modify: `site/docs/nav.json` (Agents: connect-claude, what-agents-can-do, api-reference, cli), `site/docs/README.md`, `docs/README.md` (the two rows → the "Running Bongsu" line), `AGENTS.md:14` (`site/docs/cli.md`), every `docs/agents.md` / `docs/cli.md` reference (the grep in Global Constraints; expect `packages/api/src/agent/*.ts` MCP instructions, `packages/cli/src/*`, `docs/development.md`, `docs/security.md`, `site/index.html:219` (the landing page's "How agent keys work" → `docs/api-reference/`), `README.md`), the moved pages' public-safe wording and the `../../docs/` link form

- [ ] **Step 1: The guard**: `grep -rn "docs/agents.md\|docs/cli.md" packages apps site README.md AGENTS.md docs --exclude-dir=superpowers` lists today's references (record it).
- [ ] **Step 2: Move and write.** `api-reference.md` keeps `agents.md`'s content with a new `# API reference` title and a first paragraph pointing at the two new guides; `cli.md` keeps its title. `connect-claude.md` and `what-agents-can-do.md` per the spec; the MCP `claude mcp add` line and the tool names checked against `packages/api/src/agent/tools.ts` (every tool named exists; the scope per tool as in the table).
- [ ] **Step 3: Run** the Global Constraints grep (empty), `pnpm test:site && pnpm site`, `pnpm typecheck`, `pnpm --filter @bongsu/dashboard build`, `pnpm --filter @bongsu/cli test` if the CLI's tests mention the doc (Review Focus 5). Expected: PASS.
- [ ] **Step 4: Commit** `docs(docs): agents: connect Claude, what agents can do, the API and CLI references` (`Refs #132`).

### Task 5: Running it over time (#133)

**Files:**
- Create: `site/docs/updating.md`, `site/docs/backups.md`, `site/docs/faq.md`
- Modify: `site/docs/nav.json` (Reference: … platform-terms, updating, backups, faq), `site/docs/README.md`, `site/docs/self-hosting.md` ("## Updating" and "## Backups" become two lines linking the new pages), `site/docs/deploy-cloudflare.md` ("## Updating" and "## Backups" likewise)
- Facts: `apps/node/src/main.ts` (the `backup`, `export`, `import`, `load-sql` commands), `docs/databases.md` (D1 export, Postgres), `site/docs/drive.md`, `packages/core/src/constants.ts`, `packages/core/src/providers/refresh.ts` (token renewals), the Instagram and YouTube guides' limits, the PWA's version check (`packages/web/vite.config.ts` `version.json`), `packages/api/src/dashboard/routes.ts` messages (`SETUP_TOKEN isn't set…`)

- [ ] **Step 1: Write** the three pages per the spec; every command copied from the code or the existing guides, every error message quoted as the app prints it.
- [ ] **Step 2: Run** `pnpm test:site && pnpm site`. Expected: PASS.
- [ ] **Step 3: Commit** `docs(docs): updating, backups and restore, FAQ and troubleshooting` (`Refs #133`).

### Task 6: The README and the console steps (#81, #130)

**Files:**
- Modify: `README.md` (rewritten per the spec), `site/index.html:241` (the stale roadmap line → "Cloudflare Workers, or Docker on your own server, with SQLite or Postgres."), `site/docs/instagram-graph.md` and `site/docs/youtube.md` (numbered console steps with `assets/meta/…` / `assets/google/…` placeholders and `<!-- screenshot: … -->` lines; `site/docs/assets/meta/.gitkeep`, `site/docs/assets/google/.gitkeep`)

- [ ] **Step 1: Write** the README (the three `<picture>` blocks reference `docs/assets/readme/<screen>-light.png` and `-dark.png`), the landing line, the console steps.
- [ ] **Step 2: Check** the quick starts against the guides (Review Focus 4): each command appears in `deploy-cloudflare.md` / `self-hosting.md`; `pnpm site` (the placeholders are images that don't exist yet: the build must not fail on a missing image — if it does, a `.gitkeep`-sized SVG placeholder per step with the step's number in it instead, and the owner replaces them).
- [ ] **Step 3: Commit** `docs(repo,docs): the README with screenshots, features, quick starts and a comparison; console steps` (`Refs #81, #130`).

### Task 7: Plan, full check

**Files:** Modify `docs/PLAN.md` Phase 8 (tick the README box, the #131, #132, #133 sub-boxes "done 2026-10-31"; #130's sub-box gets "console screenshots: the owner's, placeholders in place").

- [ ] **Step 1: Write** the ticks. **Step 2: Full verification** per the Global Constraints. **Step 3: Commit** `docs(docs): tick Phase 8 part 2: the guides and the README` (`Refs #131, #132, #133, #81, #130`).
