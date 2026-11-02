# Phase 7, part 1: notification wording, empty states, caption rules per account

The first of Phase 7's sub-projects (`docs/PLAN.md`): #80 (one template file for notification wording), #78 (empty
states that point to the setup and the guides), #77 (caption lint rules per account), and #79 ticked as already done
(the MCP server is named `bongsu`, `list_accounts` exists, the instructions say approving and resuming are owner-only).
None of it changes what the scheduler does: only what it says, what the app shows when there's nothing, and what the
caption check is told.

## #80 Notification wording in one file

`packages/core/src/texts/notifications.ts` exports a `Note` type and one builder per message:

```ts
export interface Note { title: string; text: string; target?: string; actions?: Action[] }
```

| Builder | Used by | Title (unchanged wording) |
|---|---|---|
| `jobVerdict(key, state, reason)` | tick discover | `<key>: <state>` |
| `jobFailed(key, message)` | tick step errors, processing, Shorts | `<key>: failed` |
| `jobRefused(key, reason)` | tick refuse, Shorts | `<key>: refused` |
| `jobHeld(key, hours)` | tick catch-up window | `<key>: held` |
| `providerFailed(key, platformName, error)` | tick failStep | `<key>: failed` |
| `processingTimeout(key, platformName)` | tick polls | `<key>: failed` |
| `dryRunPublish(key, kind, account, detail?)` | tick (verify and publish) | `dry run: would publish <key>` |
| `published(key, permalink, { story, locationDropped })` | tick | `published [Story ]<key>` |
| `publishedTrial(key, permalink)` | tick trial | `published Trial Reel <key>` |
| `shortsWaiting(handle, accountId)` | tick Shorts | `<handle>: Shorts comments waiting` |
| `dryRunComment(label, text, key)` | tick Shorts | `dry run: would comment on Short <label>` |
| `commented(label, key)` | tick Shorts | `commented on Short <label>` |
| `digest(title, text)` | digest | the digest's own title |
| `newDrafts(names)` | inbox | `new draft from the inbox` / `<n> new drafts from the inbox` |
| `newComments(lines, total)` | comments | `New comment` / `<n> new comments` |
| `cleanupRefused(list)` | cleanup | `Media cleanup: the store refused` |
| `results(lines, target)` | results | `24 h results` / `24 h results (<n>)` |
| `connectionProblem(text)` + `connectionMailSubject` | refresh | `A connection needs attention` |

`Notifier.send(note: Note)` replaces `send(title, text, target?, extra?)`; the 21 call sites pass a builder's result.
Wording, targets and action buttons stay exactly as today, so the existing Cloudflare tests that assert titles keep
passing. A core unit test (`packages/core/test/notifications.test.ts`) pins every builder's title and text.

## #78 Empty states that point somewhere

`GET /app-api/me` adds `accounts: number`, the workspace's active accounts (0 when none). The PWA:

- With no account: Today (in place of the Today section and the next-days queue), Queue, Calendar and Drafts show
  one `SetupNote`: "No account connected yet. Connect Instagram or YouTube in the dashboard." with links to
  `/dashboard/start` (Get started) and the guides at `/dashboard/docs/instagram-graph` and `/dashboard/docs/youtube`
  (the docs the dashboard bundles). The note is the same component everywhere.
- With accounts and nothing planned, the lists' empty text says where posts come from:
  "Nothing scheduled. Posts arrive from the inbox, from a draft, or from an agent: see Drafts." with Drafts linked
  (`#/drafts`); the calendar's "Nothing that day." and Today's "Nothing planned for today." stay.
- Drafts empty: "No drafts. The inbox and agents put new posts here for you to review."

Tests: `app.test.ts` checks `me.accounts` with and without accounts (the `accounts` table of the workspace, status
`active`); the PWA copy lives in `App.tsx` (no component tests exist; `pnpm --filter @bongsu/web typecheck` and build).

## #77 Caption rules per account

```ts
export interface LintRules { hashtagMax: number; foldChars: number; languageChecks: boolean }
export const IG_RULES: LintRules = { hashtagMax: 5, foldChars: 125, languageChecks: true };
export function lintCaption(raw: string, rules: LintRules = IG_RULES): Check[];
```

`hashtagMax` replaces `IG_HASHTAGS`, `foldChars` replaces `IG_FOLD` (first line, concrete hook window, tag placement);
`languageChecks: false` skips `CONCRETE HOOK` and `ONE ASK` (the two checks that depend on the caption's language).
`Platform.lint(caption, rules?)` and `Platform.lintDefaults: LintRules` (YouTube: `lint` stays empty, defaults
unused). `captionRules(platform, account): LintRules` in `packages/core/src/accounts.ts` merges
`account.settings.captionRules` (a partial) over `platform.lintDefaults`; `pwa/approve.ts` passes the result to
`plat.lint`. The CLI's `approve` and the app show the same checks, so nothing else changes.

Dashboard: `GET /admin-api/accounts` adds `captionRules: { hashtagMax, foldChars, languageChecks, defaults }` per
account; `POST /admin-api/accounts/:id` accepts `captionRules` (hashtagMax 0–30 integer, foldChars 50–500 integer,
languageChecks boolean; a missing field keeps the default; 400 otherwise) and stores it with `setAccountSettings`.
The Accounts page shows "Caption checks" beside Trial Reels: two number fields and one switch, saved on change like
the Trial Reels switch, with the platform default shown as the placeholder.

Tests: `formats.test.ts` (a cap of 10 passes 8 tags; fold 60 warns a 70-char first line; `languageChecks: false`
drops the two checks; defaults equal today's fixture output), `dashboard.test.ts` (the route stores and validates),
`app.test.ts` or `security.test.ts` (approving an 8-tag caption with the account's cap at 10 has no caption
problem; with the default it does).

## Docs and bookkeeping

- `docs/configuration.md`: the caption rules per account; `docs/agents.md` unchanged (the MCP block stays).
- `docs/PLAN.md`: tick #77, #78, #79 (with "already generic: …"), #80, "done 2026-10-30".
- Changeset: `@bongsu/core`, `@bongsu/api`, `@bongsu/web`, `@bongsu/dashboard` minor.
- One merge request, `feat(core,api,web,dashboard): notification templates, empty states, caption rules per account`,
  closing #77, #78, #79, #80.

## Out of scope

Branding from workspace settings (#75), the i18n scaffold (#76), the YouTube release date (#134): their own
sub-projects. Translating or changing any notification's wording. New lint checks.
