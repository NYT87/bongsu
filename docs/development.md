# Development

Node 22 and pnpm (`corepack enable`). One workspace:

```
packages/
  core/        domain logic: plan, jobs (tick), approvals, texts, notifications, clients (Composio, Google, Drive,
               YouTube), formats (caption lint, time). Web-standard APIs only; the database is the `Db` port (db.ts)
  api/         the HTTP app (Hono): createApp() with /health, /m (media links), agent/ (REST /v1 + MCP /mcp),
               pwa/ (the PWA's API: passkeys, sessions, approval, schedule, uploads, stats)
  web/         the owner PWA (React + Vite); PRODUCT.md and DESIGN.md describe it
  cli/         the `bongsu` command: HTTP client of /v1, bundled with esbuild; site/docs/cli.md
apps/
  cloudflare/  the two Workers (src/index.ts, src/cron.ts), wrangler configs, integration tests
migrations/    the SQL per database: sqlite/ (D1, Node), postgres/; from packages/schema
docs/          documentation
scripts/       maintenance scripts
```

Dependencies point one way: `apps/*` → `api` → `core`. `core` and `api` don't use Cloudflare or Node types (their
tsconfigs only load the web-standard libraries), so another runtime only has to provide a `Db`, a fetch and a clock.

Packages import each other by path: `import { tick } from "@bongsu/core/tick"`. There is no build step for them; the
runtime's bundler (wrangler/esbuild, vite) compiles the TypeScript sources.

## Commands

From the root:

```sh
pnpm install
pnpm typecheck     # every package
pnpm test          # core's unit tests + the Cloudflare integration tests
pnpm build         # the PWA
```

One package: `pnpm --filter @bongsu/core test`. On a busy machine run the Cloudflare tests with
`pnpm --filter @bongsu/cloudflare exec vitest run --testTimeout 120000 --maxWorkers=2`.

## Tests

- `packages/core/test/`: plain vitest, no runtime (formats, caption lint with synthetic captions).
- `apps/cloudflare/test/`: vitest in the Workers runtime (Miniflare) with a local D1 that has the migrations applied.
  `world.ts` fakes Composio/Instagram, Drive, Google tokens and YouTube behind one fetch.
- `apps/node/test/`: plain vitest on Node: the Db conformance cases on better-sqlite3 (the same ones D1 runs in
  `apps/cloudflare/test/db-conformance.test.ts`), the migrations, the local media store, static files, `/health`, the
  schedules, backups and the SMTP mailer.

## Local testing

A Bongsu on your machine, with a local database, demo accounts and nothing real behind them. It never touches a remote
database or a real account.

### 1. Seed

```sh
scripts/dev-seed.sh --tz Asia/Seoul     # any IANA zone; default UTC
```

It applies the migrations to the local D1 (`apps/cloudflare/.wrangler/`), adds two Instagram demo accounts
(`demo_travel`, `demo_running`) with fake ids, sets the workspace's time zone, and prints an **agent key** and a
one-time **setup code** for the app's first passkey (valid 15 minutes). The first run also writes
`apps/cloudflare/.dev.vars` (git-ignored): `PUBLIC_URL=http://localhost:8787`, `RP_ID=localhost` (passkeys are tied to
the hostname) and `DRY_RUN=1`. Run it again whenever you like: the demo rows are replaced, the previous dev key is
revoked and a new key and code are printed.

### 2. Run

```sh
pnpm build                                # the app; the Worker serves it
pnpm --filter @bongsu/cloudflare dev      # http://localhost:8787
```

### 3. Try the agent API

```sh
export KEY=bongsu_…                       # from dev-seed
H="Authorization: Bearer $KEY"
curl -s localhost:8787/v1/status   -H "$H"     # today, timezone, accounts
curl -s localhost:8787/v1/accounts -H "$H"
curl -s localhost:8787/v1/plan -H "$H" -H "Content-Type: application/json" \
  -d '{"format":"video","account":"demo_travel","folder":"demo/CONTENT/20261101_TEST","name":"short1","date":"2026-11-01","time":"18:00","caption":"Hi"}'
curl -s "localhost:8787/v1/queue?days=30" -H "$H"
```

