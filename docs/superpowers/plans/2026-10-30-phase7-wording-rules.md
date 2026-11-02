# Phase 7 part 1 (notification templates, empty states, caption rules) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every notification's wording in one file, empty PWA screens that point to the setup and the guides, and caption lint rules an owner can set per account.

**Architecture:** A `Note` builder module in core replaces inline strings at 21 call sites with no wording change. `/app-api/me` reports the account count and the PWA renders one setup component from it. `lintCaption` takes a `LintRules` object the platform defaults and the account overrides; the dashboard edits it through the existing account PATCH.

**Tech Stack:** TypeScript, Hono, React (PWA and dashboard), vitest (core unit; Cloudflare Workers integration), Biome.

**Spec:** `docs/superpowers/specs/2026-10-30-phase7-wording-rules-design.md`

## Global Constraints

- Notification wording, targets and action buttons do not change: every existing title assertion (`tick.test.ts` "dry run: would publish", `inbox.test.ts` "3 new drafts from the inbox", `phase11.test.ts` "24 h results", "2 new comments") keeps passing unchanged.
- `core` and `api` stay runtime-independent; portable SQL; every query filters by workspace.
- Demo data only (`demo_travel`, `example.com`); Biome; Conventional Commits with `Refs #80` / `#78` / `#77` / `#79`; a changeset; hooks never skipped.
- `lintCaption(raw)` with no rules gives exactly today's output (the `caption_lint.json` fixture test stays as is).
- Before the last commit: `pnpm check && pnpm typecheck && pnpm test` (Cloudflare with `--testTimeout 300000 --maxWorkers=1`).

## Review Focus

1. A caption with 6 hashtags on an account whose `captionRules` is `{}` (saved empty) must still FAIL at Instagram's default cap of 5. Test in Task 3.
2. `captionRules` sent as `{ hashtagMax: "7" }` (a string) or `{ hashtagMax: 31 }` must be refused with 400, not stored. Test in Task 4.
3. A workspace whose only account is `disabled` counts as 0 for `me.accounts`, so the setup note shows. Test in Task 2.
4. The connection-problem email subject keeps "Bongsu: a connection needs attention" after the move. Test in Task 1.
5. `languageChecks: false` must not change the check count for LENGTH, FIRST LINE, HASHTAGS, TAG PLACEMENT, MENTIONS, LINKS, EMOJI, INVISIBLE (only CONCRETE HOOK and ONE ASK disappear). Test in Task 3.

---

### Task 1: Notification builders (#80)

**Files:**
- Create: `packages/core/src/texts/notifications.ts`
- Modify: `packages/core/src/notify.ts:8-70` (`Notifier.send(note: Note)`; `Action` stays), `packages/core/src/tick.ts` (lines 366, 394, 403, 509, 527, 653, 667, 707, 762, 785, 836, 874, 880, 895, 898), `packages/core/src/digest.ts:79`, `packages/core/src/inbox.ts:148`, `packages/core/src/comments.ts:115`, `packages/core/src/cleanup.ts:88`, `packages/core/src/results.ts:104`, `packages/core/src/providers/refresh.ts:98-107`
- Test: `packages/core/test/notifications.test.ts` (new); any test or fake implementing `Notifier.send` (`grep -rn "send(" apps/cloudflare/test/world.ts packages/core/test`)

**Interfaces:**
- Produces: `Note { title; text; target?; actions? }`, the builders listed in the spec's table (exact names), `Notifier.send(note: Note): Promise<void>`.

- [ ] **Step 1: Write the failing test** `notifications.test.ts`: one `it` per builder asserting `title`, `text`, `target` and `actions` equal to today's strings (copy them from the call sites before changing them, e.g. `jobHeld("reel:demo/a", 6)` → `{ title: "reel:demo/a: held", text: "not published within 6 h of its time", target: "reel:demo/a" }`; `published("reel:demo/a", "https://example.com/p/1", { story: false, locationDropped: true })` → text `"https://example.com/p/1 (without its location: Instagram refused it). Pin the self-comment in the app."` with `actions: [{ label: "Open post", url }]`; `connectionMailSubject === "Bongsu: a connection needs attention"`).
- [ ] **Step 2: Run** `pnpm --filter @bongsu/core exec vitest run test/notifications.test.ts`: FAIL (module missing).
- [ ] **Step 3: Implement** the module; change `Notifier.send` to take a `Note`; update every call site and the fake world's notifier (`world.ts` records `{ title, text, target, actions }`: keep that shape).
- [ ] **Step 4: Run** core tests and the Cloudflare suite (`tick`, `inbox`, `phase11`, `digest`, `scenario` at least; the full run before the final commit): PASS, same titles.
- [ ] **Step 5: Commit** `refactor(core): every notification's wording in texts/notifications.ts` (`Refs #80`).

### Task 2: `me.accounts` and the PWA's empty states (#78)

**Files:**
- Modify: `packages/api/src/pwa/routes.ts:122-135` (`accounts`), `packages/web/src/App.tsx` (`Me` type line 16; `QueueList` 805-816; `DayGroups` 835; `QueuePage` 979; `TodayPage` 1005-1060; `CalendarPage`; `DraftsPage` 3002+; a new `SetupNote` component)
- Test: `apps/cloudflare/test/app.test.ts`

**Interfaces:**
- Produces: `GET /app-api/me` → `{ …, accounts: number }` = `SELECT COUNT(*) FROM accounts WHERE workspace_id = ?1 AND status = 'active'`; `SetupNote()` React component; `EMPTY = { scheduled: <JSX>, drafts: "No drafts. The inbox and agents put new posts here for you to review." }`.

