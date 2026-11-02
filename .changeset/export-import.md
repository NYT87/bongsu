---
"@bongsu/schema": minor
"@bongsu/node": minor
---

Moving an instance between databases: `node server.mjs export <file>` writes every table to neutral JSON, `import
<file>` loads it into a fresh SQLite or Postgres database (all or nothing, same schema version only), and `load-sql
<dump>` turns a `wrangler d1 export` into a SQLite file to export from. Walkthroughs for SQLite → Postgres and D1 →
Postgres in docs/databases.md.
