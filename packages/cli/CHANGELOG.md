# bongsu

## 0.2.0

### Minor Changes

- 839cc12: Stats for agents. Three read tools, MCP and REST at once: `get_metrics` (a post's or video's series with its 24 h
  numbers), `get_account_metrics` (an account's followers and views per day) and `list_performance` (the posts and videos
  of a window, ranked by any count). `ingest_metrics` (`POST /v1/metrics`) uploads samples collected elsewhere into the
  same series, behind a new `metrics` scope: opt-in on an agent key, part of the owner's and admin's rights. The CLI gains
  `bongsu stats` and `bongsu ingest`. Migration 0014 drops the unused `labels` and `manual_stats` tables: an instance that
  imported data from an earlier deployment loses what they held, so take a backup first if you want it.
- 839cc12: The `bongsu` command line (`npx bongsu`): `login` with a CLI token, `status`, `queue`, `texts get|set`, `approve`
  (shows what you approve first; only owner, admin and approver tokens can), `export --format json|csv`, `mcp` (a stdio
  bridge to `/mcp`), `schema --dialect sqlite|postgres` and `deploy-secrets`, which replaces `setup-secrets.sh`. The API
  gets two REST-only routes for it, `GET /v1/approve/<key>` with `POST /v1/approve`, and `GET /v1/export`; agent keys
  still can't approve. Messages and the app point to the app or the CLI.

### Patch Changes

- 839cc12: `bongsu deploy-secrets` prints the `SETUP_TOKEN` it generates, once, since the dashboard's first sign-up asks for it;
  a token already set is kept and not printed. The other secrets are still never printed.
