---
title: "Security review fixes: approvals bound to accounts, the plan rechecked before publishing, workspace and role gates"
author: NYT87
date: 2026-10-29
branch: main
cost: { minutes: 1, tokens: 0 }
touches:
  - packages/core/src/tick.ts
  - packages/api/src/pwa/approve.ts
  - packages/api/src/pwa/routes.ts
  - packages/api/src/dashboard/routes.ts
  - packages/api/src/agent/ops.ts
  - packages/core/src/comments.ts
  - packages/core/src/connections.ts
  - packages/schema/src/migrations/0010_approval_account.ts
  - apps/node/src/local-store.ts
  - apps/cloudflare/test/security.test.ts
---

## Decided

- An approval names its account (`approvals.account`, migration 0010 backfilled from `plan_items`). `verdict()` in `packages/core/src/tick.ts` refuses when the approval's account differs from the item's username: moving an item to another account needs a new approval, like any text change.
- A YouTube Shorts comment is approved like any other text: approval key `comment:<video id>`, `due_at` 0, approved from the Short's page in the PWA (`resolveShort` in `packages/api/src/pwa/approve.ts`, `ShortComment` in `packages/web/src/App.tsx`). `shorts_add` only lists it. A refused Shorts job is reopened by the tick once an approval appears.
- Before any outside write on a job created on an earlier run, `recheck()` in `tick.ts` asks the plan again (item still there, same `due_at`, same account, not on hold, account enabled) and `settle()` applies the answer. A hold moves the job to the `held` state (payload `onHold: true`) so it frees one of the four active slots; `discover()` reopens it when the item is released. Removing, rescheduling or disabling refuses the job.
- The self-comment and second comment are hashed again right before posting (`postComment()`); a mismatch skips the comment and notes it on the job.
- Dry run is checked inside `publish()` and `stepTrialPending`, not only at job creation, so a job already under way stays unpublished.
- Comments, comment polls and trial posts carry `workspace_id`; the comments API and `replyToComment()` filter by the caller's workspace. Account ids are unique across the instance (`saveGrant` checks `SELECT id FROM accounts` without a workspace filter).
- PWA scopes come from the member's role (`userRole()` + `ROLE_SCOPES`); the dashboard needs owner or admin for keys, accounts, connections, OAuth apps and settings. The full role matrix and members UI stay in Phase 13.

## Tried and ruled out

- `json_each` for the Shorts known-jobs query: SQLite only, `packages/core/test/portable-sql.test.ts` fails on it. Use `jsonList()` from `packages/core/src/sql.ts`.
- Keeping a held job in `container_created` and skipping it each tick: four held containers then occupy every slot and the next due post never advances. The `held` state is the fix.
- Hand-writing `migrations/sqlite/0010_*.sql`: migrations after 0009 are generated. Add the step in `packages/schema/src/migrations/`, register it in `index.ts`, run `pnpm --filter @bongsu/schema generate` (also updates `docs/schema.md` and `schema.json`).
- In `apps/node/src/local-store.ts`, calling `realpath(root)` before the lexical check made `resolve("../x")` return null instead of throwing: do `abs()` first, then the realpath containment check.

## Watch out

- The git hooks (lefthook: biome, commitlint) need pnpm on PATH. Load nvm and `nvm use 22` (and export the Node 22 bin dir) before committing, or the pre-commit hook fails with "pnpm: not found". Never bypass the hooks.
- PWA tests that hit `/app-api/approve` need a `passkeys` row for the credential the fake assertion uses, or they get 401.
- `accounts` has `UNIQUE(workspace_id, platform, handle)`: a test that creates an account in another workspace must delete it, or the next `beforeEach` that resets workspace ids collides.
- Shorts comments already listed before this change (including texts an importer copied from a repo) now wait for an approval in the app; their operators must approve them once.
- The repro tests of an external review assert the old behaviour: run the suite with them excluded, then delete them.

Refs #135, MR !8, commits 3721249, deaf80b.
