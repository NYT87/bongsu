---
"@bongsu/core": minor
"@bongsu/cloudflare": minor
---

Instagram providers: each account posts through its connection's provider, `instagram-graph` (Instagram's own API with the account's token; Trial Reels for every account) or `instagram-composio` (as before). The inbox cron renews instagram-graph tokens weekly, keeps the renewed token encrypted, and marks a connection `expiring` or `broken` (with one notification) when renewal fails. Migration 0005 allows `instagram` connections. Setup: `site/docs/instagram-graph.md`.
