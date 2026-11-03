---
"@bongsu/web": minor
"@bongsu/api": minor
"@bongsu/schema": minor
---

The Stats tab reads only what Bongsu collects or receives: each account's followers from the account series, then the last 7 days' posts and videos, most viewed first, each opening its Results or video page. The snapshot Performance page and the review pages are gone with their routes (`/app-api/performance`, `/app-api/report`), and migration 0015 drops the `reports` table (export it first if an instance imported reviews). The `snapshots` table stays: it backfills the account series once.
