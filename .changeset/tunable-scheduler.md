---
"@bongsu/core": minor
"@bongsu/api": minor
"@bongsu/dashboard": minor
"@bongsu/web": minor
"@bongsu/cloudflare": minor
"@bongsu/node": minor
---

The scheduler is set at deploy time: `CRON_INSTAGRAM`, `CRON_SHORTS` and `CRON_UPKEEP` (five-field cron, UTC) set when
each run happens, and `RUN_SUBREQUESTS` how many outgoing calls one run may make (50 on Cloudflare, `unlimited` on
Node; `10000` suits the paid plan). Unset, everything runs as before. After your next Cloudflare deploy the cron Worker
has one trigger, `* * * * *`, instead of three (`wrangler.cron.toml` changes; Cloudflare's free plan allows 5 per
account). The inbox run is now called `upkeep` in the logs. On Node an invalid `CRON_*` stops startup, naming the
variable. The dashboard's Scheduler section shows each run's schedule, next time and last run, and the limits in use.
