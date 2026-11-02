# The command line

`bongsu` is for what is better scripted than clicked: checking the queue, reading and setting texts, approving from a
terminal, exporting the plan, and generating the Cloudflare secrets. Setup, connections, devices and keys stay in the
app and the dashboard. The CLI talks to the instance's HTTP API only (never to the database), so it works the same
against Cloudflare and Docker.

## Install

The package is not published to npm yet: build it once from a checkout of the repository (Node 22, pnpm):

```sh
pnpm --filter bongsu build
node packages/cli/dist/cli.mjs --help
```

The examples below call it `bongsu`; from the repository root, an alias makes that work:

```sh
alias bongsu="node $PWD/packages/cli/dist/cli.mjs"
```

Once the package is published, `npx bongsu` will work too, without the checkout.

## Log in

Make a CLI token in the app's **Keys & tokens** → **Your CLI tokens** (see [CLI tokens](api-reference.md#cli-tokens)), then:

```sh
bongsu login --url https://bongsu.example.com
# CLI token: (typed without echo)
```

`--token bongsu_cli_…` also works, but then the token sits in your shell history: prefer the prompt. The token is
checked against the instance before anything is saved, so a typo never becomes the default.

Profiles live in `~/.config/bongsu/cli.json` (`$XDG_CONFIG_HOME/bongsu/cli.json`), a file only you can read (mode
0600; the directory 0700). There is no keychain integration: the file holds the tokens. A profile is named after the
instance's host name; `--workspace <name>` at login names it yourself. The last login becomes the default, and
`--workspace <name>` on any command picks another profile:

```sh
bongsu --workspace demo status
bongsu logout                     # forgets the default profile (or --workspace <name>)
```

### Scripts and CI

When both `BONGSU_URL` and `BONGSU_TOKEN` are set they take the place of the profile, so a pipeline needs no file:

```sh
BONGSU_URL=https://bongsu.example.com BONGSU_TOKEN=bongsu_cli_… bongsu export --format csv > plan.csv
```

## Commands

Global options go before or after the command: `--workspace <name>`, `--json` (print the API's answer as JSON; for
`queue`, `status`, `texts`, `approve`, `stats` and `ingest`), `--help`, `--version`. Exit codes: 0 done; 2 an unknown command or
option; 1 a command the CLI refuses or that fails (the reason is on stderr).

| Command | What it does |
|---|---|
| `login --url <url> [--token t]` | Saves a CLI token as a profile |
| `logout` | Forgets a profile |
| `status` | Paused or not, dry run, today, accounts, jobs of the last 7 days |
| `queue [--days n] [--account id]` | What is due next and whether it is approved |
| `texts get <key>` | Prints caption, comment, comment2 and alt |
| `texts set <key> [--caption f] [--comment f] [--comment2 f] [--alt f]` | Sets texts from files (`-` is stdin) |
| `approve <key> [--yes]` | Shows what you are approving, then approves |
| `stats <key> \| --account id [--daily] [--from d] [--to d]` | A post's metrics series, or an account's followers and views per day |
| `ingest <file.json \| ->` | Uploads metrics samples collected elsewhere (needs the `metrics` scope) |
| `export [--format json\|csv] [--texts]` | Every plan item, to stdout |
| `mcp` | A stdio bridge to `/mcp` for MCP clients without HTTP |
| `schema --dialect sqlite\|postgres` | The DDL for a fresh database |
| `deploy-secrets` | Generates and sets the Cloudflare secrets |

### status and queue

```sh
bongsu status
bongsu queue --days 3 --account demo_travel
```

`queue` prints `due`, `account`, `key` and `state`: `not approved`, `approved`, `approved (time changed)` (approved
for another time: approve it again) or `held`. Without items it says `nothing due until <date>`.

### texts

```sh
bongsu texts get reel:demo/first_reel
bongsu texts set reel:demo/first_reel --caption caption.txt --alt alt.txt
echo "Link in bio" | bongsu texts set reel:demo/first_reel --comment -
```

At least one field is needed, and `-` (stdin) may be used once per command. Approvals hash the texts, so an existing
approval stops matching after a change: approve again.

### approve

```sh
bongsu approve reel:demo/first_reel
bongsu approve comment:demo_video_id --yes
```

Item keys look like `reel:demo/first_reel`; a Shorts comment is `comment:<video id>` (this is also how you approve
comments: there is no separate `--comments` flag). The command prints the texts, the media names with their
checksums and the lint checks that didn't pass, then asks `approve? [y/N]`. `--yes` skips the question; without a
terminal `--yes` is required. With `--json` the summary goes to stderr and the answer to stdout.

Only a CLI token of an owner, admin or approver can approve, and only exactly what it was shown: if the texts, media
or time change between the summary and the approval, the instance refuses (409) and you look again. If the item
isn't ready (a check fails, no media), the problems are listed. An agent key can never approve, whatever its scopes.

### stats and ingest

```sh
bongsu stats 'reel:20261020_LISBON/tram' --daily --from 2026-10-20
bongsu stats --account demo_travel --from 2026-10-01 --to 2026-10-31
bongsu ingest samples.json
```

`stats` prints the series as a table (times in UTC); `--json` prints the API's answer. `ingest` sends a file shaped
like [`ingest_metrics`](api-reference.md#stats) takes and says how many samples were added and how many were already
there; a CLI token of an owner or admin has the `metrics` scope.

### export

```sh
bongsu export --format csv --texts > plan.csv
bongsu export --format json | jq -r '.[] | select(.approved | not) | .key'
```

JSON is the default and prints an array of items; CSV has one row per item. `--texts` adds caption, comment,
comment2 and alt. `alt` is one line per entry: an array in JSON, newline-joined in CSV and in `texts get`.
This is a plan export for scripts, not a database backup (for that, see [Databases](../../docs/databases.md)).

### mcp

```sh
claude mcp add bongsu -- node "$PWD/packages/cli/dist/cli.mjs" mcp
```

Run it from the repository root: Claude starts the bridge from elsewhere, so it needs the absolute path (an alias
doesn't reach it). Once the package is published, `npx bongsu mcp` will do. Run `bongsu login` first. See
[Agents](api-reference.md#mcp).

### schema

```sh
bongsu schema --dialect postgres | psql "$DATABASE_URL"
```

### deploy-secrets

`bongsu deploy-secrets [--config-dir <dir>] [--rotate] [--only A,B]` generates the secrets and sets them in both
Workers with `wrangler`. When it generates `SETUP_TOKEN` it prints it once, since the dashboard's first sign-up asks
for it; a `SETUP_TOKEN` already set in both Workers is kept and not printed. The other secrets are never printed. It
is explained in [Deploy on Cloudflare](deploy-cloudflare.md), section 6.

## What a token can do

| Token | Can |
|---|---|
| CLI token, owner or admin | Read, edit plans and texts, approve, plus draft, pause and resume in the API |
| CLI token, approver | Read and approve |
| CLI token, editor | Read, draft and plan: can `texts set`, cannot approve |
| CLI token, viewer | Read only |
| Agent key | Only its scopes; never `approve` |

`status`, `queue`, `texts get` and `export` need the `read` scope; `texts set` needs `plan`. A CLI token acts as its
person, with their role's rights, read on every request.
