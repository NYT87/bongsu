---
title: Approving a seeded Reel through the app in a test needs its file put in the fake Drive first
author: NYT87
date: 2026-11-26
branch: fix/approval-and-workspace-bugs
cost: { minutes: 30, tokens: 271571 }
id: l-e603c7d0
scope: repo
status: active
src: agent
touches:
  - packages/core/src/tick.ts
  - packages/core/test/reopen.test.ts
  - apps/cloudflare/test/tick.test.ts
  - packages/core/src/data.ts
  - packages/api/src/agent/ops.ts
  - packages/api/src/pwa/schedule.ts
  - apps/cloudflare/test/workspaces.test.ts
  - packages/schema/src/migrations/0025_approval_trial.ts
  - packages/schema/src/migrations/index.ts
  - packages/core/src/formats/approved.ts
---

## Watch out
- `seedReel` approves straight in the database. To approve through the app's passkey flow (`/app-api/approve/options` then `/verify`), seed with `approve: false` and put the Reel's file in the fake Drive. Otherwise options answers 409 "not in the media store yet", and verify then fails with a confusing "passkey check failed", because there was never a challenge.
- `seedReel` approvals leave `approvals.trial` NULL. That is the "approved before this was kept" case, where the switch decides. A test of the trial-copy approval has to approve through the app.

In the code: `w.drivePut(\`UPLOADS/${folder}/exports/shorts/instagram/${base}.mp4\`, { md5, mimeType: "video/mp4" })`, as in apps/cloudflare/test/app.test.ts reelOnDrive and the #93 test in phase13.test.ts.
