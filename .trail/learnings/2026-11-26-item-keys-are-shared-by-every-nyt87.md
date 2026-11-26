---
title: "Item keys are shared by every workspace, so rows left under a key can block another workspace's post"
author: NYT87
date: 2026-11-26
branch: main
cost: { minutes: 5, tokens: 158779 }
id: l-36c93e57
scope: repo
status: active
src: agent
touches:
  - packages/core/src/data.ts
  - packages/api/src/agent/ops.ts
  - packages/core/src/tick.ts
  - packages/api/src/pwa/approve.ts
---

## Watch out
- A plan item's key comes only from the project folder's last part and the file name, and it is unique across the whole instance, not per workspace. The tables that hang off it (posted, jobs, approvals) are looked up by that key alone.
- So a "posted" row or an old job left under a key in one workspace stops the same key in another workspace from publishing, silently. `record_posted` even accepts a key that isn't planned yet.
- A job that reaches `done` never comes back: nothing reopens it and nothing deletes job rows. That includes a dry-run job, so an item dry-run once can't publish for real even after it's rescheduled and approved again. YouTube jobs start 6 h early, so dry run marks them done well before their time.
- The approval hash covers texts, media, account and time. Instagram options (location, cover, the trial switch) are not in it; location is left out on purpose, but the trial switch adds a whole second post.

In the code: makeKey and isPosted in packages/core/src/data.ts; the `LEFT JOIN posted x ON x.item_key = p.item_key` joins (data.ts, calendar.ts, release.ts, results.ts, pwa/routes.ts); recordManualPost in packages/api/src/agent/ops.ts; reopens and queueTrial in packages/core/src/tick.ts; snapshot in packages/api/src/pwa/approve.ts. Found in the 2026-11-26 repo audit; not fixed yet.
