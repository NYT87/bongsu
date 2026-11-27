---
title: "On a fresh account, deploy the Workers before running deploy-secrets, and keep your own ENCRYPTION_KEY copy"
author: NYT87
date: 2026-11-27
branch: main
cost: { minutes: 41, tokens: 249777 }
id: l-e77e94f0
scope: repo
status: active
replaces: l-743cb272
src: agent
touches:
  - site/docs/deploy-cloudflare.md
  - packages/cli/src/secrets.ts
  - packages/api/src/app.ts
  - site/docs/drive.md
---

## Decided
- On a brand-new Cloudflare setup, deploy both Workers first (still in dry run, with no secrets), then run deploy-secrets, then deploy again once VAPID_PUBLIC_KEY is pasted in.
- If you want a copy of ENCRYPTION_KEY, set it yourself before anything is encrypted: `openssl rand -hex 32`, then `wrangler secret put ENCRYPTION_KEY` on both Workers with the same value. deploy-secrets keeps names that are already set.

In the code: site/docs/deploy-cloudflare.md runs step 6 (`bongsu deploy-secrets`) before step 7 (`pnpm run deploy`). deploy-secrets calls `wrangler secret list` first, and that fails with `Worker "bongsu" not found` when the Worker doesn't exist yet. packages/cli/src/secrets.ts generates ENCRYPTION_KEY and never prints it (only SETUP_TOKEN is printed).
- Every instance will serve a small privacy page at <PUBLIC_URL>/privacy. Self-hosters point the Google app's "Application privacy policy link" at it.
- Until that page ships, the app can be published with the home page as a placeholder link, then switched over.

In the code: the Google console's Google Auth Platform → Audience → "Publish app" stays disabled ("complete your configuration on the Branding page") until Branding has a privacy policy link. The home page and an authorized domain alone were not enough (tested 2026-11-27). The scopes Bongsu asks for: drive (restricted), youtube.force-ssl (sensitive), yt-analytics.readonly. site/docs/drive.md and youtube.md don't mention the privacy link yet.

## Watch out
- The guide's step order fails as written on a first deploy. Either swap the steps or have deploy-secrets create the Worker.
- The guide says to keep a copy of ENCRYPTION_KEY, but deploy-secrets offers no way to see it. Replacing it is safe only while nothing is stored encrypted: no rows in oauth_apps, workspace_oauth_apps, connections or media_store, and no `v1:` values in settings.
- /health answers ok:false until at least one instance-wide media store is connected (packages/api/src/app.ts), even when every table and secret is present.
- A workers.dev hostname is accepted as an authorized domain (<sub>.workers.dev; workers.dev is a public suffix).
- Once in production, the app shows "Your app requires verification" and a 100-user lifetime cap. That's fine for your own accounts, behind the "unverified app" warning.
- The consent screen moved: it's now "Google Auth Platform" with a 4-step Get started wizard (App Information, Audience, Contact, Finish). Scopes are set on Data Access and publishing is on Audience.

## Tried and ruled out
- Home page plus authorized domain only: Publish stayed disabled.
- Keeping the home page as the privacy link for good: it works, since Google doesn't check unverified apps, but the guide would then tell every self-hoster to put a fake link.
- Staying in Testing to avoid the requirement: Google expires refresh tokens after 7 days in Testing.