- [ ] **Step 1: Tests** in `app.test.ts`: `me.accounts` is the seeded active count for the signed-in user's workspace; 0 when the workspace's accounts are all `disabled` (UPDATE then GET); another workspace's accounts don't count.
- [ ] **Step 2: Run**: FAIL. **Step 3: Implement** the route field; in the PWA add `accounts` to `Me`, the `SetupNote` (copy from the spec, links `/dashboard/start`, `/dashboard/docs/instagram-graph`, `/dashboard/docs/youtube`), render it when `me.accounts === 0` on Today (instead of `TodaySection` + the next-days queue), Queue, Calendar (above the grid) and Drafts; change the empty texts per the spec. **Step 4: Run** `app.test.ts`, `pnpm --filter @bongsu/web typecheck`, `pnpm --filter @bongsu/web build`: PASS.
- [ ] **Step 5: Commit** `feat(api,web): empty states point to the dashboard's setup and the guides` (`Refs #78`).

### Task 3: `LintRules` in core (#77)

**Files:**
- Modify: `packages/core/src/formats/caption-lint.ts:11-14,58-120`, `packages/core/src/platforms/types.ts:75-77`, `packages/core/src/platforms/instagram.ts:48`, `packages/core/src/platforms/youtube.ts:14`, `packages/core/src/accounts.ts` (`captionRules`), `packages/api/src/pwa/approve.ts:142-145`
- Test: `packages/core/test/formats.test.ts`, `packages/core/test/platforms.test.ts:42`, `apps/cloudflare/test/app.test.ts`

**Interfaces:**
- Produces: `LintRules`, `IG_RULES`, `lintCaption(raw, rules = IG_RULES)`, `Platform.lint(caption: string, rules?: LintRules)`, `Platform.lintDefaults: LintRules`, `captionRules(p: Platform, a: Pick<Account, "settings">): LintRules` (merges `a.settings.captionRules` fields of the right type over `p.lintDefaults`, ignoring anything else).

- [ ] **Step 1: Tests** in `formats.test.ts`: `lintCaption(eightTags, { ...IG_RULES, hashtagMax: 10 })` HASHTAGS is PASS and with `IG_RULES` FAIL; `foldChars: 60` makes a 70-char first line WARN; `languageChecks: false` leaves exactly the eight other checks (Review Focus 5); `captionRules(instagram, { settings: {} })` equals `IG_RULES` and `{ settings: { captionRules: { hashtagMax: 10, foldChars: "x" } } }` gives `{ hashtagMax: 10, foldChars: 125, languageChecks: true }`. In `app.test.ts`: approve/options for an 8-tag caption fails with the default and passes once the account's settings carry `{ captionRules: { hashtagMax: 10 } }` (set via `setAccountSettings`).
- [ ] **Step 2: Run**: FAIL. **Step 3: Implement.** **Step 4: Run** core and `app.test.ts`: PASS; the fixture test unchanged.
- [ ] **Step 5: Commit** `feat(core,api): caption lint rules per account` (`Refs #77`).

### Task 4: Caption rules in the dashboard (#77)

**Files:**
- Modify: `packages/api/src/dashboard/routes.ts:724-770`, `packages/dashboard/src/pages.tsx:655-760` (Accounts page)
- Test: `apps/cloudflare/test/dashboard.test.ts`

**Interfaces:**
- Produces: `GET /admin-api/accounts` items gain `captionRules: { hashtagMax, foldChars, languageChecks, defaults: LintRules } | null` (null for platforms with no lint, i.e. empty `formats`); `POST /admin-api/accounts/:id` accepts `captionRules: Partial<LintRules>` validated (integers 0–30 / 50–500, boolean) → 400 `caption rules: hashtagMax 0–30, foldChars 50–500, languageChecks true/false` otherwise; stored via `setAccountSettings(db, id, { captionRules }, nowS)`; audited like the other fields.

- [ ] **Step 1: Tests** in `dashboard.test.ts`: GET shows the defaults; POST stores `{ hashtagMax: 10 }` and GET reflects it with `foldChars` still 125; POST `{ hashtagMax: "7" }` and `{ hashtagMax: 31 }` → 400 and nothing stored (Review Focus 2); a viewer gets 403 (the MANAGING gate).
- [ ] **Step 2: Run**: FAIL. **Step 3: Implement** the route and the Accounts page fields ("Caption checks": `Hashtags max`, `First line chars`, `Language checks` switch; placeholders from `defaults`; saved on blur/change through the existing `update(a.id, { captionRules: … })`). **Step 4: Run** `dashboard.test.ts`, `pnpm --filter @bongsu/dashboard typecheck` and build: PASS.
- [ ] **Step 5: Commit** `feat(api,dashboard): edit an account's caption rules` (`Refs #77`).

### Task 5: Docs, plan, changeset, full check

**Files:** Modify `docs/configuration.md` (a "Caption rules" paragraph under accounts), `docs/PLAN.md` Phase 7 (tick the four boxes "done 2026-10-30"; #79's note: "already generic: `bongsu`, `list_accounts`, owner-only wording"), `.changeset/phase7-wording-rules.md`.

- [ ] **Step 1: Write** the docs and the changeset (minor for core, api, web, dashboard: notification wording in one file; setup note and clearer empty states; caption rules per account in the dashboard).
- [ ] **Step 2: Full verification**: `pnpm fix && pnpm check && pnpm typecheck && pnpm test` (Cloudflare with `--testTimeout 300000 --maxWorkers=1`). Expected: all pass.
- [ ] **Step 3: Commit** `docs(docs): Phase 7 part 1 ticked: wording, empty states, caption rules` (`Refs #77, #78, #79, #80`).
