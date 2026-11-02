# Phase 9 part 3: stats for agents, a metrics ingest, the old tables dropped — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agents can read every series (item, account, a ranked overview) and upload samples collected elsewhere; the unused stats tables go.

**Architecture:** New entries in the tool registry (MCP + REST at once) over ops that reuse the app's metrics code; one write tool behind a new opt-in scope; one migration; two CLI commands.

**Tech Stack:** TypeScript, Hono, the neutral schema, vitest with the fake world, node:test-style CLI tests as the package has them.

**Spec:** `docs/superpowers/specs/2026-11-02-phase9-agent-stats-design.md`

## Global Constraints

- Scope `read` for the three read tools; `metrics` (opt-in on keys; owner and admin roles) for the ingest; nothing touches approval.
- The caller's workspace only; 404 for another workspace's item or account on reads, a row error on the ingest.
- Dates `YYYY-MM-DD` on the caller's clock, inclusive; ingest `at` ISO 8601 with a zone, not more than 5 minutes ahead.
- Caps: `list_performance` limit default 50, max 200; ingest 500 rows a call; points at most `METRICS_MAX_POINTS`.
- Portable SQL; Conventional Commits with `Refs #140`, `#87`, `#88`; trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. `GET /v1/items/<key>/metrics` with a key containing slashes reaches `get_metrics`, not `get_item` (route order test).
2. An ingest with one bad row among good ones writes nothing (atomicity test).
3. The same upload sent twice adds nothing the second time (idempotence test).
4. An agent key without `metrics` gets 403 on the ingest, and the tool isn't listed for it (scope test).
5. `list_performance` sorted by a metric some rows lack: those rows last, not first (sort test).

---

### Task 1: `get_metrics` and `get_account_metrics`
Files: `packages/api/src/agent/ops.ts` (`itemMetrics` gains `results`, `metrics` subset; `accountMetrics`), `tools.ts`, `routes.ts`; test `apps/cloudflare/test/agent-stats.test.ts`.
- [ ] Failing tests (MCP and REST for both; subset; daily with a null day; 404s; the slash key route). Implement. Commit `feat(api): get_metrics and get_account_metrics for agents`.

### Task 2: `list_performance`
Files: `ops.ts` (`performanceList`), `tools.ts`, `routes.ts`; the same test file.
- [ ] Failing tests (window, sort incl. nulls last, limit cap, Trial after Reel, account/platform filters). Implement. Commit `feat(api): list_performance ranks a workspace's posts and videos`.

### Task 3: `ingest_metrics` and the `metrics` scope
Files: `auth.ts` (Scope, ROLE_SCOPES), `ops.ts` (`ingestMetrics`), `tools.ts`, `routes.ts`, `packages/api/src/dashboard/routes.ts` (SCOPES), `packages/dashboard/src/pages.tsx` (the scope's line); tests in `agent-stats.test.ts`, `workspaces.test.ts`.
- [ ] Failing tests per the spec's ingest list. Implement. Commit `feat(api,dashboard): ingest_metrics uploads samples behind an opt-in scope`.

### Task 4: drop `labels` and `manual_stats`
Files: `packages/schema/src/migrations/0014_drop_labels_manual_stats.ts` (+ index, generate), schema tests, `docs/architecture.md`.
- [ ] Failing schema tests; implement; generate. Commit `feat(schema): drop the unused labels and manual_stats tables`.

### Task 5: `bongsu stats` and `bongsu ingest`
Files: `packages/cli/src/commands/stats.ts`, `ingest.ts`, the command index, `packages/cli/test/*`.
- [ ] Failing CLI tests; implement. Commit `feat(cli): bongsu stats and bongsu ingest`.

### Task 6: Docs, plan, changeset, full check
Files per the spec's Docs line; `.changeset/agent-stats.md`.
- [ ] Write; full verification (check, typecheck, generate no diff, core, schema, web, node, cli, Cloudflare full, test:site, site). Commit `docs(docs): tick #140, #87, #88: stats for agents, the ingest, the old tables`.
