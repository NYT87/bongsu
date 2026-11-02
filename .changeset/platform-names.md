---
"@bongsu/core": minor
"@bongsu/api": minor
"@bongsu/web": minor
---

The app names posts the way each platform does: platforms declare `labels` ("Reel", "Short", "Post") and an account noun, the new `/app-api/platforms` serves them, and the app takes every name, dot and Instagram-only control (cover frame, location, Trial Reel) from it. Calendar events carry `platform`, `format` and `label` instead of `kind`; queue items and the item page carry `platform` and `label`; `list_accounts` says what each account's platform calls its formats, plus its options and features. The daily digest counts per platform.
