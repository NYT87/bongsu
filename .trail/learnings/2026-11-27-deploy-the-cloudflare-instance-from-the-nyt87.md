---
title: "Deploy the Cloudflare instance from the release workflow, with its values as environment secrets"
author: NYT87
date: 2026-11-27
branch: feat/deploy-on-release
id: l-107aafef
scope: repo
status: active
src: agent
touches:
  - ".github/workflows/release.yml"
  - site/docs/deploy-cloudflare.md
  - site/docs/drive.md
  - site/docs/nav.json
  - site/docs/youtube.md
---

## Decided
- The Cloudflare deploy is a job of the release workflow, not a separate workflow triggered by `release: published`. It runs after the changesets release job when the product's version moved (the same `product` output the Docker job uses) and the repository variable CLOUDFLARE_DEPLOY is `true`, so forks only get it if they turn it on.
- The instance's values (D1 id, PUBLIC_URL, VAPID public key and subject) are secrets of a `production` GitHub environment, not variables. The job writes them into the repo's wrangler templates with sed. Required reviewers on that environment gate each deploy.

In the code: .github/workflows/release.yml, job `deploy-cloudflare`; site/docs/deploy-cloudflare.md, "Deploy every release with GitHub Actions".

## Tried and ruled out
- A workflow on `release: published`: the releases are created by changesets with GITHUB_TOKEN, and events from GITHUB_TOKEN don't start other workflows, so it would never run.
- Repository variables for the instance's URL and ids: Actions logs of a public repository are public, and wrangler prints every var and the D1 id on deploy. Secrets show as `***`.

## Watch out
- An unset secret is an empty string: sed swaps the placeholder for nothing and a "placeholder left over" grep passes. The step checks each value is non-empty first (tested locally on the templates).
- The job writes only PUBLIC_URL, RP_ID, VAPID_*, DRY_RUN and database_id. Other vars an instance sets in its own wrangler files (CRON_*, RUN_SUBREQUESTS, YOUTUBE_UPLOAD_MODE) need a line in the job.
