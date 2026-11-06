# YouTube uploads: Shorts and videos, with languages, subtitles and a thumbnail

Issue: #31 (Phase 14). Builds on `a86175c`.

## Goal

Bongsu publishes videos to YouTube the way it publishes Instagram Reels: planned, approved with a passkey, and out on
time. A post covers both Shorts and long videos, with:

- its title;
- its settings;
- titles and descriptions in other languages;
- subtitle tracks;
- a thumbnail.

Videos uploaded outside Bongsu keep working as they do now: the calendar, stats, comments and release dates. They sit
beside Bongsu's own uploads without being counted twice.

## Decisions (with the owner)

| # | Decision |
|---|---|
| D1 | **Early upload, Bongsu publishes.** The approved video is uploaded 6 hours ahead as private, with no YouTube schedule. At the due time Bongsu checks the approval and the pause again, then makes the video public or unlisted. |
| D2 | **Stream and resume.** Each run streams the file from the media store into YouTube's resumable upload, and a run that is cut off resumes from YouTube's confirmed offset. Chunking is the fallback if streaming proves CPU-heavy on Workers. |
| D3 | **Storage.** Subtitle files and the thumbnail are media files beside the video, so the approval's media fingerprints cover them. The texts (title, languages, translations, tags) are one JSON column with one approval fingerprint. |
| D4 | **Its own title field.** It is required and at most 100 characters. The caption is the description. |
| D5 | **One spec, one pull request** for uploads and languages together. |
| D6 | **Shared analytics.** A video Bongsu uploaded belongs to its plan item everywhere (stats, calendar, video page). Videos uploaded elsewhere keep their `video:<id>` pages and series. |

## 1. The post

### Platform (`packages/core/src/platforms/youtube.ts`)

- **Formats:** `formats: ["video"]`, one video per post. Shorts and long videos are the same upload; YouTube files a
  vertical video of 3 minutes or less as a Short. The label is "Video".
- **Limits:** `captionMax: 5000` (the description), `videoSecondsMax: 43200`, `mediaMax: 1` (the video; subtitle and
  thumbnail files don't count).
- **New field `uploadLeadS?: number`** on `Platform`: how long before the due time the job starts. YouTube's is `21600`
  (6 h); Instagram has none, so it starts at the due time as now.
- **Caption check (`lint`):**
  - FAIL when the description, or any title or translation, contains `<` or `>`;
  - FAIL when a title is over 100 or a description over 5000 characters;
  - nothing else.
- **Options** (`plan_items.options`, validated by `validateOptions`):

  | Key | Type | Default |
  |---|---|---|
  | `madeForKids` | boolean | the channel's default, else `false` |
  | `privacy` | `"public"` or `"unlisted"` | `"public"` |
  | `category` | string, a YouTube category id (`^[0-9]{1,3}$`) | the channel's default, else `"22"` (People & Blogs) |

- **Channel defaults:** `madeForKids` and `category` go in `accounts.settings.youtube`. They are edited in the
  dashboard and read when an option is absent.

### Texts (`plan_items.texts`, `drafts.texts`: JSON, nullable)

```json
{
  "title": "…",
  "language": "en",
  "audioLanguage": "en",
  "tags": ["travel", "lisbon"],
  "translations": { "es": { "title": "…", "description": "…" } }
}
```

- **`title`:** required to approve a YouTube post; trimmed, 1–100 characters.
- **`language` and `audioLanguage`:** optional BCP-47 tags (`^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$`).
- **`tags`:** optional. YouTube's 500-character total is counted as YouTube counts it (a tag with a space counts its
  quotes).
- **`translations`:** keyed by language tag. Each has a `title` (1–100 characters) and a `description` (at most 5000).
  A translation's language may not equal `language`.
- **Checked by:** `checkTexts(platform, texts)` in `packages/core/src/texts/youtube.ts`, which throws a `TextsError`
  with a message saying what is wrong.
- **Other platforms:** an Instagram item's `texts` stays null. The routes refuse a non-null one with "Instagram posts
  have no title or translations".

### Files beside the video

The post's media holds the video plus, optionally:

