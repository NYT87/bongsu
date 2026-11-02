---
"@bongsu/node": minor
"@bongsu/core": minor
"@bongsu/api": patch
"@bongsu/cloudflare": patch
---

Bongsu runs on Node: `apps/node` serves the app, the dashboard and the APIs, runs the three schedules with node-cron
and keeps everything in one SQLite file (migrations applied at start). New: a `local` media store (a directory,
`MEDIA_STORE=local`, `MEDIA_DIR`) and an `smtp` mailer on Node. The schedules now live in one place
(`core/schedules.ts`), shared with the Cloudflare cron Worker; `/health` asks only for the secrets the media store in
use needs.
