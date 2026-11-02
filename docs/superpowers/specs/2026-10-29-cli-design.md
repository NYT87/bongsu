# The `bongsu` CLI (Phase 6): design

Phase 6 of `docs/PLAN.md` (#72, #73, #74, #16). A command line for what is better scripted than clicked: approving
from a computer, copying texts, reading the plan, exporting it, deploying the Cloudflare secrets, bridging MCP clients
that only speak stdio, and printing the schema. Setup, connections, devices and keys stay in the dashboard.

## Principles kept

- **Approval stays human.** The CLI approves with a CLI token, which the dashboard only gives after a fresh passkey
  check and which carries its person's role. Agent keys can never reach the approve routes, whatever their scopes.
- **HTTP only.** The CLI talks to the instance's API (`/v1`, `/mcp`) and never to a database, so it works with the
  Cloudflare and the Node runtime alike.
- **No new runtime dependency.** Node 22's `parseArgs`, `fetch`, `readline` and webcrypto; bundled by esbuild into one
  file, like `apps/node`.

## Package

`packages/cli`: npm name `bongsu`, `bin: { bongsu: "dist/cli.mjs" }`, private until Phase 10 publishes it. `src/`:

| File | What |
|---|---|
| `main.ts` | entry: parses the global options and dispatches to a command |
| `config.ts` | the profiles file |
| `client.ts` | `Api` (base URL, token, `fetch`): `get`, `post`; turns `{ error }` answers into `CliError` |
| `output.ts` | tables for terminals, JSON with `--json`, CSV |
| `commands/*.ts` | one file per command |

Everything that touches the network takes `fetch` as a parameter; everything that prints takes a writer. Tests inject
both.

## Global options

`--workspace <name>` (profile), `--json`, `--help`, `--version`. `BONGSU_URL` and `BONGSU_TOKEN` override the profile
file (for scripts and CI).

## `login`

`bongsu login --url <PUBLIC_URL> [--token <bongsu_cli_…>] [--workspace <name>]`. Without `--token`, the token is
prompted with echo off. The CLI calls `GET /v1/status` with it; on 401 it fails and saves nothing. Saved to
`$XDG_CONFIG_HOME/bongsu/cli.json` (default `~/.config/bongsu/cli.json`), created with mode 0600 (the folder 0700):

```json
{ "default": "travel", "profiles": { "travel": { "url": "https://…", "token": "bongsu_cli_…" } } }
```

The profile name defaults to the URL's hostname; the last login becomes the default. `bongsu logout [--workspace]`
removes a profile.

## Commands over the existing API

| Command | Calls | Output |
|---|---|---|
| `status` | `GET /v1/status` | paused?, next due, counts |
| `queue [--days n] [--account id]` | `GET /v1/queue` | one row per item: due, account, key, state |
| `texts get <key>` | `GET /v1/items/<key>` | caption, comment, comment2, alt (sections; `--json` the object) |
| `texts set <key> --caption f --comment f --comment2 f --alt f` | `POST /v1/plan/update` | the updated item |

`texts set` reads each given file (`-` = stdin, once) and sends only the texts given. Keys are the API's:
`reel:<project>/<base>`, `post:<project>/<dir>`.

## `approve <key> [--yes]`

Two new REST routes in `packages/api/src/agent/routes.ts`, registered beside the tool routes but **not in the tools
registry** (`tools.ts`), so MCP never lists them and an agent never sees them:

- `GET /v1/approve/:key`: `resolveItem()` (`pwa/approve.ts`) for the caller's workspace and zone, answering what the
  app shows before approving: account, due, caption, comment, comment2, alt, media (name, checksum), problems, lint,
  the current approval and the `snapshot`. 404 when it isn't the workspace's; 409 with `problems` when it can't be
  approved.
- `POST /v1/approve` `{ key, snapshot }`: resolves again; 409 `changed: true` when the snapshot differs (nothing is
  approved unseen); else `writeApproval()` with `approvedBy: "owner@cli"` and the caller's user id, an `approve` audit
  row naming the token, and the answer `{ approved: true, key, due }`.

Both require the `approve` scope **and** `caller.userId` (a CLI token). An agent key is refused with 403 even if a
row gave it `approve` in `scopes`: `authenticate()` already drops to the role's scopes for a CLI token and keeps the
row's scopes for a key, and the route checks `userId` too. The same key forms as the app: items and Shorts comments
(`comment:<video id>`), so the plan's `--comments` flag isn't needed.

The CLI prints the summary (account, due in the caller's zone, caption, comments, media list, lint warnings), asks
`approve? [y/N]` unless `--yes` (or not a TTY, where `--yes` is required), then posts the snapshot it was shown.

## `export --format json|csv [--texts]`

New `GET /v1/export[?texts=1]` (scope `read`), one row per plan item of the caller's workspace, past and future, in
`due_at` order:

`key, account, platform, format, due, due_at, hold, approved (bool), approval_matches (bool), approved_at, posted_media_id,
posted_permalink, published_at, note`; with `texts=1` also `caption, comment, comment2, alt`.

The CLI writes JSON (an array) or CSV (RFC 4180 quoting, header row, booleans `true`/`false`, missing values empty)
to stdout. Replaces file mirrors of the plan (plan 2.6).

## `deploy-secrets [--config-dir apps/cloudflare] [--rotate] [--only A,B]`

For the Cloudflare path. Generates `SETUP_TOKEN` (base64url, 24 bytes), `ENCRYPTION_KEY` and `MEDIA_SIGNING_KEY`
(hex, 32 bytes) and a VAPID pair (ECDSA P-256 through webcrypto; public key = raw point, private = `d`, both
base64url, the format `web-push` uses). Then, for `wrangler.toml` and `wrangler.cron.toml`, runs
`wrangler secret put <NAME> --config <file>` with the value on stdin (`npx wrangler`, found through the package's
own bin) for `SETUP_TOKEN`, `ENCRYPTION_KEY`, `MEDIA_SIGNING_KEY`, `VAPID_PRIVATE_KEY`. Names already present in
`wrangler secret list` are skipped unless `--rotate`. Prints the names set and, once, the VAPID public key to put in
both configs' `[vars] VAPID_PUBLIC_KEY`. Values are never printed or written to disk. `apps/cloudflare/setup-secrets.sh`
is removed: its other secrets (Composio, YouTube OAuth, Drive) are dashboard connections now.

## `mcp`

A stdio bridge: each line on stdin is a JSON-RPC message, posted to `<url>/mcp` with the bearer token; the response
body is written as one line to stdout. Notifications (no `id`) get no line. A transport error becomes a JSON-RPC error
answer with the request's id. For clients without remote HTTP support: `claude mcp add bongsu -- npx bongsu mcp`.

## `schema --dialect sqlite|postgres`

Prints `sqliteSchema()` or `postgresSchema()` from `@bongsu/schema` (bundled in), the full DDL for a fresh database.

## Wording (#73, #16)

Every the old scripts hint in `packages/core`, `packages/api`, `packages/web` and the tests becomes app or CLI
wording: "no caption in the scheduler: add one in the app or with `bongsu texts set <key>`"; comments likewise. The
comments that explain history keep a short "(an importer copied them)" where the `files` field needs explaining. Build
outputs under `packages/web/dist` and `.wrangler/` are regenerated, not edited.

## Tests

- `apps/cloudflare/test/cli-api.test.ts`: `GET/POST /v1/approve` with an owner's CLI token (approval written, the
  tick then publishes), an approver's token (allowed), a viewer's and an editor's token (403), an agent key with every
  scope including a forged `approve` (403: #74), a changed caption between GET and POST (409), a Shorts comment key,
  another workspace's key (404); `GET /v1/export` rows and the `texts` flag.
- `apps/cloudflare/test/workspaces.test.ts`: `/v1/export` and `/v1/approve` only see the caller's workspace.
- `packages/cli/test` (vitest on Node, fake `fetch` and writer): config file created 0600 and env override; `login`
  refuses a bad token; `queue` table and `--json`; `texts set` from files and stdin; `approve` summary, the prompt's
  no, `--yes`, 409 message; `export` CSV quoting; `mcp` bridge round trip and notification; `deploy-secrets` with a
  fake `wrangler` on PATH (names, skip, rotate, never the values); `schema` prints both dialects.

## Docs and bookkeeping

- `docs/cli.md` (new): install, login, each command, scripting examples; linked from `docs/README.md`.
- `docs/agents.md`: the approve and export routes (CLI tokens only / read), the stdio bridge.
- `docs/deploy-cloudflare.md`: `bongsu deploy-secrets` instead of the script; `docs/databases.md`: `bongsu schema`.
- `docs/PLAN.md`: tick Phase 6; a changeset (`bongsu` minor, `@bongsu/api` minor).
- Commits reference #72 (CLI), #73/#16 (wording), #74 (test); the merge request closes them.

## Out of scope

Publishing to npm and the `npx bongsu` smoke test on a public registry (Phase 10); OS keychain storage; `pause` and
`resume` commands (not in the plan; `resume` can come later with the same CLI-token-only pattern as approve).