- **Subtitles:** `<lang>.srt` or `<lang>.vtt`, one per language tag. `<lang>` follows the `language` pattern above.
- **Thumbnail:** `thumbnail.jpg` or `thumbnail.png`, at most one, and at most 50 MB (the API's `thumbnails.set` limit).
  A channel without YouTube's verified features gets YouTube's refusal as a "Problems" note; the video still goes
  out.
- **Any other file** stops the post at the check, with "<name> isn't a video, a subtitle file (<lang>.srt or .vtt) or
  thumbnail.jpg/png".
- **`mediaRoles(entries)`** in `packages/core/src/platforms/youtube.ts` returns
  `{ video, subtitles: { lang, ref }[], thumbnail? }` or throws.

### Approval

- **`approvals.texts_sha`:** text, nullable. It is the sha256 of the texts in canonical form (keys sorted at every
  level, no whitespace), and `textsSha(texts)` in `formats/approved.ts` computes it. `null` means no texts.
- **What must still match:** an approval is valid only while `texts_sha` matches, alongside the caption, comments, alt
  texts and media fingerprints. The subtitle files and the thumbnail are in `media`, so a changed file needs a new
  approval.
- **Options are not fingerprinted,** as now: made for kids, privacy and category are settings. `tags` is in the texts
  because it is text.
- **Who approves:** approving stays human. Writing `texts` through the agent API is allowed; approving never is.

### Bongsu's uploads and other uploads (D6)

- **`bongsuVideos(db, accountIds)`** in `packages/core/src/youtube-videos.ts` maps a video id to its item key, for
  published or in-flight jobs on those accounts (`jobs.media_id`, else `payload.step.data.videoId`).
- **Its users:**
  - The metrics sampler skips a `video:<id>` candidate that maps to an item, and samples the item instead.
  - Channel stats, the calendar, `list_performance` and the video page show the item for such an id.
    `#/video/<account>/<id>` redirects to `#/item/<key>/results`.
- **Lists:** they show both kinds, with a "Bongsu" or "Uploaded elsewhere" marker.
- **Release dates:** on a manual upload, as now. On a Bongsu upload, moving the time is a plan-item time change, which
  needs a new approval.
- **Workspaces:** the map is built only from the caller's workspace's jobs.

## 2. Publishing

### When a job starts

- **Item discovery** (`discover` in `tick.ts`) takes YouTube items whose `due_at − uploadLeadS ≤ now`. The active-job
  query selects a job when `due_at − lead ≤ now`, the lead coming from its account's platform. A job without a lead
  keeps today's rule.
- **Approval:** a job starts only with a valid approval, as now. Without one it is refused and reopens when the
  approval comes. Approving within the lead starts the upload on the next run.
- **Order:** each run advances the other jobs first and upload steps last, so a long upload never delays an Instagram
  post.
- **Dry run:** `DRY_RUN` sends the dry-run note and uploads nothing.

### Provider steps (`packages/core/src/providers/youtube.ts`, `clients/youtube.ts`)

`step.data` holds:

```
{ phase, session, size, videoId, captions: { lang: { trackId, md5 } }, thumbnailMd5, notBefore }
```

1. **`start(post)`** calls `videos.insert?uploadType=resumable&part=snippet,status,localizations`.
   - It sends the snippet: title, description (the caption), tags, `categoryId`, `defaultLanguage`,
     `defaultAudioLanguage`.
   - It sends the status: `privacyStatus: "private"`, `selfDeclaredMadeForKids`, and no `publishAt`.
   - It sends `localizations` from the translations.
   - It returns `{ state: "processing", data: { phase: "uploading", session, size } }`. `size` comes from a `HEAD` (or
     a `bytes=0-0` range) on the media link.
2. **`check(step)`** works through the phases:
   - **`uploading`:**
     - Ask the session for its offset (`PUT` with `Content-Range: bytes */<size>`).
     - Fetch the media link with `Range: bytes=<offset>-`, and `PUT` that body to the session with a fixed length.
     - Stop after `UPLOAD_BUDGET_S` (180 s, below the tick lock's 240 s). The next run resumes from the offset.
     - On `200`/`201`, record the `videoId` and move to `extras`.
   - **`extras`:**
     - `thumbnails.set` when there is a thumbnail.
     - `captions.insert` per subtitle file not yet in `data.captions`. Each is recorded as it lands, so a retry never
       duplicates a track.
     - Then move to `processing`.
   - **`processing`:**
     - Poll `videos.list?part=status,processingDetails`.
     - `uploadStatus: "processed"` → `waiting`.
     - `rejected` or `failed` → `failed`, with YouTube's `rejectionReason` or `failureReason`.
   - **`waiting`:** answers `state: "ready"`.
3. **The tick at a ready step:**
   - If `now < job.due_at`, the job waits, and these runs don't count towards `MAX_POLLS`.
   - At the due time it runs the usual `recheck` (the approval still matches, the workspace isn't paused), then
     `finish`.
4. **`finish(step)`:**
   - It reads the video's status and writes it back whole with `privacyStatus` set to the `privacy` option.
     `videos.update` resets the status fields it isn't sent; see the release-date learning.
   - It reads the status back. If it is still `private`, it throws `YouTubeLocked`.
   - The job then fails, and "Problems" says: "YouTube keeps this video private until your Google project passes
     YouTube's audit (see the YouTube guide)".
   - On success it returns `{ mediaId: videoId, permalink, publishedAt: now }`. The permalink is
     `https://youtube.com/shorts/<id>` when the video is 180 s or shorter and vertical (from `processingDetails` and
     `fileDetails`), else `https://youtube.com/watch?v=<id>`.
   - The first comment follows, as for a Reel (`features.firstComment`).

### Changes after the upload

The job keeps `videoId`. When a new approval reopens it:

- **Same video fingerprint:**
  - `videos.update` with the snippet, status (still private) and localizations.
  - Replace only the caption tracks whose file `md5` changed (delete, then insert), and delete the tracks of removed
    languages.
  - Set the thumbnail again only if its `md5` changed.
  - Then `processing` → `waiting`.
- **Video changed:** `videos.delete` the old one, clear the step, and upload again.
- **Item withdrawn or removed** (`plan_remove`, a draft withdrawn, the item deleted in the app): delete the private
  video, best effort, and write the audit row `youtube_video_deleted`.
- **A job that fails for good:** the private video is kept, and the failure note says it is there, private, to inspect
  or publish by hand.

### Pause, quota, errors

- **Pause:** a paused workspace's jobs wait as now. A ready video stays private past its time; the existing "held past
  their time" note covers it.
- **Quota:**
  - `403 quotaExceeded` or `uploadLimitExceeded` sets `data.notBefore` to the next midnight in `America/Los_Angeles`.
    The job waits without counting an attempt.
  - One note goes to "Problems" per workspace per day: "YouTube's daily quota is used up: uploads continue after
    midnight Pacific time".
- **Other HTTP errors:** these count attempts as now. An expired or stale session URL (`404`/`410` on the session)
  starts the upload again from `start`, keeping `videoId` empty.

### Streaming (D2)

- **Same code on Workers and Node:** `fetch(link, { headers: { Range } })` gives a body that is passed as the
  upload's body, with `Content-Length` set. No JavaScript reads the bytes.
- **The first plan task proves the cost on Cloudflare:** an upload of at least 200 MB in the cron Worker, recording
  its CPU time and wall time.
- **Spike deferred, not measured:** the spike (plan Task 1) needs the owner's Cloudflare login and a deploy outside
  the worktree, so it wasn't run and the cost of streaming on Workers is **not measured**. Streaming stays the
  default and chunk mode is built and tested, behind `YOUTUBE_UPLOAD_MODE=chunk` (an operator's switch, set on the
  cron Worker; see `site/docs/configuration.md`). If an upload fails on the CPU limit, set the variable and redeploy.
- **Fallback:** if the CPU time exceeds what the plan allows (the free plan's limit), `check` instead sends
  `CHUNK_BYTES` (8 MiB, a multiple of 256 KiB) per request, as many as fit in `UPLOAD_BUDGET_S`. Nothing else changes.

## 3. Surfaces

### App (PWA)

- **Item and draft editor for a YouTube channel:**
  - the video;
  - **Title**, required, with a counter to 100;
  - **Description**, the caption field;
  - **Settings:** made for kids, public or unlisted, tags and category;
  - **Languages:** the post's language, the audio language, and **Add a language**. Each added language has a
    title, a description and an optional subtitle file;
  - **Thumbnail:** optional.
- **Approval screen:** before the passkey, it lists everything the approval covers: the title, description, each
  translation, the subtitle files by language, the thumbnail, and the settings.
- **Item page:** the job's progress, then the link once it is out. The steps read:
  - "Uploading, 40%" (from offset ÷ size);
  - "Adding subtitles";
  - "YouTube is processing";
  - "Ready: goes public at 18:00";
  - "Private: needs YouTube's audit".

  The results tab works as it does for a Reel.
- **Channel stats and lists:** Bongsu and manual uploads appear together, with the D6 marker. Video pages for manual
  uploads are unchanged.
- **Text:** new strings go in `i18n.ts`.

### Dashboard

- The channel's settings get **YouTube defaults**: made for kids and category.
- No new OAuth scope: `youtube.force-ssl` already covers `videos.insert`, `captions.insert` and `thumbnails.set`.
- The guide link explains the audit.

### Agents, API, CLI

- **Writing:** `plan_add`, `plan_update` and `create_draft` accept `texts`, checked by `checkTexts`. They also accept
  the options in §1.
- **Reading:** `get_item` and the drafts list return `texts`.
- **Approvals:** changing `texts` voids the approval, as a caption change does.
- **CLI:** `bongsu texts` gains `--title <text>` and `--translation <lang> --title <text> --description <text>`.

### Inbox drafts

`inbox/<project>/<post>/` holds the video plus any of:

- `caption.txt`;
- `title.txt`;
- `caption.<lang>.txt` and `title.<lang>.txt` (a translation needs both);
- `<lang>.srt` or `<lang>.vtt`;
- `thumbnail.jpg` or `thumbnail.png`.

A single `<name>.mp4` also takes `<name>.title.txt`. The draft's `texts` are built from these files.

## 4. Migration, tests, docs

- **Migration 0024** (neutral schema, generated for SQLite and Postgres; no backfill): `plan_items.texts` (json),
  `drafts.texts` (json), `approvals.texts_sha` (text).
- **Fake world** (`apps/cloudflare/test/world.ts`): YouTube's resumable upload with offsets and a cut-off body,
  processing states, `rejected`, a video kept private (audit), `quotaExceeded`, captions, thumbnails, `videos.delete`.
- **Tests** (Cloudflare):
  - the 6 h start, the waiting unseen until the due time, publish and the first comment;
  - a resumed upload, a pause, a revoked or stale approval;
  - a text-only edit (update) against a video edit (re-upload);
  - removal (delete), the locked-private failure, quota waiting;
  - D6 dedupe in stats and the calendar.
- **Approval tests:** a changed title, translation, subtitle file or thumbnail needs a new approval; agent keys still
  can't approve.
- **Isolation (`workspaces.test.ts`):** channels, uploads, `bongsuVideos` and stats stay in their workspace, and the
  new texts never cross.
- **Core unit tests:** `checkTexts`, `textsSha` canonical form, `mediaRoles`, and the permalink rule.
- **Docs:**
  - `site/docs/youtube.md`: uploads, the audit and how it shows, quotas (about 100 uploads a day; 400 units a
    subtitle track), inbox names, the 6 h lead;
  - `site/docs/the-app.md`;
  - `site/docs/what-agents-can-do.md` and `site/docs/api-reference.md`;
  - `site/docs/cli.md`;
  - `docs/schema.md`, regenerated;
  - `docs/PLAN.md`'s box for #31;
  - the changeset.

## Out of scope

- A thumbnail per language, and extra audio tracks or dubs: YouTube Studio only, not in the Data API.
- Cross-posting one draft to several networks (#30).
- YouTube's own scheduled publishing (`publishAt`) for Bongsu's uploads (D1).
- Premieres, playlists, end screens and cards.
