# Phase 8, part 1: the public docs site, community files, platform terms

The first half of Phase 8 (`docs/PLAN.md`): #130 (the public docs built with the project site and the stable
user-facing guides moved there), #84 (`CODE_OF_CONDUCT.md`, `SECURITY.md`, issue and merge request templates) and
#85 (a note on platform terms). #82, the earlier umbrella list of docs, is superseded by #130–#133 and closes with
this work. The new guides (#131–#133) and the README with screenshots (#81) are part 2. Decided with the owner on
2026-10-31: structure first, content after.

## #130 The public docs

### Where things live

- `site/docs/*.md`: the guides for people who run Bongsu. Each exists once: the user-facing guides **move** out of
  `docs/` (`git mv`, history kept), they aren't copied. `docs/` keeps the internal pages (architecture, development,
  databases, schema, platforms, media stores, CLI, agents, brand, the plan); `docs/agents.md` and `docs/cli.md` stay
  until #132 moves the agent guide.
- Moved, with the names they have: `deploy-cloudflare.md`, `self-hosting.md`, `instagram-graph.md`,
  `instagram-composio.md`, `youtube.md`, `configuration.md`, `security.md`. Split: `docs/overview.md` becomes
  `site/docs/what-is-bongsu.md` (what it does, the main ideas in the owner's words) and `site/docs/how-it-works.md`
  (approval, the schedule and the catch-up window, drafts and the inbox, notifications, results: what happens, not
  how the tick does it); its stale "What it isn't (yet)" list is rewritten to today's state (the dashboard exists,
  accounts are connected there, Instagram's own API is the default). `docs/drive.md` moves without its store
  interface part, which goes to `docs/media-stores.md` if it isn't there already. `docs/architecture.md` keeps the
  internals.
- `site/docs/README.md`: the index page ("Docs"), and `site/docs/nav.json`: the sidebar, in order:
  Get started (what-is-bongsu, how-it-works), Install (deploy-cloudflare, self-hosting), Connect your accounts
  (instagram-graph, instagram-composio, youtube, drive), Use Bongsu (empty until #131; the section is listed only
  when it has pages), Agents (empty until #132), Reference (configuration, security, platform-terms). A page's
  title is its `# ` heading.
- `site/docs/assets/`: images the guides use (none yet; #130's screenshots arrive with the step-by-step app guides in
  part 2), copied as they are.

### The build

- `scripts/build-docs.mjs` (ESM, Node 22, no build step of its own) renders `site/docs/*.md` into
  `<out>/docs/<name>/index.html` and `<out>/docs/index.html`, in the site's style, with the landing page's header
  nav, a sidebar from `nav.json`, the article, and a footer. `scripts/build-site.sh` calls it after copying the
  landing page; `pnpm site` builds everything; the `pages` CI job is unchanged. The `check` job runs `pnpm site`
  too, so a broken guide or link fails the pipeline.
- Markdown through `marked` (the one small dependency the issue allows; the dashboard already uses 18.1.1; it
  becomes a root devDependency at the same version so the script resolves it). The pure parts live in
  `scripts/docs-lib.mjs`: `slug(text)` (GitLab's heading anchors, the dashboard's rule), `rewriteLink(href, pages,
  blobUrl)` (`x.md#y` → `../x/#y` for a public page, `{{BLOB_URL}}/docs/x.md` for an internal one, `#y` and
  `https?:` unchanged, anything else text), `renderPage(md, opts)`, `navHtml(nav, current)`. `node --test
  scripts/docs-lib.test.mjs` (`pnpm test:site`, in the `check` job) covers them.
- Style: `site/docs.css` next to `site.css`, reusing its tokens (Icon Navy, Ember, the system font, light and dark),
  nothing loaded from third parties: a two-column layout (sidebar left from 60rem, above the article under it), the
  prose (headings with anchors, code blocks, tables that scroll on a phone, notes), the active sidebar entry. No
  JavaScript; search (Pagefind) can come later.
- Each page: `<title>` "<page title> · Bongsu docs", a description from the first paragraph, the site's favicon and
  theme colour, a "Edit this page" link to the file in the repository (`BLOB_URL`), and the landing page's "Docs"
  links point at `/docs/` instead of the repository folder (`site/index.html` nav, footer and the "Run your own"
  list; the deploy guide link becomes `docs/deploy-cloudflare/`).

### What follows the move

- The dashboard bundles the public guides instead of `docs/*.md`: `packages/dashboard/src/docs.tsx` globs
  `../../../site/docs/*.md` (`nav.json` and `README.md` included; `README` stays the "All guides" index), the guide
  names are unchanged, so `/dashboard/docs/<name>` and every `GuideLink` keep working; the `docs:` strings in
  `packages/core/src/providers/index.ts` and `packages/dashboard/src/pages.tsx` read `site/docs/<name>.md`. The
  dashboard no longer shows the internal pages (a changeset says so).
- Every other reference follows: `docs/README.md` (the internal index links to the public pages for setup, under a
  "Running Bongsu" line), `README.md`, `AGENTS.md`'s layout table (`site/docs/`), `Dockerfile` and
  `docker-compose.yml` comments, `packages/core/src/env.ts`, `apps/node/src/{main,env}.ts`,
  `packages/api/src/pwa/uploads.ts`, `packages/api/src/dashboard/routes.ts`, `packages/web/vite.config.ts` and
  `App.tsx`'s `/dashboard/docs/…` links (unchanged names), the internal docs that link to moved ones
  (`databases.md`, `platforms.md`, `media-stores.md`, `cli.md`, `development.md`, `PLAN.md`'s layout table),
  `docs/superpowers/*` left as history. `scripts/check-personal.sh` and `pnpm check` are unaffected.
- Links inside moved guides to internal pages (`development.md#local-testing`, `databases.md`, `media-stores.md`,
  `agents.md`, `cli.md`) stay as `.md` links; the build turns them into repository links.
- Nothing from `PLAN.md` or content specific to one private project goes public; the moved guides are read once for stray internal
  references (a phase number, a private script) and those sentences are made public-safe.

## #84 Community files

- `CODE_OF_CONDUCT.md`: the Contributor Covenant 2.1, enforcement through the maintainer by a confidential GitLab
  issue (no personal email).
- `SECURITY.md`: supported versions (the latest release), how to report (a confidential issue on GitLab, what to
  include, the expected first answer within 7 days, no public disclosure before a fix), what counts (the passkey
  flow, approvals, keys, media links, workspace isolation) and the link to the public security page.
  `site/docs/security.md`'s "Reporting a vulnerability" line points to `SECURITY.md` instead of an email.
- `.gitlab/issue_templates/Bug.md` (what happened, what was expected, the runtime: Cloudflare or Docker, version,
  logs without secrets), `.gitlab/issue_templates/Feature.md` (the problem, the proposal, what the owner must still
  decide), `.gitlab/merge_request_templates/Default.md` (the Conventional Commits title, what and why, tests,
  changeset, docs, `Closes #`). `CONTRIBUTING.md` and `README.md` link the three files.

## #85 Platform terms

`site/docs/platform-terms.md` (Reference): Bongsu posts only through the platforms' official APIs with the owner's
own apps and tokens; it respects their rate limits (Instagram's publishing limit, YouTube's daily quota, Bongsu's
own caps); it never scrapes, automates a browser or collects data about other accounts; the owner is responsible
for the content and for following each platform's terms, linked. Linked from `README.md` and the index.

## Docs and bookkeeping

- `docs/PLAN.md`: tick #130's first sub-box, #84 and #85 ("done 2026-10-31"); #82 closed as superseded.
- Changeset: `@bongsu/dashboard` patch (its guides are the public ones).
- One merge request, `docs(docs,site): the public docs site, community files, platform terms`, closing #130's
  build item by reference (`Refs #130`, the issue stays open for its screenshots) and `Closes #82, #84, #85`.

## Out of scope

The new guides (#131, #132, #133) and the README's screenshots (#81): part 2. Search on the docs site. Moving
`agents.md` and `cli.md` (#132). Any change to the landing page beyond its links.
