# Phase 8 part 1 (public docs site, community files, platform terms) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The user-facing guides live once in `site/docs/`, are built into `/docs/` pages with the project site and bundled into the dashboard from there; the repository gains a code of conduct, a security policy, templates and a platform-terms page.

**Architecture:** A pure library (`scripts/docs-lib.mjs`: slug, link rewriting, nav, page rendering through `marked`) tested with `node --test`, driven by `scripts/build-docs.mjs` from `scripts/build-site.sh`. The guides move with `git mv`; the dashboard's glob and every reference follow. Styling is a `site/docs.css` on the site's tokens; no JavaScript, nothing third-party.

**Tech Stack:** Node 22 ESM scripts, `marked` 18.1.1 (root devDependency), `node --test`, the existing site CSS, Vite (dashboard), GitLab CI.

**Spec:** `docs/superpowers/specs/2026-10-31-phase8-public-docs-design.md`

## Global Constraints

- Each guide exists once: moved with `git mv`, never copied; nothing from `docs/PLAN.md` or content specific to one private project goes public; demo data only (`demo_travel`, `example.com`); no personal email anywhere new (reports go through a confidential GitLab issue).
- The docs pages load nothing from third parties, use the system font, light and dark; `marked` is the only Markdown dependency (already in the workspace at 18.1.1).
- Public page links: `x.md#y` → the page (`../x/#y` from a page, `x/#y` from the index) when `x` is a public guide; `{{BLOB_URL}}/docs/x.md#y` when it is an internal doc; `#y` and `https?:` links unchanged; any other `.md` link is rendered as text.
- `/dashboard/docs/<name>` keeps working for every moved guide, with the same names; `GuideLink` unchanged.
- Conventional Commits (subjects start lowercase), `Refs #130` / `#84` / `#85`; a dashboard patch changeset; hooks never skipped.
- Before the last commit: `pnpm check && pnpm typecheck && pnpm test && pnpm test:site && pnpm site && pnpm build`, the dashboard build, and `grep -rnP "(?<!site/)docs/(deploy-cloudflare|self-hosting|instagram-graph|instagram-composio|youtube|drive|configuration|security|overview)\.md" --exclude-dir={node_modules,graft,.trail,.superpowers,dist,.wrangler} --exclude-dir=superpowers .` prints nothing (the new `site/docs/…` paths don't match).

## Review Focus

1. A guide that links to another public guide's section (`youtube.md#quota`) renders a working relative link from both a page and the index. Test in Task 1 (`rewriteLink` with both bases).
2. A guide that links to an internal doc (`development.md#local-testing`) renders a repository link, not a broken `/docs/development/`. Test in Task 1.
3. The dashboard still shows `/dashboard/docs/youtube` and the providers' "Setup guide" links after the move. Test in Task 2 (dashboard test fetching the docs route or the bundled guide list).
4. The landing page's "Docs" goes to `/docs/`, and `pnpm site` fails loudly on an unfilled `{{…}}` placeholder in any generated page. Test in Task 3.
5. A Markdown heading with punctuation ("2. Connect the channel from the dashboard") gets the same anchor the dashboard and GitLab use. Test in Task 1.

---

### Task 1: The docs library and its tests (#130)

**Files:**
- Create: `scripts/docs-lib.mjs`, `scripts/docs-lib.test.mjs`
- Modify: `package.json` (root: `"test:site": "node --test scripts/docs-lib.test.mjs"`, devDependency `"marked": "18.1.1"`), `.gitlab-ci.yml:24-32` (the `check` job runs `pnpm test:site` after `pnpm test`)

**Interfaces:**
- Produces (all exported from `scripts/docs-lib.mjs`):
  - `slug(text: string): string` (GitLab's rule, as `packages/dashboard/src/docs.tsx:14-21`).
  - `rewriteLink(href: string, pages: string[], blobUrl: string, base: "../" | ""): string | null` (null = render as text).
  - `navHtml(nav: { section: string; pages: string[] }[], titles: Record<string, string>, current: string | null, base: "../" | ""): string` — one `<nav class="docs-nav" aria-label="Docs">` with a `<h2>` per non-empty section and `<a href="<base><page>/">` per page, `aria-current="page"` on `current`.
  - `renderPage(markdown: string, opts: { name: string; pages: string[]; blobUrl: string; base: "../" | "" }): { title: string; description: string; html: string }` — `title` from the first `# ` heading (else `name`), `description` the first paragraph's text (at most 160 characters), `html` through `marked` (gfm) with the heading renderer adding `id="<slug>"` and the link renderer using `rewriteLink` (external links get `target="_blank" rel="noopener noreferrer"`).
  - `pageHtml(p: { title; description; html; name; nav: string; siteUrl: string; blobUrl: string; editPath: string; base: "../" | "" }): string` — the full document: `<title>${title} · Bongsu docs</title>`, the description meta, `theme-color #131f2a`, favicon `<base>../brand/favicon.ico`, stylesheet `<base>../docs.css`, the landing page's header nav (Home → `<base>../`, Docs → `<base>`, Source → `{{REPO_URL}}` left for `build-site.sh`'s sed), the sidebar, `<article class="prose">`, an "Edit this page" link to `${blobUrl}/${editPath}`, a footer "MIT License".

- [ ] **Step 1: Write the failing tests** `scripts/docs-lib.test.mjs` (`node:test`, `node:assert/strict`):
  - `slug`: `"2. Connect the channel from the dashboard"` → `"2-connect-the-channel-from-the-dashboard"`; `"Keeping it working"` → `"keeping-it-working"`; `"<code>bongsu</code> export"` → `"bongsu-export"`.
  - `rewriteLink`: `("youtube.md#quota", ["youtube"], B, "../")` → `"../youtube/#quota"`; same with base `""` → `"youtube/#quota"`; `("development.md#local-testing", ["youtube"], "https://x/blob/main", "../")` → `"https://x/blob/main/docs/development.md#local-testing"`; `("#here", …)` → `"#here"`; `("https://example.com/a", …)` → unchanged; `("../CONTRIBUTING.md", …)` → `null`; `("assets/a.png", …)` → `"../assets/a.png"` from a page and `"assets/a.png"` from the index (Review Focus 1, 2).
  - `navHtml([{ section: "Install", pages: ["deploy-cloudflare"] }, { section: "Use Bongsu", pages: [] }], { "deploy-cloudflare": "Deploy on Cloudflare" }, "deploy-cloudflare", "../")` contains `<h2>Install</h2>`, `href="../deploy-cloudflare/"`, `aria-current="page"` and not `Use Bongsu`.
  - `renderPage("# YouTube\n\nFirst para.\n\n## 2. Quota\n\nSee [Drive](drive.md).", { name: "youtube", pages: ["youtube", "drive"], blobUrl: B, base: "../" })` → `title "YouTube"`, `description "First para."`, html contains `<h2 id="2-quota">` and `href="../drive/"` (Review Focus 5).
  - `pageHtml(...)` output contains `<title>YouTube · Bongsu docs</title>`, `href="../../docs.css"`, `href="{{REPO_URL}}"` and the edit link.
- [ ] **Step 2: Run** `pnpm test:site`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** the library; add the root devDependency (`pnpm install`, lockfile committed) and the script; add `pnpm test:site` to the `check` job.
- [ ] **Step 4: Run** `pnpm test:site`. Expected: all pass. `pnpm check` clean (Biome formats `.mjs`: run `pnpm fix`).
- [ ] **Step 5: Commit** `feat(site): the docs page renderer: slugs, links, nav, page shell` (`Refs #130`).

### Task 2: Move the guides and repoint everything (#130)

**Files:**
- Move (`git mv`): `docs/{deploy-cloudflare,self-hosting,instagram-graph,instagram-composio,youtube,configuration,security,drive}.md` → `site/docs/`
- Create: `site/docs/what-is-bongsu.md`, `site/docs/how-it-works.md` (from `docs/overview.md`, which is deleted), `site/docs/README.md` (the index: one line per page under the nav's sections), `site/docs/nav.json`
- Modify: `docs/media-stores.md` (receives drive.md's store-interface part if missing), `docs/README.md` (the internal index: a "Running Bongsu" line pointing at `site/docs/README.md` and the moved pages removed from its table), `packages/dashboard/src/docs.tsx:7-11` (glob `../../../site/docs/*.md`, no PLAN exclusion needed), `packages/core/src/providers/index.ts:88,112,137` and `packages/dashboard/src/pages.tsx:481,487` (`docs: "site/docs/<name>.md"`), the comments and messages that name `docs/<moved>.md`: `packages/core/src/env.ts:34`, `apps/node/src/main.ts:1`, `apps/node/src/env.ts:2`, `packages/api/src/pwa/uploads.ts:35`, `packages/api/src/dashboard/routes.ts:196`, `packages/web/vite.config.ts:31`, `Dockerfile:1,11,15` (and check its `COPY` lines include `site/`), `docker-compose.yml:1,11`, `README.md:47,60`, `AGENTS.md:19` (a `site/docs/` row: "the public guides, built into the site and the dashboard"), `docs/{databases,platforms,media-stores,cli,development}.md` and `docs/PLAN.md`'s layout table (section 2.1) where they link moved pages
- Test: `apps/cloudflare/test/dashboard.test.ts` (or wherever `/dashboard/docs` is served; grep `dashboard/docs` in apps/cloudflare/test)

**Interfaces:**
- Produces: `site/docs/nav.json` = `[{"section":"Get started","pages":["what-is-bongsu","how-it-works"]},{"section":"Install","pages":["deploy-cloudflare","self-hosting"]},{"section":"Connect your accounts","pages":["instagram-graph","instagram-composio","youtube","drive"]},{"section":"Use Bongsu","pages":[]},{"section":"Agents","pages":[]},{"section":"Reference","pages":["configuration","security"]}]` (Task 5 adds `platform-terms`).
- The split: `what-is-bongsu.md` = the one-line definition, "Main ideas" rewritten for an owner (plan item, approval, drafts and the inbox, Shorts comments, Trial Reels, notifications, results and comments; no key formats like `reel:<project>/<name>`), and "What Bongsu isn't" with today's truth (self-hosted, one workspace per instance until Phase 13 — say "for now", not the phase number; a dashboard for setup; Instagram through its own API or Composio). `how-it-works.md` = approval (hashes, re-approval), the schedule and the 6-hour catch-up window, jobs in the owner's words (a post goes out in steps and survives restarts), drafts, the Drive inbox and `_posted`, notifications and the digest, results after 24 h. Internals (Workers, cron, container polling) stay in `docs/architecture.md`.
- Moved guides keep their text except: internal references made public-safe (no phase numbers, no private scripts); `security.md`'s "Reporting a vulnerability" becomes the sentence "Report a vulnerability as described in the repository's SECURITY.md: a confidential issue on GitLab." (plain text: the build renders a non-public `.md` link as text; Task 4 creates the file).

- [ ] **Step 1: The move's guard** (the guides are bundled client-side by `import.meta.glob`, so there is no server route to test): `pnpm --filter @bongsu/dashboard build && grep -l "Keeping it working" packages/dashboard/dist/assets/*.js` finds a chunk today (that sentence is `youtube.md`'s "## Keeping it working"). Record the output.
- [ ] **Step 2: Move the files** (`git mv`), rebuild: the grep finds nothing (the glob still points at `docs/`). Expected: no chunk. Then repoint the glob and the grep finds a chunk again (Review Focus 3).
- [ ] **Step 3: Implement** the moves, the split, the index, `nav.json`, every reference listed in Files. `grep` per the Global Constraints must print nothing.
- [ ] **Step 4: Run** `pnpm check && pnpm typecheck && pnpm --filter @bongsu/dashboard build && pnpm --filter @bongsu/web build`, the dashboard test file, `node -e "JSON.parse(require('fs').readFileSync('site/docs/nav.json','utf8'))"`. Expected: PASS.
- [ ] **Step 5: Commit** `docs(docs,site): the user-facing guides move to site/docs, the dashboard bundles them from there` (`Refs #130`).

### Task 3: Build the docs pages with the site (#130)

**Files:**
- Create: `scripts/build-docs.mjs`, `site/docs.css`
- Modify: `scripts/build-site.sh` (after the landing page: `node scripts/build-docs.mjs "$out" "$blob_url" "$site_url"`; the sed of `{{REPO_URL}}`/`{{BLOB_URL}}`/`{{TREE_URL}}`/`{{SITE_URL}}` then runs over `$out/docs/**/*.html` too; the placeholder check covers them), `site/index.html:44,219,252-254,262` (Docs → `docs/`; "Deploy to Cloudflare" → `docs/deploy-cloudflare/`; agents and local-testing links stay repository links until #132), `.gitlab-ci.yml:24-32` (`check` runs `pnpm site`), `docs/development.md` (the site section: how the docs are built, `pnpm site`, `pnpm test:site`)
- Test: `scripts/docs-lib.test.mjs` (a build smoke test: run `scripts/build-docs.mjs` into a temp dir with a two-page fixture, assert the files and a rewritten link)

**Interfaces:**
- Consumes: Task 1's library; Task 2's `site/docs/*.md`, `nav.json`, `README.md`.
- Produces: `node scripts/build-docs.mjs <out> <blobUrl> <siteUrl> [<srcDir>=site/docs]` writes `<out>/docs/index.html` (from `README.md`, base `""`), `<out>/docs/<name>/index.html` per page in `nav.json` and any other `.md` in the folder (base `"../"`), copies `site/docs/assets/` to `<out>/docs/assets/` when present and `site/docs.css` to `<out>/docs.css`; exits 1 naming the file on a Markdown file missing its `# ` title or a nav entry without a file. `site/docs.css`: the layout (`.docs` grid: sidebar 16rem from 60rem, stacked below), `.docs-nav` (sections, links, `[aria-current]`), `.prose` (headings with `:target` highlight, `pre`/`code` on `--card`, tables in an overflow wrapper, blockquotes as notes, images max-width 100%), light and dark through `site.css`'s tokens.

- [ ] **Step 1: Write the failing test** in `scripts/docs-lib.test.mjs`: `it("build-docs renders a folder into pages")`: write a temp `src/` with `README.md` (`# Docs\n\n[A](a.md)`), `a.md` (`# A\n\nSee [B](b.md#x) and [dev](development.md).`), `b.md` (`# B\n\n## x`), `nav.json` `[{"section":"S","pages":["a","b"]}]`; `execFileSync("node", ["scripts/build-docs.mjs", out, "https://x/blob/main", "https://s", src])`; assert `out/docs/index.html` contains `href="a/"`, `out/docs/a/index.html` contains `href="../b/#x"` and `href="https://x/blob/main/docs/development.md"`, `out/docs/b/index.html` has `<h2 id="x">`, and `out/docs.css` exists.
- [ ] **Step 2: Run** `pnpm test:site`. Expected: FAIL (script missing).
- [ ] **Step 3: Implement** the script, the CSS, the `build-site.sh` wiring, the landing page links, the CI line, the development doc paragraph. Then `pnpm site` and open `public/docs/index.html` and one page in a browser if one is available (else read the HTML): the nav, the article, the edit link.
- [ ] **Step 4: Run** `pnpm test:site && pnpm site && grep -rL "{{" public/docs | head -1 && ! grep -rn "{{" public` (Review Focus 4). Expected: PASS, no placeholder left.
- [ ] **Step 5: Commit** `feat(site): the public docs built into /docs/ with the project site` (`Refs #130`).

### Task 4: Community files (#84)

**Files:**
- Create: `CODE_OF_CONDUCT.md`, `SECURITY.md`, `.gitlab/issue_templates/Bug.md`, `.gitlab/issue_templates/Feature.md`, `.gitlab/merge_request_templates/Default.md`
- Modify: `CONTRIBUTING.md` (a "Code of conduct" line and "Security" line at the top list), `README.md` (a "Contributing" paragraph linking `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`)

**Interfaces:**
- Produces: `CODE_OF_CONDUCT.md` = Contributor Covenant 2.1 with the enforcement contact "a confidential issue on the project's GitLab (Issues → New issue → tick 'This issue is confidential')". `SECURITY.md` sections: Supported versions (the latest release), Reporting (the confidential issue, what to include: steps, the runtime, version, no secrets; a first answer within 7 days; no public disclosure before a fix is released), Scope (passkeys and sessions, approvals, API keys and scopes, signed media links, workspace isolation), and a link to the public security page (`site/docs/security.md`). The templates: Bug (What happened / What you expected / Runtime (Cloudflare or Docker) and version / Logs or screenshots, without secrets or real handles), Feature (The problem / The proposal / What's still open), Default MR (Title follows Conventional Commits; What and why; Tests; `- [ ] changeset` ; `- [ ] docs`; `Closes #`).

- [ ] **Step 1: Write** the five files and the two link edits. No automated test exists for Markdown; the check is `pnpm check` (Biome ignores Markdown) and reading each file once.
- [ ] **Step 2: Verify** `grep -rn "@" CODE_OF_CONDUCT.md SECURITY.md .gitlab | grep -v "^.*@\(mention\|gitlab\)" ` prints no email address.
- [ ] **Step 3: Commit** `docs(repo): code of conduct, security policy, issue and merge request templates` (`Refs #84`).

### Task 5: Platform terms (#85)

**Files:**
- Create: `site/docs/platform-terms.md`
- Modify: `site/docs/nav.json` (Reference gains `platform-terms`), `site/docs/README.md` (its line), `README.md` (one sentence under the highlights or the quick start: "Bongsu posts through the platforms' official APIs only; see platform terms" linking `site/docs/platform-terms.md`)

**Interfaces:**
- Produces: the page, sections: "Official APIs only" (the Instagram API with Content Publishing, YouTube Data API, your own Meta and Google apps and tokens; Composio as the one optional third party, the owner's choice), "Rate limits" (Instagram's content publishing limit per 24 h, YouTube's 10,000 daily quota units with Bongsu's costs, Bongsu's own caps: `JOBS_PER_TICK`, two Shorts comments per run), "No scraping" (no browser automation, no unofficial endpoints, no data about other accounts beyond comments on your own posts), "Your responsibility" (the content, each platform's terms, linked: Meta Platform Terms, YouTube API Services Terms of Service, Google API Services User Data Policy).

- [ ] **Step 1: Write** the page and the three edits. **Step 2: Run** `pnpm test:site && pnpm site` (the page builds and the nav lists it). Expected: PASS. **Step 3: Commit** `docs(site): platform terms: official APIs, rate limits, no scraping` (`Refs #85`).

### Task 6: Plan, changeset, full check

**Files:** Modify `docs/PLAN.md` Phase 8 (tick the #130 sub-box with "(Done 2026-10-31: `site/docs/`, built by `scripts/build-docs.mjs`; the app-step screenshots come with #131, #130.)", the #84 and #85 boxes "done 2026-10-31"), `.changeset/public-docs.md` (`"@bongsu/dashboard": patch`: the dashboard's guides are the public ones from `site/docs/`; the internal pages are no longer bundled).

- [ ] **Step 1: Write** them. **Step 2: Full verification** per the Global Constraints (`pnpm fix && pnpm check && pnpm typecheck && pnpm test && pnpm test:site && pnpm site && pnpm build`, the dashboard build, the reference grep). Expected: all pass, grep empty. **Step 3: Commit** `docs(docs): tick Phase 8 part 1: public docs, community files, platform terms` (`Refs #130, #84, #85`).
