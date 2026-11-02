---
"@bongsu/core": minor
"@bongsu/api": minor
"@bongsu/web": minor
"@bongsu/schema": minor
---

The followers a post or video brought. The metrics series gains Instagram's `follows` and `profile_visits`
(migration 0012; NULL for samples taken before and for media types without them) and, for YouTube, the subscribers a
video gained through the YouTube Analytics API. The connect flow now asks for the `yt-analytics.readonly` scope:
add it to your Google app's consent screen and enable the YouTube Analytics API, then **Reconnect** each channel
from the dashboard; until then a video's Results view says the subscriber numbers aren't available. The 24 h
notification and the Results view show "+12 followers · 85 profile visits" (a Trial Reel copy its own), and the
metric picker gains Followers and Profile visits (Subscribers for a video).
