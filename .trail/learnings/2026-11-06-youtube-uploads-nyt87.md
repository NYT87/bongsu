---
title: "YouTube uploads: the lead, the fingerprint roles, the sweep"
author: NYT87
date: 2026-11-06
branch: feat/youtube-uploads
touches:
  - packages/core/src/tick.ts
  - packages/core/src/providers/youtube.ts
  - packages/core/src/platforms/youtube.ts
  - packages/core/src/formats/youtube-texts.ts
  - packages/api/src/agent/ops.ts
  - site/docs/youtube.md
  - ".changeset/youtube-uploads.md"
---

## Decided

- The upload starts `uploadLeadS` (6 h, a platform field) before the due time. Active jobs are selected with `due_at <= now + MAX_LEAD_S`, filtered in code by `due_at - leadOf(job) <= now`, and ordered in three groups: due and non-upload work, upload steps, then waiting (ready, pre-due) steps. A long upload never takes an Instagram post's slot, even past its due time.
- A job refused for a reschedule or a changed text keeps its video and `step`; the next approval reopens it (also from `container_created`) with `previousUpload`, so the provider revises the same video (same checksum) or deletes and replaces it.
- The media roles (video, `subtitle:<lang>`, thumbnail) are folded into `approvals.texts_sha`: it hashes canonical `{texts, roles}`, so one column covers texts and file roles and Instagram keeps its media-key format. App matching and the tick's verify both compute it from current names. `canonicalJson` skips undefined-valued keys, as `JSON.stringify` does, or the two sides diverge.
- A scheduler-wide sweep each run deletes the private video of refused, held or failed jobs whose plan item is gone (`NOT EXISTS`, `videoId` filtered in code, never `publishing: true`), a few per run, with an audit row. `DRY_RUN` only writes `would_delete`. The delete waits while the workspace is paused or archived.
- Streaming is the default; `YOUTUBE_UPLOAD_MODE=chunk` sends 8 MiB pieces. The cost spike (Task 1) was deferred (needs the owner's Cloudflare login): streaming is not measured.
- `get_item`'s old `texts` provenance moved to `texts_source`; `texts` carries the YouTube texts. External agents reading `texts.at` break (changeset says so).

## Tried and ruled out

- Overloading `item` in the video page's answer: a field whose type changes breaks clients, so it answers `{ item_key }`.
- Guessing the channel of an inbox draft from file names: it could misroute; the owner picks it when scheduling.
- A separate fingerprint column for roles: a migration for no gain.

## Watch out

- Subrequest budget: Workers allow 50 (free) per run. The inbox counts store reads against a budget and stops before an item that doesn't fit (the first item always goes); the sweep and the uploads share the budget too. A run that throws mid-way must still send the new-drafts notification.
- The `/m/` media links the provider fetches are served by the test world at the test clock (`World.links` / `serveLinks`): a test that moves the clock past a link's expiry gets a 403, so set the clock first.
- A `YouTubeLocked` failure must clear the `publishing` flag (finish read it back private) or a later approval can never reopen the job; its `last_error` is the audit text verbatim because the app's progress line detects it.
- `videos.insert` costs 1600 units and a subtitle track 400: the default 10,000 a day is a handful of uploads.
