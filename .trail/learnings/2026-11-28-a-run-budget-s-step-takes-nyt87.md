---
title: "A run budget's step takes the calls kept back for later steps, not the step's own share"
author: NYT87
date: 2026-11-28
branch: fix/audit-bugs
cost: { minutes: 105, tokens: 342097 }
id: l-20e86029
scope: repo
status: active
src: agent
touches:
  - ".changeset/local-store-shared.md"
  - apps/node/src/local-store.ts
  - apps/node/src/main.ts
  - apps/node/test/node.test.ts
  - ".changeset/replica-keeps-locks.md"
  - apps/node/src/schedules.ts
  - ".changeset/last-admin-postgres.md"
  - apps/node/test/postgres.test.ts
  - packages/core/src/invites.ts
  - packages/core/src/people.ts
---

## Decided
In tests, give a step all of a run's calls with `runBudget(limit, fetch).step(name, 0)`. The second argument is how many calls stay reserved for the steps after it, not how many this step may use.
The last-admin fix (#171) locks the workspace row (or the instance admins' rows) in the same batch, and so the same transaction, as the change. Its PGlite test only checks that the rule still holds through that path. The race itself is argued in the commit, not reproduced.

## Tried and ruled out
`runBudget(12, fetch).step("inbox", 12)`, meant as "12 calls for the inbox": it reserved all 12, so the inbox reported "out of calls for this run before any workspace" and the test failed for a reason unrelated to the fix.
Two removals at once with Promise.allSettled on PGlite as proof: PGlite runs one statement at a time, so the second always sees the first and the test passes with or without the fix.

## Watch out
A budget test that drafts or posts nothing may be failing on this, not on the code under test. Print the run's answer (its `note`) before changing anything.

In the code: packages/core/src/budget.ts (runBudget, step); apps/cloudflare/test/inbox.test.ts (the busy-inbox test); apps/cloudflare/test/inbox.test.ts cleanMedia test uses `step("cleanup", 50 - 6 - share)`.
A concurrency test on PGlite (or D1) that passes proves nothing about Postgres under READ COMMITTED. Showing the race needs a real Postgres server with two connections.

In the code: packages/core/src/invites.ts (asOnlyChange, keepsAdmin); packages/core/src/people.ts (setInstanceAdmin); apps/node/test/postgres.test.ts.
