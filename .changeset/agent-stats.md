---
"@bongsu/core": minor
"@bongsu/api": minor
"@bongsu/dashboard": minor
"@bongsu/schema": minor
"bongsu": minor
---

Stats for agents. Three read tools, MCP and REST at once: `get_metrics` (a post's or video's series with its 24 h
numbers), `get_account_metrics` (an account's followers and views per day) and `list_performance` (the posts and videos
of a window, ranked by any count). `ingest_metrics` (`POST /v1/metrics`) uploads samples collected elsewhere into the
same series, behind a new `metrics` scope: opt-in on an agent key, part of the owner's and admin's rights. The CLI gains
`bongsu stats` and `bongsu ingest`. Migration 0014 drops the unused `labels` and `manual_stats` tables: an instance that
imported data from an earlier deployment loses what they held, so take a backup first if you want it.
