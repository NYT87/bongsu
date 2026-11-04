---
"@bongsu/core": minor
"@bongsu/api": minor
"@bongsu/dashboard": minor
"@bongsu/cloudflare": minor
"@bongsu/node": minor
"@bongsu/schema": minor
---

The ntfy topic is a setting of each workspace: the dashboard's **Settings → Notifications (ntfy)** sets, tests and
removes it, and only that workspace's notifications go there. It's stored encrypted (it needs `ENCRYPTION_KEY`) and
the page shows only its server. Bongsu posts to it without following redirects and with a time limit.

To update: `NOTIFY_URL` is gone. If you used it, paste the same topic in the dashboard's Settings (migration `0016`
adds the column) and remove the variable or secret.