Things worth checking:

- **Times:** the database stores UTC. `due` is on the workspace's clock (`2026-11-01 18:00 Asia/Seoul`), `due_at` is the
  same instant in UTC (`2026-11-01T09:00:00Z`). Plan with `"at": "2026-11-01T09:30:00Z"` instead of date/time and the
  hour clash names the 18:00 item. Re-seed with another `--tz`: the items keep their instant and show at a new time.
- **Accounts:** planning for an account that isn't in `accounts` is refused (400).
- **Workspaces:** a key with another `workspace_id` (`INSERT INTO api_keys … workspace_id`, see
  [the API reference](../site/docs/api-reference.md#api-keys)) sees none of the default workspace's items.
- **Approval stays human:** no key can approve; items show `approved: false` until the app approves them.

The same through MCP, from Claude Code:

```sh
claude mcp add --transport http bongsu-local http://localhost:8787/mcp --header "Authorization: Bearer $KEY"
```

Then ask it to `list_accounts`, `get_status` or plan something.

### 4. Try the app

Open http://localhost:8787, enter the setup code and create a passkey (browsers allow passkeys on `localhost`). The
calendar, the queue, an item's page and Settings → **Time zone** (your own zone; the plan doesn't move) all work.
Approving needs the item's media on Google Drive, so it fails locally with "not on Drive yet".

### Limits

- `/health` says `ok: false` locally: the Composio, Drive and signing secrets aren't set. Add them to
  `apps/cloudflare/.dev.vars` only if you want to try those parts, never real production keys.
- Nothing is published: the demo accounts have fake ids, and `DRY_RUN=1`.
- The cron Worker doesn't run under `pnpm dev`; the tick is covered by the tests (`apps/cloudflare/test/tick.test.ts`).
- Start over: `rm -rf apps/cloudflare/.wrangler/state` and seed again.
- Working on the app's UI with hot reload: `pnpm --filter @bongsu/web dev` next to the Worker (it proxies the API to
  `localhost:8787`). Sign in on http://localhost:8787 first: passkeys check the origin, and the session cookie then
  works on Vite's port too.

## The project site and the public docs

The user guides live in `site/docs/` (`nav.json` orders the sidebar, `README.md` is the index). `pnpm site` builds the
landing page and the docs into `public/` (one `index.html` per page under `public/docs/`); `pnpm test:site` tests the
renderer in `scripts/docs-lib.mjs`. There is no build step beyond Node: preview with `npx serve public` or any static
server.

## Screenshots

The screenshots in the public guides and the README come from a demo instance, not from a real account.
`pnpm screenshots` seeds one in `scripts/screenshots/.scratch/` (a fresh SQLite database made with the Node server's
own migrations, demo accounts, a week of plan items in every state, drafts, a Shorts comment, the demo media from
`scripts/screenshots/demo/`, and a signed-in session for the PWA and one for the dashboard), serves it on
`http://localhost:8787` with `DRY_RUN` on, takes the screenshots in the Playwright Docker image and stops the server.
`pnpm screenshots --keep` leaves the server running in the foreground to look at it: it prints the URL and the two
session cookies (`bongsu_session`, `bongsu_admin`) to set in the browser; Ctrl-C stops it.

The capture runs `docker run --rm --network host` with `mcr.microsoft.com/playwright:v1.57.0-noble` (pulled on first
use; it is large), so the container's `localhost:8787` is the demo server; it installs the matching `playwright`
package inside the container and writes the PNGs to `site/docs/assets/app/` (and the README's three to
`docs/assets/readme/`). When your shell's session lacks the `docker` group, the script runs the command through
`sg docker -c`. If `pngquant` is installed it shrinks the PNGs; each must stay under 600 KB.

It needs Docker and `ffmpeg` (only to remake `demo/reel.mp4`) on your machine, and builds `apps/node` (also when its
sources are newer) and `packages/web` (when `dist` is missing; the dashboard shots need it) first. It touches nothing but localhost and is not part of CI.
It doesn't build the dashboard: run `pnpm --filter @bongsu/dashboard build` before it. When the script builds
`packages/web` itself, or you rebuild it, the dashboard output (`packages/web/dist/dashboard`) is wiped and the
dashboard shots then show a sign-in screen: build the dashboard again after. The screens
are listed in `scripts/screenshots/screens.json`; `results` is a published Reel's Results view, its chart drawn from
the seeded metrics series of the Reel and its Trial Reel copy.
`pnpm test:site` tests the seed (`scripts/screenshots/seed.test.mjs`).

