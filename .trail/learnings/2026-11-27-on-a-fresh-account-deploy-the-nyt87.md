---
title: "On a fresh account, deploy the Workers before running deploy-secrets"
author: NYT87
date: 2026-11-27
branch: main
cost: { minutes: 4, tokens: 66197 }
id: l-743cb272
scope: repo
status: active
src: agent
touches:
  - site/docs/deploy-cloudflare.md
  - packages/api/src/app.ts
---

## Decided
- On a brand-new Cloudflare setup, deploy both Workers first (still in dry run, with no secrets), then run deploy-secrets, then deploy again once VAPID_PUBLIC_KEY is pasted in.

In the code: site/docs/deploy-cloudflare.md runs step 6 (`bongsu deploy-secrets`) before step 7 (`pnpm run deploy`). deploy-secrets calls `wrangler secret list` first, and that fails with `Worker "bongsu" not found` when the Worker doesn't exist yet.

## Watch out
- The guide's step order fails as written on a first deploy. Either swap the steps or have deploy-secrets create the Worker.
- /health answers ok:false until at least one instance-wide media store is connected (packages/api/src/app.ts), even when every table and secret is present.
