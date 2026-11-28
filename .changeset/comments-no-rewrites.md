---
"@bongsu/core": patch
---

Checking a post for new comments no longer writes every stored comment again: one read per post, and only the new ones are written, so the run's query budget is left for token renewal and the media store checks.
