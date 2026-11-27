---
title: "Deploy the Cloudflare instance from the release workflow, with its values masked"
author: NYT87
date: 2026-11-27
branch: ci/mask-deploy-values
id: l-b07ce2c0
scope: repo
status: active
replaces: l-107aafef
src: agent
touches:
  - ".github/workflows/release.yml"
  - site/docs/deploy-cloudflare.md
---

## Decided
- The Cloudflare deploy is a job of the release workflow, not a separate workflow triggered by `release: published`. It runs after the changesets release job when the product's version moved (the same `product` output the Docker job uses) and the repository variable CLOUDFLARE_DEPLOY is `true`, so forks only get it if they turn it on.
- The instance's values (D1 id, PUBLIC_URL, VAPID public key and subject) are secrets of a `production` GitHub environment, and the job writes them into the repo's wrangler templates with sed. Required reviewers on that environment gate each deploy.
- Values the job derives from those secrets are masked explicitly with `::add-mask::` before wrangler runs: the hostname, its parent domain, and the VAPID key cut to 37 characters.

In the code: .github/workflows/release.yml, job `deploy-cloudflare`, step "Write the wrangler configs"; site/docs/deploy-cloudflare.md, "Deploy every release with GitHub Actions".

## Tried and ruled out
- A workflow on `release: published`: the releases are created by changesets with GITHUB_TOKEN, and events from GITHUB_TOKEN don't start other workflows, so it would never run.
- Repository variables for the instance's URL and ids: Actions logs of a public repository are public, and wrangler prints every var and the D1 id on deploy.

## Watch out
- GitHub masks a secret only where its exact value appears. The first real deploy (2026-11-27) printed `env.RP_ID ("<host>")`, which is derived from PUBLIC_URL, along with `https://bongsu-cron.<sub>.workers.dev` and the VAPID key cut short by wrangler. Any new value built from a secret needs its own `::add-mask::`. Read the first deploy log of any change. To remove an exposed log, use `gh api -X DELETE repos/<owner>/<repo>/actions/runs/<id>/logs` (verify with the API, since `gh run view --log` reads a local cache).
- An unset secret is an empty string: sed swaps the placeholder for nothing and a "placeholder left over" grep passes. The step checks each value is non-empty first.
- The job writes only PUBLIC_URL, RP_ID, VAPID_*, DRY_RUN and database_id. Other vars an instance sets in its own wrangler files (CRON_*, RUN_SUBREQUESTS, YOUTUBE_UPLOAD_MODE) need a line in the job.
