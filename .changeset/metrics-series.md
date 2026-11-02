---
"@bongsu/core": minor
"@bongsu/api": minor
"@bongsu/web": minor
"@bongsu/schema": minor
---

Results over time: the inbox cron samples each published Instagram post (and its Trial Reel copy) and each public
YouTube upload into a new `post_metrics` series, every 6 hours for 3 days, daily to day 30, weekly to day 90, a few
per run (YouTube through `videos.list`, 1 quota unit per channel per run). A published item's page splits into
**Results | Post** (a YouTube video's into **Results | Video**): the 24 h numbers, now the sample nearest 24 hours
after publishing, and a line chart, Total or Daily, of views, reach, likes, comments, saves or shares, with the Trial
Reel as a second line. The 24 h notification's **Open results** opens it. New routes `GET /app-api/item/metrics` and
`GET /app-api/video/metrics`.

Needs migration 0011, which adds `post_metrics` and drops the six count columns from `post_results`, keeping only the
median and the marker that the 24 h notification went out. Each earlier 24 h result becomes that post's first sample
(taken when it was fetched), so posts keep their numbers through the upgrade.
