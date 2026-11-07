---
"@bongsu/core": minor
"@bongsu/api": minor
"@bongsu/web": minor
"@bongsu/dashboard": minor
"bongsu": minor
"@bongsu/schema": minor
---

YouTube uploads: Bongsu uploads Shorts and videos as private 6 hours ahead of the planned time and makes them public
at that time once you approve them with your passkey. A video has a title, a language, tags, translations, subtitle
files and a thumbnail (translations need the video's language), from the app, the inbox, the API or
`bongsu texts set --title/--language/--translation`; `bongsu texts get` shows a video's description and comments too; progress shows in
the app ("Uploading, 40%", "YouTube is processing", "Ready: goes public at 18:00"), and a Google project that hasn't
passed YouTube's audit is explained. Set `YOUTUBE_UPLOAD_MODE=chunk` on the cron Worker to upload in 8 MiB pieces.

**Breaking (agents):** `get_item`'s provenance field `texts` (`{ at, by, repo_files }`) is now `texts_source`; `texts`
carries a YouTube video's title, tags and translations (`null` for Instagram).
