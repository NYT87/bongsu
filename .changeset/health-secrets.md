---
"@bongsu/core": patch
"@bongsu/api": patch
---

`/health` asks for a connection kind's secret only when such a connection exists: `COMPOSIO_CONSUMER_KEY` with a Composio connection, `ENCRYPTION_KEY` with an instagram-graph one. An instance on Instagram's own API needs no Composio key.
