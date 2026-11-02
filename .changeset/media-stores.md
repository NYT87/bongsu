---
"@bongsu/core": minor
"@bongsu/api": minor
"@bongsu/web": patch
"@bongsu/cloudflare": minor
---

Media goes through a `MediaStore` interface (Drive is the first store; `docs/media-stores.md`). Migration 0004 turns media references into `{store, id, checksum}` (approvals, queued jobs, plan items, drafts) and keys `inbox_seen` and `media_cleanup` (was `drive_cleanup`) by store and id; existing Drive references keep their id and md5, so approvals stay valid. Drafts made by agents take file ids in the instance's store.
