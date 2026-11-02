# Phase 8, part 2: the user guides, the agent guides, running an instance over time, the README

The second half of Phase 8 (`docs/PLAN.md`): #131 (using Bongsu: the phone app, captions and checks, the
dashboard), #132 (agents: Connect Claude, what an agent can and can't do, the reference; `agents.md` and `cli.md`
move to the public site), #133 (updating, backups and restore, FAQ and troubleshooting), #81 (the README: what it
does, screenshots, features, quick start for both runtimes, a comparison by category) and #130's leftover (the
Meta and Google app steps with screenshots). Decided with the owner on 2026-10-31: screenshots come from an
automated pipeline on a seeded local instance; the comparison names categories, not products; `cli.md` moves too.

## The screenshot pipeline

`scripts/screenshots/` (Node 22 ESM, run as `pnpm screenshots`), no new repository dependency:

- `seed.mjs` builds a demo instance in a scratch directory: migrates a fresh SQLite file with `apps/node`'s
  `server.mjs migrate`, then writes the demo rows with `better-sqlite3` (already `apps/node`'s driver): the default
  workspace in `Asia/Seoul` with an owner (`owner@example.com`), two Instagram accounts (`demo_travel`,
  `demo_running`) and one YouTube channel (`main`, "Demo Vlogs") with their connections; a week of plan items on
  both accounts (Reels, a carousel, a photo, a Story; some approved, one on hold, one needing re-approval, one
  posted yesterday with results and two comments), two open drafts (one from the inbox, one from an agent), a
  Shorts comment waiting, the next-days queue; an agent key named `claude-code`, a CLI token; a `passkeys` row so the
  app isn't in setup, `bootstrap_done`, and one session for the PWA and one for the dashboard whose tokens the
  script prints (their hashes in `sessions`). Media: `scripts/screenshots/demo/` holds small demo files made once
  (SVG stills for the posts, a 3-second `ffmpeg`-made MP4 for the Reels, all demo-only, no real people), copied to
  `MEDIA_DIR` at the paths the items name (`UPLOADS/<folder>/exports/…`).
- `serve.mjs` starts `apps/node`'s server on `127.0.0.1:8787` with `DATABASE_PATH` and `MEDIA_DIR` in the scratch
  directory, `MEDIA_STORE=local`, `DRY_RUN=1`, `PUBLIC_URL=http://localhost:8787`, `RP_ID=localhost`, the
  `BONGSU_*` branding defaults, and waits for `/health`.
- `capture.mjs` runs inside `mcr.microsoft.com/playwright:v1.57.0-noble` (`docker run --rm --network host`, the
  script and the output folder mounted; `sg docker` where the shell lacks the group) with the two session cookies
  (`Secure` cookies are accepted on `localhost`). It captures each screen in the list below, light and dark
  (`colorScheme`), the PWA at 390×844 (device scale 2) and the dashboard at 1280×800, into
  `site/docs/assets/app/<screen>-<theme>.png` and `docs/assets/readme/<screen>-<theme>.png`, optimised with
  `pngquant` if present, else as written. Screens: PWA `today`, `calendar`, `queue`, `drafts`, `item` (a Reel
  needing approval, with the approve bar), `item-approved`, `video` (a scheduled Short with the Release date card),
  `comments`, `settings`; dashboard `overview`, `connections`, `accounts`, `videos`, `keys`, `settings`,
  `docs` (a guide page). The README uses `today-light`, `item-light`, `overview-light` (and their dark twins in a
  `<picture>`).
- `index.mjs` runs the three in order and tears the server down; `--keep` leaves it running for a look.
- The pipeline never touches a real account, database or network beyond localhost; `docs/development.md` documents
  it ("Screenshots"), and `pnpm screenshots` is not in CI (Docker and ffmpeg are local tools).

## #131 Using Bongsu

Three public guides in the "Use Bongsu" section (`nav.json`), written from `packages/web/PRODUCT.md`,
`packages/web/DESIGN.md`, `packages/dashboard/DESIGN.md` and the code, with the screenshots above:

- `the-app.md` (The phone app): installing it (the dashboard's Devices & passkeys → a code → the passkey); Today
  and "Needs you"; Calendar (Instagram items and YouTube videos, "Check YouTube now"); Queue; Drafts (schedule or
  refuse; New draft from the phone); the item page (what the approve bar shows, approving with the passkey,
  re-approval after a change, Change date, hold); a scheduled YouTube video's page (Release date); pausing
  everything and resuming; notifications (web push, ntfy, action buttons) and the daily digest; comments and
  replies; offline and stale data; the time zone (the workspace's, your own).
- `captions-and-checks.md`: caption, self-comment, second comment, alt texts; what the caption check catches
  (length, the first line and the fold, the hashtag cap, filler tags, tag placement, mentions, links, emoji
  density, invisible characters, the concrete hook, one ask) and which are FAIL (block approval) versus WARN; per
  account rules in the dashboard (hashtag cap, fold, language checks off).
- `the-dashboard.md`: Get started; Connections (Instagram, YouTube, Composio, Drive); OAuth apps (your own Meta
  and Google apps); Accounts (capabilities, Trial Reels default, caption rules, disable, remove); Videos; Devices &
  passkeys (phones, passkeys, recovery codes); Keys & tokens (agent keys with scopes, CLI tokens); Audit; Settings
  (time zone, digest hour, branding at build time pointer).

## #132 Agents

The "Agents" section:

- `connect-claude.md` (Connect Claude): create a key in the dashboard (scopes: start with `read`, `draft`, `plan`),
  `claude mcp add --transport http bongsu https://<your instance>/mcp --header "Authorization: Bearer …"`, the
  first `get_status` and `list_accounts`, a `plan_add`, what the owner then sees in the app (a post needing
  approval); other MCP clients (any streamable-HTTP client; the CLI's `bongsu mcp` bridge for stdio-only ones);
  the `bongsu` MCP server's own instructions.
- `what-agents-can-do.md`: plan, draft, edit texts, record manual posts, pause, move a YouTube release date with
  the opt-in scope; never approve, resume or manage keys; why a change sends an item back for approval (the
  approval hashes the texts and media); times and zones (`at`, `date`/`time`, `due`/`due_at`); rate limit;
  workspace isolation.
- `agents.md` → moved from `docs/` as `api-reference.md` (API keys and scopes, CLI tokens, MCP, the tools and REST
  endpoints table, CLI-only routes), and `cli.md` → moved as `cli.md` (The bongsu command). `docs/README.md` and
  the code comments that name them follow; `AGENTS.md`'s layout table names `site/docs/cli.md`.

## #133 Running it over time

The "Reference" section gains:

- `updating.md`: Cloudflare (`git pull`, `pnpm install`, build, `wrangler deploy` both Workers, migrations with
  `wrangler d1 migrations apply`), Docker (`docker compose pull`/`build`, `up -d`, migrations run at start), reading
  the changelogs (`packages/*/CHANGELOG.md`, Changesets), what a breaking change looks like.
- `backups.md` (Backups and restore): D1 (`wrangler d1 export`, `bongsu export`), the SQLite file on Docker
  (`node server.mjs backup`, the volume), Postgres (`pg_dump`), the media store (Drive is its own backup; the local
  directory), restoring each (`load-sql`, `import`, the volume), what isn't in a backup (secrets).
- `faq.md` (FAQ and troubleshooting): a post that didn't go out (not approved, on hold, paused, failed job, the
  catch-up window), expired or revoked tokens (Instagram renewals, the YouTube refresh token, the Google app in
  testing mode: 7 days), Instagram rate limits and errors (the 100-posts cap, media that isn't public, the
  container that never finishes), YouTube quota, missing media (Drive paths, the local store), time zone surprises
  (the workspace's zone vs yours, `due` vs `due_at`), the app says it's behind (the version check), passkeys on a
  new phone, "SETUP_TOKEN isn't set".

Today's `self-hosting.md` "Updating" and "Backups" paragraphs and `deploy-cloudflare.md`'s link to the new pages
instead of repeating them.

## #81 The README

Rewritten in the brand voice: the banner; one paragraph on what it is; three screenshots (`today`, `item`,
`overview`) with `<picture>` light/dark; "What it does" (a feature list: Instagram Reels, posts, carousels,
Stories, Trial Reels; YouTube Shorts comments and release dates; approval with a passkey; agents through MCP and
REST that never publish; the dashboard; Cloudflare or Docker; SQLite, D1 or Postgres; Drive or a local directory;
branding; notifications; results and comments); "How it compares" (by category: hosted schedulers, self-hosted
open-source schedulers, and Bongsu's three differences: your own accounts and apps on your own infrastructure,
nothing goes out without your passkey, agents can plan but never publish); "Quick start" for Cloudflare and for
Docker (five lines each, linking the guides); "Docs" (the site's `/docs/`); "Contributing" and "License". The
stale "Postgres on the roadmap" lines go (and the landing page's "Docker and Postgres support are on the
roadmap" line, the one landing-page change allowed here, noted on #81).

## #130's leftover

`instagram-graph.md` and `youtube.md` get the console steps as numbered lists with image placeholders
(`assets/meta/<n>-<step>.png`, `assets/google/<n>-<step>.png`) and a comment line `<!-- screenshot: … -->` saying
what each shows; the owner takes them from their console (they can't be scripted); the guides read fine without
them.

## Docs and bookkeeping

- `nav.json`: Use Bongsu (the-app, captions-and-checks, the-dashboard), Agents (connect-claude,
  what-agents-can-do, api-reference, cli), Reference gains updating, backups, faq after platform-terms;
  `site/docs/README.md` rows.
- `docs/PLAN.md`: tick #131, #132, #133, #81 and the README box; #130 stays open until the console screenshots are
  in. Changeset: none (docs only; the dashboard bundles the new guides but that's content).
- One merge request, `docs(docs): the user guides, the agent guides, running an instance, the README`, closing
  #131, #132, #133, #81, `Refs #130`.

## Out of scope

Search on the docs site. The dashboard's own screenshots inside the dashboard. Localised guides. The console
screenshots themselves (the owner's). Any change to the apps' behaviour: a guide that finds a bug files an issue.
