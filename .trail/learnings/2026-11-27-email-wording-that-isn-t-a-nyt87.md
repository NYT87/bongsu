---
title: "Email wording that isn't a notice goes in its own texts file, not with the notification builders"
author: NYT87
date: 2026-11-27
branch: feat/email-footers-optout
id: l-f7bed8d4
scope: repo
status: active
src: agent
touches:
  - packages/core/test/notifications.test.ts
  - packages/core/src/texts/mail.ts
---

## Decided
- The alert emails' footer lives in its own texts file next to the invite wording, not in the notifications texts file.

## Tried and ruled out
- Exporting the footer helper from the notifications texts file: a core test enumerates every function that file exports and expects each to be a notice builder with a group, so any other export fails it.

## Watch out
- Only `Note` builders may be exported from the notifications texts file; helpers, subjects as functions or mail wording belong elsewhere.

In the code: packages/core/test/notifications.test.ts "covers every exported builder" compares `Object.entries(N)` functions with its `notes` map. The footer is `alertMailFooter` in packages/core/src/texts/mail.ts.
