---
"bongsu": minor
"@bongsu/api": minor
---

The `bongsu` command line (`npx bongsu`): `login` with a CLI token, `status`, `queue`, `texts get|set`, `approve`
(shows what you approve first; only owner, admin and approver tokens can), `export --format json|csv`, `mcp` (a stdio
bridge to `/mcp`), `schema --dialect sqlite|postgres` and `deploy-secrets`, which replaces `setup-secrets.sh`. The API
gets two REST-only routes for it, `GET /v1/approve/<key>` with `POST /v1/approve`, and `GET /v1/export`; agent keys
still can't approve. Messages and the app point to the app or the CLI.
