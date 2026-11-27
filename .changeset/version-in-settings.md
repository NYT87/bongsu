---
"@bongsu/api": minor
"@bongsu/web": minor
"@bongsu/dashboard": minor
"@bongsu/cloudflare": minor
---

Settings shows the version: the dashboard's Settings page gets a Version card with the app's release and commit beside the server's, and the app's Settings adds the server's line under its own. `pnpm run deploy` and the Docker image pass the commit (`BONGSU_COMMIT`).
