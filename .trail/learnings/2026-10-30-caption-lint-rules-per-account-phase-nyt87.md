---
title: Caption lint rules per account (Phase 7 part 1)
author: NYT87
date: 2026-10-30
branch: feat/phase-7-wording-rules
cost: { minutes: 1, tokens: 0 }
touches:
  - packages/core/src/formats/caption-lint.ts
  - "packages/core/src/accounts.ts#captionRules"
  - packages/core/src/platforms/types.ts
  - packages/api/src/dashboard/routes.ts
  - packages/dashboard/src/pages.tsx
---

## Decided
- `lintCaption(raw, rules = IG_RULES)` takes a `LintRules` object (hashtagMax, foldChars, languageChecks); each `Platform` carries `lintDefaults`, and `captionRules(platform, account)` in core/accounts.ts merges only well-typed fields of `settings.captionRules` over them, so a stray or mistyped value can never switch a check off by accident. The empty object `{}` keeps every default.
- Platforms that lint nothing (YouTube, the fakes in the tests) use the shared `NO_LINT` constant beside `NO_FEATURES` in platforms/types.ts: `lintDefaults` is a required field, so every Platform literal (including test fakes) must set it.
- `POST /admin-api/accounts/:id` with `captionRules` **merges**: only the fields sent change, `null` puts one back to the platform's default (dropped from the stored object). The dashboard saves one field per change, so two quick edits can't overwrite each other.
- `languageChecks: false` drops exactly CONCRETE HOOK and ONE ASK; the other eight checks are language-neutral and stay.

## Tried and ruled out
- Replace semantics (the dashboard re-sending the whole override set on each change): the first version. The whole-branch review found a race: typing a number and then clicking the switch fires blur and change before the reload, and the second POST (built from the stale props) wiped the first. Merge with `null` clears avoids it and the one-field-at-a-time pitfall for API callers.
- Repeating the zero-rules literal in each non-linting platform: typechecks, but the fakes in two test files would drift.

## Watch out
- Any new `Platform` (real or a test fake) needs `lintDefaults`, or `pnpm typecheck` fails on the test tsconfig.
- commitlint's `subject-case` rule refuses a subject that starts with a capitalised word ("docs(docs): Phase 7 …"): start lowercase and keep proper nouns later in the subject ("tick Phase 7 …").
- The dashboard bundles every `docs/*.md` (docs.tsx `import.meta.glob`), so a new section in `docs/configuration.md` shows up in the dashboard's guides too.
