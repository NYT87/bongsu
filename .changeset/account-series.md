---
"@bongsu/core": minor
"@bongsu/api": minor
"@bongsu/web": minor
"@bongsu/schema": minor
---

Each account's page. The inbox run samples every account's follower (subscriber) count once a day into a new
`account_metrics` series (migration 0013); an instance with imported nightly snapshots gets their history once. An
account's page in the app (Stats → an account) charts its followers (Total | Daily) and its posts' views per day over
7, 30 or 90 days, and ranks the posts and videos that brought followers. The Stats page reads followers from the
series. The Stats and reviews routes now show only the caller's workspace's snapshots and reviews (they showed every
workspace's).
