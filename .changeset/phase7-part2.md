---
"@bongsu/core": minor
"@bongsu/api": minor
"@bongsu/web": minor
"@bongsu/dashboard": minor
---

A scheduled YouTube video's release date can be moved from the app (with the passkey), from the dashboard's new Videos
page and from the API, where the opt-in `reschedule` scope allows it. The app's name, theme colour and icons come from
build inputs (`BONGSU_APP_NAME`, `BONGSU_THEME_COLOR`). The app reads its texts through `t()` from an English catalogue,
with the workspace's locale on `/app-api/me`.