## Releases and changelogs

Versions and changelogs are managed with [Changesets](https://changesets.dev):

- Every change users would notice comes with a changeset: run `pnpm changeset`, pick the packages and the bump
  (patch, minor, major), write one or two lines, and commit the file it creates in `.changeset/` with the change.
- `@bongsu/core`, `@bongsu/api`, `@bongsu/web` and `@bongsu/cloudflare` share one version (the product); each has its
  own `CHANGELOG.md` listing its own changes. Packages published on their own later (the CLI) get their own version.
- **Releasing is manual for now** (versions matter once the app is ready; until then changesets just accumulate):

  ```sh
  pnpm changeset status          # what's pending
  pnpm version-packages          # bump versions, write the CHANGELOG.md entries, remove the applied changesets
  git commit -am "chore(release): version packages"
  pnpm changeset publish         # private packages: only creates the git tags (@bongsu/core@0.2.0, …)
  git push --follow-tags
  ```

- The GitLab CI jobs that automate this (`release`: a **Version Packages** merge request on `main` and the tags once
  it's merged; `changeset-comment`: a note on merge requests) are in `.gitlab-ci.yml` but dormant: they run only when a
  `GITLAB_TOKEN` CI/CD variable exists.

### On GitHub

The public repository releases with `.github/workflows/release.yml` (Changesets' GitHub action, the built-in
`GITHUB_TOKEN`), on every push to `main`:

1. With pending changesets it opens or updates the **Version Packages** pull request
   (`chore(release): version packages`): new versions, each package's `CHANGELOG.md`, the changesets removed.
2. Merging it runs `pnpm changeset publish`: a git tag and a GitHub release per new version; packages that aren't
   private (the CLI, `bongsu`) go to npm with provenance (`NPM_TOKEN`); when the product's version moved
   (`@bongsu/core` and its fixed group), the Docker image from the `Dockerfile` goes to
   `ghcr.io/<owner>/<repo>` as `<version>`, `<major>.<minor>` and `latest` (amd64 and arm64).

Pull requests opened with `GITHUB_TOKEN` don't trigger other workflows, so CI doesn't run on the Version Packages pull
request by itself: close and reopen it, or push to its branch. Dependabot (`.github/dependabot.yml`) opens grouped,
weekly updates for npm, the workflows' actions and the Docker base image.

## CI

`.gitlab-ci.yml` runs `biome ci`, `pnpm typecheck`, `pnpm test`, `pnpm test:site`, `pnpm site`, `pnpm build` and
commitlint on every push and merge request; the release jobs above stay dormant without a token. It never deploys.

`.github/workflows/` does the same on GitHub: `ci.yml` (the checks, and commitlint over the commits of a pull request
or push), `pr-title.yml` (commitlint over the pull request title, again when it's edited), `release.yml` (above) and
`pages.yml` (the site on GitHub Pages, like GitLab's `pages` job). At the move to GitHub, `.gitlab-ci.yml`,
`.gitlab/` (issue and merge request templates) and the `changesets-gitlab` dev dependency go.

## Code style and commits

- Biome formats and lints (`biome.json`); `pnpm check` checks, `pnpm fix` fixes. The pre-commit hook formats staged
  files.
- Commit messages follow Conventional Commits with the scopes in `commitlint.config.js`; the commit-msg hook and CI
  check them. Details and examples: [CONTRIBUTING.md](../CONTRIBUTING.md).
- The hooks (`lefthook.yml`) are installed by `pnpm install`; `pnpm exec lefthook install` reinstalls them.

## Before pushing

- `pnpm check-personal`: fails if any string from your local, git-ignored `.personal-strings` list (one regex per
  line: your handles, ids, domains) appears in tracked files.
- No secrets, ids or real captions in fixtures: tests use the demo accounts and synthetic texts.
