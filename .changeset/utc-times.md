---
"@bongsu/core": minor
"@bongsu/api": minor
"@bongsu/web": minor
"@bongsu/cloudflare": minor
---

Times are stored in UTC (migration 0003: `plan_items.due_at`, `approvals.due_at`, `posted.published_at`); time zones only apply when showing and entering them. Each user can pick their own zone in Settings (the workspace's is the default, and agent keys use it). The API returns `due` on the caller's clock plus `due_at` in ISO 8601 UTC, `plan_add`/`plan_update` also take `at` (an instant with its zone), and the queue returns `until` instead of `until_kst`.
