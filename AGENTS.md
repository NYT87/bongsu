# Bongsu: instructions for agents

Bongsu is a self-hosted publishing scheduler: Instagram Reels, posts, carousels, stories and Trial Reels, plus YouTube
Shorts comments, posted on time after the owner approves them with a passkey. Read `README.md` for the product,
`docs/` for how it works and `docs/PLAN.md` for the roadmap (tick its boxes as work gets done).

## Layout

| Path | What |
|---|---|
| `packages/core` | Runtime-independent logic: plan, jobs (`tick.ts`), approvals, texts, notifications, clients, formats. The database is the `Db` port (`db.ts`) |
| `packages/api` | The Hono app, `createApp(fetcher)`: `agent/` (REST `/v1` + MCP `/mcp`), `pwa/` (`/app-api` for the PWA), `/m` media links, `/health` |
| `packages/web` | The PWA (React + Vite). `PRODUCT.md` and `DESIGN.md` describe it; follow them for UI work |
| `packages/cli` | The `bongsu` command (`login`, `queue`, `texts`, `approve`, `export`, `mcp`, `schema`, `deploy-secrets`): talks to `/v1` over HTTP only, bundled with esbuild; `site/docs/cli.md` |
| `apps/cloudflare` | The two Workers (`src/index.ts`, `src/cron.ts`), wrangler configs, integration tests (`test/`, fake world in `test/world.ts`) |
| `apps/node` | The same app on Node (`src/main.ts`): the better-sqlite3 `Db` adapter, migrations, node-cron, static files, the `local` media store and `smtp` mailer; bundled with esbuild for the `Dockerfile` |
| `packages/schema` | The neutral schema (`src/migrations/`): every table once, with the SQL for each database generated from it (`pnpm --filter @bongsu/schema generate`); `docs/schema.md` is the readable version |
| `migrations/` | Generated and historical SQL per database: `sqlite/` (D1 and Node; 0001–0009 hand-written, later ones generated), `postgres/` (generated) |
| `site/docs/` | The public guides, built into the site and the dashboard (`nav.json` orders them) |
| `docs/` | Internal documentation. Keep it current when behaviour changes |
| `.trail/learnings/` | What earlier coding sessions worked out about this code (decisions, what was ruled out, what to watch out for), one Markdown file each, from [Trail-code](https://github.com/trailhq/Trail-Code). Read the ones about the code you're changing before exploring it. `trail` (and its MCP server in `.mcp.json`) also answers "where is X and what calls it"; its map lives in the git-ignored `graft/` |
| `site/` | The project's landing page: static HTML and CSS, no build step and no API calls. `scripts/build-site.sh` (`pnpm site`) assembles it with the brand files into `public/`; `.github/workflows/pages.yml` publishes it on GitHub Pages from `main` |

Dependencies point one way: `apps/*` → `api` → `core`. Packages import each other by path (`@bongsu/core/tick`).

## Commands

Node 22, pnpm (`corepack enable`). From the root:

```sh
pnpm install          # also installs the git hooks
pnpm check            # Biome: formatting + lint (pnpm fix applies fixes)
pnpm typecheck
pnpm test             # core unit tests + Cloudflare integration tests
pnpm build            # the PWA
```

On a loaded machine: `pnpm --filter @bongsu/cloudflare exec vitest run --testTimeout 120000 --maxWorkers=2`.

Before finishing a change: `pnpm check && pnpm typecheck && pnpm test` pass.

## Rules

- **Approval stays human.** Nothing may let an agent key approve, resume or publish. Approvals hash the texts and media;
  any change needs a new approval. Keep it that way, with tests.
- **`core` and `api` stay runtime-independent.** No Cloudflare or Node types or imports there (their tsconfigs only load
  web-standard libraries). The database goes through `Db`; fetch and the clock are passed in.
- **Workspaces.** Every row of plan data has a `workspace_id`. Code acting for a caller filters by the caller's
  workspace (`c.caller.workspaceId`; `getItem(db, key, workspaceId)`) and writes it on inserts; only the scheduler's
  own runs see every workspace. `apps/cloudflare/test/workspaces.test.ts` checks the isolation: extend it with new
  routes.
- **Times in UTC.** The database stores instants as unix seconds; time zones only apply at the edges. Input and
  output use the caller's zone (`zoneOf(c)`: the user's own, else the workspace's): read requests with `dueFrom`
  (`at` with its zone, or `date`/`time` on the caller's clock), answer with both the local `due` and the UTC `due_at`.
  Use `formats/time.ts` (`zoneToUnix`, `zoneStamp`, `utcIso`…); never store wall time or add fixed offsets.
- **Portable SQL.** New queries stay in the subset SQLite and Postgres share (`ON CONFLICT … DO UPDATE`, `RETURNING`);
  no new SQLite-only functions (`unixepoch()`, `json_each`…); timestamps come from the app.
  `packages/core/test/portable-sql.test.ts` fails on new ones.
- **One source of truth.** The database holds the plan, texts, approvals, accounts and settings; media stays in the
  media store. Don't add a second place for the same data.
- **No personal data or secrets.** No real handles, ids, captions, emails, URLs or keys in code, tests or docs: use the
  demo accounts (`demo_travel`, `demo_running`, …) and `example.com`. Secrets go through `wrangler secret put`, never in
  files. `pnpm check-personal` runs the owner's local list.
- **Tests with every change.** Unit tests in `packages/core/test`; anything touching the database, routes or the tick in
  `apps/cloudflare/test`, using the fake world instead of real services.
- **Match the surrounding code:** naming, comment density (comments explain why), small functions, no new dependency
  without a reason.

## Commits, changesets, formatting

- **Conventional Commits**, enforced by the commit-msg hook and CI (`commitlint.config.js`):
  `type(scope): summary` in the imperative, at most 100 characters. Types: `feat`, `fix`, `docs`, `refactor`, `perf`,
  `test`, `build`, `ci`, `chore`, `revert`, `style`. Scopes: `core`, `api`, `web`, `dashboard`, `cloudflare`, `node`,
  `cli`, `schema`, `providers`, `docs`, `ci`, `deps`, `release`, `repo` (several: `core,api`). Breaking change:
  `feat(api)!: …` plus a `BREAKING CHANGE:` footer.
- **GitHub is the source** (`github.com/NYT87/bongsu`): branches, pull requests, issues and releases live there.
  `main` takes only squash merges of pull requests (the ruleset), and `.github/workflows/mirror.yml` copies it to the
  private GitLab project, a backup that also keeps the history from before the public squash. Never push to GitLab.
- **Issues:** every roadmap task is a GitHub issue (milestone = phase, label `phase-<n>`, `needs-owner` when it waits
  for the owner). Reference it in the commit body (`Refs #36`) and close it from the pull request description
  (`Closes #36`); tick the matching box in `docs/PLAN.md` too. Issue numbers before the move are GitLab's.
- **Pull request titles follow the same rule** (`feat(core,api): …`): CI lints the title too, since it becomes the
  squashed commit's message.
- **Changesets:** a change users would notice gets one (`pnpm changeset`, committed with the change). Docs-only, test-only
  and CI-only changes don't need one.
- **Formatting:** Biome (`biome.json`): 2 spaces, double quotes, semicolons, trailing commas, 120 columns. The
  pre-commit hook formats staged files; CI runs `biome ci`. Don't hand-format against it.
- Don't skip hooks (`--no-verify`, `LEFTHOOK=0`) to get a commit through; fix the cause.
- Commit or push only when asked.
