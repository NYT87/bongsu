---
"@bongsu/core": minor
"@bongsu/api": minor
---

Providers declare how an account connects (token, OAuth with its endpoints and scopes, or Composio), listed in `/app-api/platforms`, and how their connections stay alive. The weekly check now covers YouTube too: a revoked refresh token marks the channel `broken` and notifies once, instead of failing at the next Shorts comment.
