---
"@bongsu/core": minor
"@bongsu/api": minor
"@bongsu/web": minor
"@bongsu/cloudflare": minor
---

Plan dates and times follow the workspace's time zone (daylight saving included) instead of one fixed zone; the daily digest is sent from the workspace's digest hour. API times now end with the zone name, and `get_status` returns `today` and `timezone`.
