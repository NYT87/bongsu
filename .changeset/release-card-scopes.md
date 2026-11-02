---
"@bongsu/api": patch
"@bongsu/web": patch
---

`GET /app-api/me` answers the signed-in role's scopes, and the app shows a scheduled YouTube video's Release date card only to someone who can move it (owners and admins); other roles no longer see a card that answers 403.
