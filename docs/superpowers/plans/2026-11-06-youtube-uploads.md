# YouTube uploads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bongsu plans, approves and publishes YouTube videos (Shorts and long videos) with a title, settings,
translations, subtitle files and a thumbnail, and shows its own uploads beside the channel's other uploads without
counting them twice.

**Architecture:** YouTube becomes a publishing platform (`formats: ["video"]`) with an upload lead of 6 h. The
provider's `start`/`check`/`finish` run a resumable upload through phases kept in `payload.step.data`. The tick starts
such jobs early, uploads them as private, waits until the due time, checks everything again and then makes the video
public or unlisted. The texts (title, languages, tags, translations) are one JSON column fingerprinted by
`approvals.texts_sha`. Subtitle files and the thumbnail are media files beside the video, so the existing media
fingerprints cover them.

**Tech Stack:** TypeScript, Hono, D1/SQLite + Postgres via the `Db` port, Vitest + the fake world
(`apps/cloudflare/test/world.ts`), React (PWA, dashboard), esbuild CLI.

**Spec:** `docs/superpowers/specs/2026-11-06-youtube-uploads-design.md` (read it with this plan; decisions D1–D6
are there).

## Global Constraints

- Node 22: `export PATH=$HOME/.nvm/versions/node/v22.14.0/bin:$PATH` before any `pnpm`, `git commit` (hooks) or test.
- `core` and `api` stay runtime-independent: no Cloudflare or Node imports; fetch and the clock are passed in.
- Portable SQL only (no `json_each`, `unixepoch()`…); `packages/core/test/portable-sql.test.ts` must stay green.
- Every plan-data query acting for a caller filters by `c.caller.workspaceId`; new routes get a case in
  `apps/cloudflare/test/workspaces.test.ts`.
- Approval stays human: nothing reachable with an agent key approves, resumes or publishes.
- No personal data: demo accounts (`demo_travel`, `demo_running`, a demo channel such as `demo_channel`) and
  `example.com` only.
- Conventional Commits, lowercase subject, at most 100 characters, body `Refs #31`, trailer
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never `--no-verify`.
- Run the tests you touched locally (`pnpm --filter <pkg> exec vitest run <file>`); CI runs the whole suite.
- Exact values from the spec: lead `21600` s; title 1–100 characters; description ≤ 5000; tags ≤ 500 as YouTube
  counts them; language pattern `^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$`; category `^[0-9]{1,3}$`, default `"22"`; privacy
  `"public" | "unlisted"`, default `"public"`; thumbnail ≤ 50 MB (`52428800` bytes); `UPLOAD_BUDGET_S = 180`;
  `CHUNK_BYTES = 8 * 1024 * 1024`; Shorts permalink when ≤ 180 s and vertical; quota resets at midnight
  `America/Los_Angeles`.
- Copy fixed by the spec, verbatim:
  - "Instagram posts have no title or translations" (written as `${platform.name} posts have no title or translations`);
  - "<name> isn't a video, a subtitle file (<lang>.srt or .vtt) or thumbnail.jpg/png";
  - "YouTube keeps this video private until your Google project passes YouTube's audit (see the YouTube guide)";
  - "YouTube's daily quota is used up: uploads continue after midnight Pacific time";
  - progress: "Uploading, 40%", "Adding subtitles", "YouTube is processing", "Ready: goes public at 18:00",
    "Private: needs YouTube's audit".

## Decisions this plan adds (beyond the spec)

- **`checkTexts` lives in `packages/core/src/formats/youtube-texts.ts`,** not `texts/youtube.ts`: `texts/` holds
  notification copy. `TextsError` moves from `data.ts` to `formats/texts.ts` and `data.ts` re-exports it, so every
  existing `catch (e instanceof TextsError)` keeps working and there is one class.
- **A title may be empty while editing;** only approval requires it ("a YouTube video needs a title"). Over 100
  characters is refused on write.
- **Subtitles and a thumbnail come only with draft-made items** (`content = 'db'`: the app's inbox, `create_draft`).
  A repo item made with `plan_add` is the single video file, as a Reel is.
- **The upload PUT is cut off with `AbortSignal.timeout(UPLOAD_BUDGET_S * 1000)`.** A cut-off is normal: the next run
  asks YouTube for the offset it kept.
- **Active jobs** are selected with `due_at <= now + MAX_LEAD_S` (the largest `uploadLeadS` of any platform), then
  filtered in code by `due_at - leadOf(job) <= now`, sorted with upload steps last, then cut to `jobsPerTick`.
  `leadOf` reads the job's account (`payload.username`) platform.
- **A private video is deleted only when its item is gone** (`recheck`: "removed from the plan"). A job refused for a
  reschedule or a changed text keeps its video and `step`, so the next approval revises it instead of uploading again.
- **`Provider.start(post, previous?)`:** the tick passes the job's earlier `step` when it has a `videoId`. The
  provider decides between revising (same video checksum) and replacing (delete, upload again).
- **`OutgoingMedia` gains `name` and `checksum`** so the provider can tell the roles apart and compare files.

## Review Focus

1. **A due time inside the lead** (approved 2 h before it's due): the upload starts on the next run and goes public at
   the due time if processing is done. If not, it goes public on the first run after processing ends, while within
   `CATCH_UP_S`. Test in Task 11: "approved inside the lead uploads at once and publishes when processed".
2. **An edit between the upload and the due time** (title changed, not approved again): the job must not make it
   public. It is refused at the due-time check, and the video stays private. Test in Task 11: "a title changed after
   the upload is refused at the due time and stays private".
3. **A huge file with a run cut off twice:** progress resumes from YouTube's offset and never restarts from 0. Test in
   Task 9: "an upload cut off twice resumes from the offset each time".
4. **Two subtitle files for one language** (`es.srt` and `es.vtt`), or a `thumbnail.png` beside a `thumbnail.jpg`:
   both are refused at approval with a clear message, not silently picked. Test in Task 4: `mediaRoles` "refuses two
   tracks for one language" and "refuses a second thumbnail".
5. **Pausing the workspace during the waiting phase:** the video stays private past its time, and resuming inside
   `CATCH_UP_S` publishes it. Test in Task 11: "a paused workspace's ready video stays private and goes out after
   resume".

---

### Task 1: Spike: the cost of streaming on the cron Worker (throwaway, needs the owner)

Answers D2's open question before any upload code exists. Nothing from this task is kept except the recorded answer.

**Files:**
- Create (scratchpad only, not committed): `<scratchpad>/stream-spike/worker.ts`, `<scratchpad>/stream-spike/wrangler.toml`
- Modify: `docs/superpowers/specs/2026-11-06-youtube-uploads-design.md` (the "Streaming (D2)" section: the result)

**Interfaces:** none produced. The result decides whether Task 9 uses `stream` mode (default) or `chunk` mode.

- [ ] **Step 1: Write the spike Worker.** It has a `scheduled` handler and a `fetch` handler that runs the same
  function. That function:
  1. fetches `https://speed.cloudflare.com/__down?bytes=209715200` (200 MiB) with `Range: bytes=0-`;
  2. `PUT`s the response body to `https://speed.cloudflare.com/__up` with `Content-Length: 209715200`;
  3. logs the wall time.

  No JavaScript touches the bytes: the response's `body` is passed as the request's `body`.
- [ ] **Step 2: Ask the owner to deploy it.** They log in themselves (`! npx wrangler login`), then run
  `npx wrangler deploy` from the spike folder. It goes on their free account under a throwaway name
  (`bongsu-stream-spike`). Trigger it once through `fetch` and once through a one-minute cron.
- [ ] **Step 3: Read CPU time and wall time** from Workers Logs (Observability → the invocation's `cpuTime`,
  `wallTime`). Expected: CPU well under 10 ms (the body is piped natively), wall time in tens of seconds.
- [ ] **Step 4: Record the result** in the spec's D2 section: CPU ms, wall s, and the decision.
  - CPU under 10 ms: stream.
  - Otherwise: chunk with `CHUNK_BYTES`.

  Then ask the owner to delete the spike Worker (`npx wrangler delete bongsu-stream-spike`).
- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-11-06-youtube-uploads-design.md
git commit -m "docs(docs): record the streaming cost on the cron worker" -m "Refs #31"
```

If the owner can't run it now, record "not measured: stream by default, chunk mode behind `YOUTUBE_UPLOAD_MODE=chunk`"
and go on. Task 9 then implements both modes (see its Step 3).

---

### Task 2: Migration 0024 and the approval's texts fingerprint in the data layer

**Files:**
- Create: `packages/schema/src/migrations/0024_youtube_texts.ts`
- Modify: `packages/schema/src/migrations/index.ts`; generated `migrations/sqlite/0024_youtube_texts.sql`,
  `migrations/postgres/…`, `docs/schema.md` (`pnpm --filter @bongsu/schema generate`)
- Modify: `packages/core/src/data.ts` (`PlanItem.texts`, `ApprovalRow.texts_sha`, `toApproval`, `addApproval`,
  `readText`, `contentPaths`)
- Modify: `packages/core/src/formats/approved.ts` (`Approval.textsSha256`, `canonicalJson`, `textsSha`)
- Test: `packages/core/test/approved.test.ts` (create if absent), `apps/cloudflare/test/youtube-uploads.test.ts` (create)

**Interfaces:**
- Produces:
  - `PlanItem.texts?: string | null` (JSON text).
  - `Approval.textsSha256?: string | null`.
  - `addApproval(db, { …, textsSha256?: string | null })`.
  - `canonicalJson(v: unknown): string`: keys sorted at every level, no whitespace.
  - `textsSha(texts: object | null): Promise<string | null>`: `sha256Hex(canonicalJson(texts))`, or null.
  - `contentPaths(...).texts === \`db:texts:${key}\``.
  - `readText(db, "db:texts:<key>")` returns the column's JSON text or null.

- [ ] **Step 1: Write the failing tests.**
  - `approved.test.ts`:
    - "canonicalJson sorts keys at every level": `canonicalJson({b:1,a:{d:[2,{z:1,y:2}],c:null}})` →
      `'{"a":{"c":null,"d":[2,{"y":2,"z":1}]},"b":1}'`;
    - "textsSha is null without texts and stable under key order":
      `textsSha(null) === null`, and `await textsSha({title:"A",tags:["x"]}) === await textsSha({tags:["x"],title:"A"})`.
  - `youtube-uploads.test.ts`: "an approval keeps its texts fingerprint". `addApproval` with
    `textsSha256: "f".repeat(64)`; `latestApprovals` returns it; an approval without one returns `null`.
- [ ] **Step 2: Run and see them fail.**
  `pnpm --filter @bongsu/core exec vitest run test/approved.test.ts` and
  `pnpm --filter @bongsu/cloudflare exec vitest run test/youtube-uploads.test.ts`. Expected: FAIL (missing exports and
  columns).
- [ ] **Step 3: Write the migration.** It has three `addColumn` steps:
  - `plan_items.texts`, json: "a YouTube video's title, languages, tags and translations (JSON); NULL: none";
  - `drafts.texts`, json: same description;
  - `approvals.texts_sha`, text: "sha256 of the approved texts in canonical JSON; NULL: none".

  Register it as `{ name: "0024_youtube_texts", steps: youtubeTexts }` and run the generator.
- [ ] **Step 4: Implement the data changes.** `readText`'s pattern becomes `^db:(caption|comment2|comment|alt|texts):(.+)$`.
  `addApproval` binds `texts_sha` as `?12`.
- [ ] **Step 5: Run the tests, the schema package and portable SQL.**
  - `pnpm --filter @bongsu/schema test`
  - `pnpm --filter @bongsu/core exec vitest run test/approved.test.ts test/portable-sql.test.ts`
  - `pnpm --filter @bongsu/cloudflare exec vitest run test/youtube-uploads.test.ts test/db-conformance.test.ts`

  Expected: PASS.
- [ ] **Step 6: Commit** `feat(schema,core): texts columns and the approval's texts fingerprint`.

---

### Task 3: YouTube texts: `checkTexts`

**Files:**
- Create: `packages/core/src/formats/youtube-texts.ts`
- Modify: `packages/core/src/formats/texts.ts` (`TextsError` moves here); `packages/core/src/data.ts`
  (`export { TextsError } from "./formats/texts"`, own class removed)
- Test: `packages/core/test/youtube-texts.test.ts`

**Interfaces:**
- Consumes: `Platform` (platforms/types.ts).
- Produces:
  ```ts
  export interface Translation { title: string; description: string }
  export interface YouTubeTexts {
    title: string; language?: string; audioLanguage?: string; tags?: string[];
    translations?: Record<string, Translation>;
  }
  export const LANG: RegExp;                       // ^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$
  export function tagsLength(tags: string[]): number;
  export function checkTexts(p: Platform, raw: unknown): YouTubeTexts | null;   // throws TextsError
  export function parseTexts(json: string | null | undefined): YouTubeTexts | null; // stored JSON → object (bad JSON: null)
  ```
  `checkTexts` returns null for `null`/`undefined`. On a platform other than YouTube a non-null value throws
  `${p.name} posts have no title or translations`. It normalizes: CRLF → LF; title and descriptions trimmed; empty
  optional fields dropped; tags trimmed, empty ones dropped.

- [ ] **Step 1: Write the failing tests** (one `it` each, using `youtube` and `instagram` from `platforms/`):
  - "null stays null": `checkTexts(youtube, null) === null`.
  - "Instagram refuses texts": throws `"Instagram posts have no title or translations"`.
  - "a title over 100 characters is refused" (`"x".repeat(101)`); "an empty title is kept as empty" (`{title:" "}` → `{title:""}`).
  - "a bad language tag is refused" (`language: "EN"`, `audioLanguage: "e"`).
  - "a translation needs a title of 1–100 and a description of at most 5000".
  - "a translation in the post's own language is refused" (`language:"en"`, `translations:{en:…}`).
  - "angle brackets are refused in titles and translations" (`title: "a <b>"`).
  - "tags count as YouTube counts them": `tagsLength(["a b","cd"]) === 5 + 2 + 1` (the quotes plus one separator);
    a set over 500 is refused.
  - "unknown fields are refused" (`{title:"a", foo:1}` → throws `unknown field foo`).
- [ ] **Step 2: Run them and see them fail:** `pnpm --filter @bongsu/core exec vitest run test/youtube-texts.test.ts`.
- [ ] **Step 3: Implement**, with a message per rule that names the field (e.g. `translations.es.title: 1–100
  characters`).
- [ ] **Step 4: Run** the new test plus `test/texts.test.ts` (if it exists) and `pnpm --filter @bongsu/core typecheck`.
  Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): check a youtube video's title, languages, tags and translations`.

---

### Task 4: The YouTube platform: formats, options, lead, lint, media roles, permalink

**Files:**
- Modify: `packages/core/src/platforms/types.ts` (`uploadLeadS?: number` on `Platform`; `MAX_LEAD_S` helper in
  `platforms/index.ts`)
- Modify: `packages/core/src/platforms/youtube.ts`
- Test: `packages/core/test/platform-youtube.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // platforms/youtube.ts
  export const THUMBNAIL_MAX = 52428800;
  export interface RoleEntry<T> { name: string; mime: string; size: number; ref: T }
  export interface MediaRoles<T> { video: T; subtitles: { lang: string; ref: T }[]; thumbnail?: T }
  export class MediaRolesError extends Error {}
  export function mediaRoles<T>(entries: RoleEntry<T>[]): MediaRoles<T>;          // throws MediaRolesError
  export function youtubePermalink(id: string, seconds: number | null, width: number | null, height: number | null): string;
  export interface YouTubeSettings { madeForKids: boolean; privacy: "public" | "unlisted"; category: string }
  export function youtubeSettings(options: Record<string, unknown>, accountSettings: Record<string, unknown>): YouTubeSettings;
  // platforms/index.ts
  export const MAX_LEAD_S: number;   // max uploadLeadS over platforms() (21600)
  export function leadOf(platformId: string | null | undefined): number; // 0 when none
  ```
  - `youtube`: `formats: ["video"]`, `uploadLeadS: 21600`.
  - Options:
    - `{key:"madeForKids", type:"boolean", label:"Made for kids"}`;
    - `{key:"privacy", type:"string", label:"Visibility", pattern:/^(public|unlisted)$/}`;
    - `{key:"category", type:"string", label:"Category", pattern:/^[0-9]{1,3}$/}`.
  - `lint(caption)` returns FAIL `{check:"Length"}` over 5000 and FAIL `{check:"Angle brackets"}` on `/[<>]/`, else
    `[]`.
  - `youtubeSettings` falls back from the option to `accountSettings.youtube.{madeForKids,category}`, then to
    `false`/`"22"`. Privacy defaults to `"public"`.

- [ ] **Step 1: Write the failing tests:**
  - "YouTube publishes videos with a 6 h lead": `youtube.formats` equals `["video"]`, `leadOf("youtube") === 21600`,
    `leadOf("instagram") === 0`.
  - "options are validated": `validateOptions(youtube,"video",{privacy:"private"})` throws;
    `{category:"1000"}` throws; `{madeForKids:true, privacy:"unlisted", category:"10"}` passes.
  - "the description check": a 5001-character caption → one FAIL; `"a <b>"` → FAIL; `"ok"` → `[]`.
  - mediaRoles:
    - "picks the video, subtitles by language and the thumbnail": `[clip.mp4 video/mp4, es.srt, pt-BR.vtt, thumbnail.jpg]`;
    - "refuses two tracks for one language" (`es.srt` + `es.vtt`);
    - "refuses a second thumbnail";
    - "refuses a thumbnail over 50 MB" (size `52428801`);
    - "refuses any other file": `notes.txt` → message exactly
      `notes.txt isn't a video, a subtitle file (<lang>.srt or .vtt) or thumbnail.jpg/png`;
    - "needs exactly one video" (none → `no video`; two → `one video per post`).
  - permalink: `youtubePermalink("abc",180,1080,1920)` → `https://youtube.com/shorts/abc`; `(181,…)` and
    `(60,1920,1080)` → `https://youtube.com/watch?v=abc`; null dimensions → `watch`.
  - settings: channel defaults apply; an option wins over the channel default.
- [ ] **Step 2: Run and see them fail:** `pnpm --filter @bongsu/core exec vitest run test/platform-youtube.test.ts`.
- [ ] **Step 3: Implement.** Update the header comment of `youtube.ts`: it publishes now.
- [ ] **Step 4: Run** the new test plus the existing platform tests:
  `pnpm --filter @bongsu/core exec vitest run test/platform` and
  `pnpm --filter @bongsu/cloudflare exec vitest run test/tick.test.ts test/phase14.test.ts`. YouTube channels are now
  discovered: fix any test that assumed they aren't by planning nothing for them, not by changing the rule. Expected:
  PASS.
- [ ] **Step 5: Commit** `feat(core): youtube as a publishing platform: formats, options, lead and media roles`.

---

### Task 5: Approving a YouTube video

**Files:**
- Modify: `packages/api/src/pwa/approve.ts` (`Resolved.youtube`, problems, `Snapshot.textsSha256`, match, `writeApproval`)
- Modify: `packages/core/src/tick.ts` (`Payload.textsPath`, `Payload.approval.textsSha256`, `withApproval`, `discover`, `verify`)
- Test: `apps/cloudflare/test/youtube-approvals.test.ts` (create)

**Interfaces:**
- Consumes:
  - from Task 2: `textsSha`, `readText("db:texts:…")`, `contentPaths().texts`;
  - from Task 3: `parseTexts`, `checkTexts`;
  - from Task 4: `mediaRoles`, `youtubeSettings`.
- Produces:
  - `Resolved.youtube: { texts: YouTubeTexts | null; subtitles: { lang: string; name: string }[]; thumbnail: string | null; settings: YouTubeSettings } | null`
    (null off YouTube).
  - `Snapshot.textsSha256: string | null`.
  - `verify(...)` also returns `texts: YouTubeTexts | null`. On a mismatch, `problem` is
    `"the title or translations changed after approval"`.

- [ ] **Step 1: Write the failing tests.** Seed the rows directly (Task 7's draft scheduling comes later). Use the
  fake world's YouTube channel; the item is a draft-made one
  (`content='db'`) with media `[clip.mp4, es.srt, thumbnail.jpg]` and texts `{title:"Demo", translations:{es:…}}`.
  Approve through the app's passkey helper, as `release.test.ts` does.
  - "a YouTube video without a title can't be approved": `/app-api/item` problems include
    `a YouTube video needs a title`.
  - "the approval shows everything it covers": the `youtube` block lists `es` subtitles, `thumbnail.jpg` and settings.
  - "a changed title needs a new approval": after approving, change texts → `approved.matches === false`.
  - "a changed translation, subtitle file or thumbnail needs a new approval" (texts edit; then a store checksum change
    for `es.srt`; then for `thumbnail.jpg`).
  - "the tick refuses a texts change": after approving, change the title in the DB and run the tick at
    `due − 21600` → job `refused`, `last_error` `the title or translations changed after approval`.
  - "an agent key can't approve a YouTube video": `POST /v1/...approve` with an agent key → 401 or 404, as the
    existing agent-approve test expects.
  - "an Instagram approval stores no texts fingerprint": `texts_sha IS NULL`.
- [ ] **Step 2: Run and see them fail:**
  `pnpm --filter @bongsu/cloudflare exec vitest run test/youtube-approvals.test.ts`.
- [ ] **Step 3: Implement `resolveItem`** for a YouTube account:
  - read the texts with the other texts;
  - skip the `mediaMax` count;
  - add `mediaRoles` errors, `checkTexts` errors and an empty title as problems.

  Then:
  - `snapshot` adds `textsSha256: await textsSha(r.youtube?.texts ?? null)`;
  - the match compares `(a.textsSha256 ?? null) === snap.textsSha256` as part of `same`;
  - `writeApproval` passes it on.
- [ ] **Step 4: Implement the tick side.**
  - `discover` sets `textsPath: paths.texts`.
  - `withApproval` copies `textsSha256`.
  - `verify` reads `p.textsPath` when the approval has a texts sha, or when the item has texts. It compares
    `textsSha(parseTexts(raw))`. An Instagram job's `textsSha256` is null and its texts are null: no change.
- [ ] **Step 5: Run** the new test plus `test/release.test.ts test/security.test.ts test/tick.test.ts`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(core,api): approve a youtube video's texts, subtitles and thumbnail`.

---

### Task 6: Writing texts through the agent API and MCP

**Files:**
- Modify:
  - `packages/core/src/data.ts`: `writeTexts` takes `captionMax` (default 2200); new `writeYouTubeTexts`.
  - `packages/api/src/agent/ops.ts`: `planAdd`, `planUpdate`, `createDraft`, `item`, `listDrafts`, `accountIds`.
  - `packages/api/src/agent/tools.ts`: MCP schemas `texts`, `options`.
  - `packages/api/src/agent/routes.ts`: only if a route lists body fields.
- Test: `apps/cloudflare/test/youtube-api.test.ts` (create); `apps/cloudflare/test/workspaces.test.ts` (extend)

**Interfaces:**
- Consumes: `checkTexts` (Task 3), the platform (Task 4).
- Produces:
  - `writeYouTubeTexts(db: Db, key: string, texts: YouTubeTexts | null, by: string, nowS: number): Promise<void>`. It
    sets `plan_items.texts`, `texts_at` and `texts_by`.
  - The API answers: `item()` and `listDrafts()` include `texts: YouTubeTexts | null`.
  - `createDraft` stores `drafts.texts`.
  - `planAdd`/`planUpdate` return `texts` (the list of changed fields) with `"texts"` included when given.

- [ ] **Step 1: Write the failing tests.**
  - "plan_add and plan_update take texts for a YouTube channel": the stored JSON is normalized, and a 101-character
    title → 400 with `title`.
  - "a YouTube description may be 5000 characters": `caption` of 5000 → 200; 5001 → 400.
  - "Instagram refuses texts": 400 `Instagram posts have no title or translations`.
  - "create_draft takes a YouTube channel, texts and options"; "get_item and the drafts list return texts".
  - "changing texts voids the approval": approve, then `plan_update {texts}` → the answer's note says approve again;
    `/app-api/item` `approved.matches === false`.
  - "YouTube options are validated": `options:{privacy:"private"}` → 400.
  - In `workspaces.test.ts`: "another workspace can't read or write an item's texts". `get_item` and `plan_update`
    with the other workspace's key on a `demo_channel` item → 404; the drafts list doesn't show its texts.
- [ ] **Step 2: Run and see them fail:**
  `pnpm --filter @bongsu/cloudflare exec vitest run test/youtube-api.test.ts test/workspaces.test.ts`.
- [ ] **Step 3: Implement.**
  - `accountIds(c)` uses every account whose platform has formats.
  - `TextsError` → `ApiError(400)`.
  - The caption max comes from `platform.limits.captionMax`.
- [ ] **Step 4: Run the tests** plus `test/api.test.ts test/cli-api.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): agents write a youtube video's title, translations and settings`.

---

### Task 7: The app's routes: texts, settings, drafts to YouTube

**Files:**
- Modify:
  - `packages/api/src/pwa/schedule.ts`:
    - `scheduleDraft`: YouTube channels; copy `drafts.texts` and `texts` from the body; options;
    - `editTexts`: `texts`, caption max per platform.
  - `packages/api/src/pwa/routes.ts`:
    - `POST /app-api/item/youtube`: the settings, through `validateOptions` and the existing option setter;
    - `/app-api/drafts` returns texts.
- Test: `apps/cloudflare/test/youtube-app.test.ts` (create); `apps/cloudflare/test/workspaces.test.ts` (extend)

**Interfaces:**
- Consumes: `writeYouTubeTexts` (Task 6), `checkTexts` (Task 3).
- Produces:
  - `POST /app-api/item/youtube {key, madeForKids?, privacy?, category?}` → the item. `null` clears a value.
  - `POST /app-api/item/texts` accepts `texts`.
  - `POST /app-api/drafts/:id/schedule` accepts `texts` and `options`.

- [ ] **Step 1: Write the failing tests.**
  - "a video draft schedules to a YouTube channel with its texts and files": the item has `content='db'`, its
    `media` includes the `.srt` and the thumbnail, and its `texts` come from the draft.
  - "a YouTube draft needs a title only at approval": scheduling without one works; `/app-api/item` lists the problem.
  - "the app edits a YouTube video's texts and settings"; "editing voids the approval".
  - "settings are validated" (`privacy:"private"` → 400).
  - Isolation: "another workspace can't set a video's settings" → 404.
- [ ] **Step 2: Run and see them fail:**
  `pnpm --filter @bongsu/cloudflare exec vitest run test/youtube-app.test.ts test/workspaces.test.ts`.
- [ ] **Step 3: Implement.** `scheduleDraft`'s account check uses `listAccounts(..., {workspaceId})` filtered to
  platforms with formats. A YouTube draft's format is `"video"`. The slot check stays as it is (one post per hour
  per channel).
- [ ] **Step 4: Run the tests** plus `test/app.test.ts test/content.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): schedule and edit youtube videos in the app`.

---

### Task 8: Inbox drafts for YouTube

**Files:**
- Modify: `packages/core/src/inbox.ts` (`Item`, `inboxItems`, the draft insert, header comment)
- Test: `apps/cloudflare/test/inbox.test.ts` (extend)

**Interfaces:**
- Produces:
  - `inboxTexts(files: { name: string; text: string }[], stem: string | null): YouTubeTexts | null`. It is pure and
    exported for the test. It maps:
    - `title.txt` (or `<stem>.title.txt`) → title;
    - `caption.<lang>.txt` + `title.<lang>.txt` → `translations[lang]`.

    It returns null when no title or translation file is there.
  - A folder item's media keep `<lang>.srt|.vtt` and `thumbnail.jpg|png` beside the video. A single file
    `<name>.mp4` takes only `<name>.title.txt`.

- [ ] **Step 1: Write the failing tests.**
  - "a YouTube folder becomes a draft with its title, translations, subtitles and thumbnail".
    `inbox/demo/clip1/` holds `clip.mp4, caption.txt, title.txt, caption.es.txt, title.es.txt, es.srt, thumbnail.jpg`.
    The draft's `texts` are `{title, translations:{es:{title,description}}}`, and its media has 3 refs.
  - "a translation needs both files": only `title.es.txt` → no `es` translation, and the draft note says so.
  - "a single video takes its title file" (`clip.mp4` + `clip.title.txt`).
  - "an Instagram project is unchanged" (an existing case still passes, and `texts` is null).
- [ ] **Step 2: Run and see them fail:** `pnpm --filter @bongsu/cloudflare exec vitest run test/inbox.test.ts`.
- [ ] **Step 3: Implement.** Read the text files in the same pass as `caption.txt`, under the per-run subrequest
  budget. A folder with a video and `.srt`/`thumbnail.*` is a "reel" draft, not a carousel.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): inbox drafts with a youtube title, translations, subtitles and thumbnail`.

---

### Task 9: The YouTube client and the fake world's uploads

**Files:**
- Modify: `packages/core/src/clients/youtube.ts`
- Modify: `apps/cloudflare/test/world.ts`: YouTube upload state and endpoints
- Test: `apps/cloudflare/test/youtube-client.test.ts` (create)

**Interfaces:**
- Produces (on `class YouTube`):
  ```ts
  export class QuotaExceeded extends Error {}      // 403 quotaExceeded | uploadLimitExceeded
  export class SessionGone extends Error {}        // 404/410 on the session URL
  export interface VideoMeta { title; description; tags?; categoryId; defaultLanguage?; defaultAudioLanguage?;
    madeForKids: boolean; localizations?: Record<string, { title: string; description: string }> }
  export interface VideoState { uploadStatus: string; privacyStatus: string; rejectionReason?: string;
    failureReason?: string; seconds: number | null; width: number | null; height: number | null;
    status: Record<string, unknown> }
  startUpload(meta: VideoMeta, size: number, mime: string): Promise<string>;           // the session URL
  uploadOffset(session: string, size: number): Promise<{ offset: number; videoId?: string }>;
  uploadFrom(session: string, source: string, offset: number, size: number,
             o: { budgetMs: number; chunkBytes?: number }): Promise<{ offset: number; videoId?: string }>;
  videoState(id: string): Promise<VideoState | null>;   // part=status,processingDetails,fileDetails,contentDetails
  updateVideo(id: string, meta: VideoMeta, status: Record<string, unknown>): Promise<void>;
  setThumbnail(videoId: string, source: string): Promise<void>;
  insertCaption(videoId: string, lang: string, source: string, name: string): Promise<string>; // track id
  deleteCaption(trackId: string): Promise<void>;
  deleteVideo(id: string): Promise<void>;               // 404 counts as done
  ```
  - `uploadFrom` fetches `source` with `Range: bytes=<offset>-` (or one chunk's range) and PUTs it to the session
    with `Content-Range: bytes <offset>-<end>/<size>` and `Content-Length`, under
    `AbortSignal.timeout(budgetMs)`. On an abort it returns `uploadOffset(...)`.
  - The world gains:
    - `ytVideos: Map<id, {size, received, meta, status, processing: "processing"|"succeeded"|"failed"|"rejected", captions: Map<trackId,{lang}>, thumbnail?}>`;
    - `ytUploadCut: number | null`: bytes kept before cutting a PUT off;
    - `ytQuota: boolean`;
    - `ytKeepPrivate: boolean`: the audit lock;
    - endpoints: `POST /upload/youtube/v3/videos?uploadType=resumable`, `PUT <session>` (query and data),
      `GET/PUT/DELETE /youtube/v3/videos` for these ids, `POST /upload/youtube/v3/thumbnails/set`,
      `POST /upload/youtube/v3/captions`, `DELETE /youtube/v3/captions`.

    The existing `ytUploads` handlers stay for manual uploads.

- [ ] **Step 1: Write the failing tests** (the client against `new World().fetch`):
  - "a resumable upload sends the file and returns the video id";
  - "an upload cut off twice resumes from the offset each time": `ytUploadCut = size/3`, three `uploadFrom` calls, and
    the offsets grow strictly;
  - "quota exceeded throws QuotaExceeded";
  - "a gone session throws SessionGone";
  - "chunk mode sends 8 MiB pieces" (`chunkBytes: 8*1024*1024` with a 20 MiB source → three PUTs);
  - "captions, thumbnail, update and delete reach YouTube";
  - "videoState reports processing, rejected and dimensions".
- [ ] **Step 2: Run and see them fail:**
  `pnpm --filter @bongsu/cloudflare exec vitest run test/youtube-client.test.ts`.
- [ ] **Step 3: Implement the client and the world.** Chunk mode is used when the spike chose it, or when
  `env.YOUTUBE_UPLOAD_MODE === "chunk"`. The provider passes `chunkBytes` then.
- [ ] **Step 4: Run** the new test plus `test/phase14.test.ts test/release.test.ts` (the manual-upload handlers still
  work). Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): youtube resumable uploads, captions and thumbnails in the client`.

---

### Task 10: The provider: upload, extras, processing, publish, revise

**Files:**
- Modify: `packages/core/src/providers/types.ts`:
  - `OutgoingMedia` adds `name: string; checksum: string`;
  - `OutgoingPost` adds `texts?: YouTubeTexts | null` and `settings?: YouTubeSettings`;
  - `Provider.start(post, previous?: Step)`;
  - `Provider.discard?(step: Step): Promise<void>`.
- Modify: `packages/core/src/providers/youtube.ts`
- Modify: `packages/core/src/providers/instagram*.ts`: only the `start` signature, if TypeScript asks
- Test: `apps/cloudflare/test/youtube-provider.test.ts` (create)

**Interfaces:**
- Consumes: the client (Task 9), `mediaRoles`, `youtubePermalink` (Task 4).
- Produces:
  ```ts
  export interface UploadData { phase: "uploading" | "extras" | "processing" | "waiting"; session?: string; size: number;
    videoId?: string; videoChecksum: string; captions: Record<string, { trackId: string; md5: string }>;
    thumbnailMd5?: string; notBefore?: number; pending: { captions: string[]; dropCaptions: string[]; thumbnail: boolean };
    post: { media: OutgoingMedia[] } }        // the post's file links (re-signed by the tick each run)
  export class YouTubeLocked extends Error {}
  ```
  - `check` returns `{state:"ready"}` only from `waiting`.
  - `check` throws `QuotaExceeded`/`SessionGone` through to the tick (Task 12).
  - `finish` returns `Published` with the permalink rule, or throws `YouTubeLocked`.
  - `discard(step)` deletes `videoId` when present (best effort).
  - Revise, `start(post, previous)` with a `videoId`:
    - same `videoChecksum` → `updateVideo` (status stays private); `pending` lists only the changed or added
      caption langs (by md5), the dropped langs, and the thumbnail if its md5 changed; phase `extras`;
    - different `videoChecksum` → `deleteVideo`, then a fresh `start`.

- [ ] **Step 1: Write the failing tests** (the provider with a World channel):
  - "start opens a private session with the snippet, status and localizations": the world's session meta has
    `privacyStatus:"private"`, no `publishAt`, `selfDeclaredMadeForKids`, `categoryId:"22"`, `localizations.es`.
  - "check walks uploading → extras → processing → waiting": one caption track and a thumbnail land, each recorded
    once.
  - "a failed caption retry doesn't duplicate a track" (the world fails the second caption once).
  - "rejected processing fails the step with YouTube's reason".
  - "finish makes the video public or unlisted and keeps the other status fields".
  - "finish throws YouTubeLocked when YouTube keeps it private" (`ytKeepPrivate`).
  - "a vertical 60 s video's permalink is a Short".
  - "a refused thumbnail doesn't stop the video": the world answers `thumbnails.set` with 403. The step records
    `thumbnailRefused: true` and goes on to `processing`. Task 12 turns it into one Problems note.
  - "revising with the same video updates texts and replaces only the changed track".
  - "revising with another video deletes the old one and uploads again".
- [ ] **Step 2: Run and see them fail:**
  `pnpm --filter @bongsu/cloudflare exec vitest run test/youtube-provider.test.ts`.
- [ ] **Step 3: Implement.**
  - `finish` reads `videoState(id).status`, sets `privacyStatus` to `post.settings.privacy` (kept in
    `step.data.privacy` at start), writes the whole status back, then reads it again.
  - The comment at the top of `providers/youtube.ts` says it uploads now.
- [ ] **Step 4: Run** the new test plus `test/providers.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(providers): upload, process and publish a youtube video, and revise it`.

---

### Task 11: The tick: the lead, the order, waiting for the due time

**Files:**
- Modify: `packages/core/src/tick.ts`:
  - `tick`: active-job selection;
  - `discover`: the lead;
  - `stepPending`: names and checksums into `OutgoingMedia`, texts and settings into the post, `previous`;
  - `stepContainer`: ready before due → wait, recheck and re-verify at due.
- Modify: `packages/core/src/data.ts` (`dueItems(db, account, nowS, leadS = 0)`: `due_at <= nowS + leadS`)
- Test: `apps/cloudflare/test/youtube-uploads.test.ts` (extend)

**Interfaces:**
- Consumes: `leadOf`, `MAX_LEAD_S` (Task 4), provider (Task 10), `verify` texts (Task 5).
- Produces:
  - `isUploadStep(job: JobRow, p: Payload): boolean`: `container_created` with `p.step?.data.phase === "uploading"`.
  - Each run advances the other jobs first and upload steps last, all within `jobsPerTick`.

- [ ] **Step 1: Write the failing tests.** A YouTube item is due at `T`; the world's clock moves.
  - "the upload starts 6 h ahead": at `T − 21601` there is no job; at `T − 21600` the job is `container_created`.
  - "the waiting is unseen until the due time": the runs while `waiting` keep `attempts === 0`, and nothing is public
    before `T`.
  - "at the due time it goes public and the first comment follows": the item is posted, with the permalink, then the
    comment.
  - "approved inside the lead uploads at once and publishes when processed".
  - "a title changed after the upload is refused at the due time and stays private".
  - "a paused workspace's ready video stays private and goes out after resume".
  - "an Instagram post isn't delayed by an upload": `JOBS_PER_TICK=1`, a Reel and an upload both active → the Reel
    advances.
  - "dry run uploads nothing": `DRY_RUN=1` → the dry-run note, and no session in the world.
- [ ] **Step 2: Run and see them fail:**
  `pnpm --filter @bongsu/cloudflare exec vitest run test/youtube-uploads.test.ts`.
- [ ] **Step 3: Implement.**
  - The active selection follows "Decisions this plan adds".
  - `stepContainer` at a ready step:
    - if `now < job.due_at`: run `recheck` (it settles a removed item, Task 12), save `{...p, step: next}`, and leave
      `attempts` alone;
    - at or after the due time: `recheck`, then `verify` again (refuse on a problem), then `publish`.
  - Links are re-signed each run: the tick rebuilds `post.media` URLs before `check`.
- [ ] **Step 4: Run** the new tests plus `test/tick.test.ts test/scenario.test.ts test/pause.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): start youtube uploads ahead and publish them at their time`.

---

### Task 12: The tick: edits after the upload, removal, quota, sessions, failures

**Files:**
- Modify: `packages/core/src/tick.ts`:
  - `reopen`: keep `step` when it has a `videoId`;
  - `settle`/`refuse`: discard on "removed from the plan";
  - `advance`: `QuotaExceeded`, `SessionGone`, `YouTubeLocked`.
- Modify: `packages/core/src/texts/notifications.ts`: `youtubeQuota`, `youtubeLocked`, plus `providerFailed` noting
  a kept private video.
- Test: `apps/cloudflare/test/youtube-uploads.test.ts` (extend)

**Interfaces:**
- Consumes: `Provider.discard`, `start(post, previous)` (Task 10).
- Produces:
  - Audit action `youtube_video_deleted` with `{ videoId }`.
  - `N.youtubeQuota()`: Problems group, deduped per workspace per Pacific day (key
    `youtube_quota:<workspace>:<YYYY-MM-DD>` in `settings`).
  - `N.youtubeLocked(key)`: Problems, the spec's text.
  - `N.youtubeThumbnailRefused(key)`: Problems, "YouTube refused the thumbnail: the channel needs YouTube's verified
    features (the video still goes out)". Sent once, when `step.data.thumbnailRefused` is first set.
  - `nextPacificMidnight(nowS: number): number` in `formats/time.ts`.

- [ ] **Step 1: Write the failing tests:**
  - "a texts-only edit after the upload updates the video": approve, upload, edit the title, approve again →
    `videos.update` was called, and no second session opened.
  - "a new video file uploads again": change the video's checksum and approve again → the old video was deleted and
    a new session opened.
  - "removing the item deletes the private video": `plan_remove` → the next run deletes it, with the audit row
    `youtube_video_deleted`.
  - "a reschedule keeps the private video for the next approval".
  - "quota waits until midnight Pacific without counting attempts": `ytQuota` → `step.data.notBefore` equals
    `nextPacificMidnight(now)`; `attempts === 0`; one Problems note over two runs.
  - "a gone session starts again from start" (the world forgets the session).
  - "the audit lock fails the job with its note" (`ytKeepPrivate`): state `failed`, and the note has the spec's text.
  - "a job that fails for good keeps its private video": three provider errors → `failed`, the video isn't deleted,
    and the note says it is there, private.
  - `formats/time` unit test (core): `nextPacificMidnight` across a DST change (2026-11-01).
- [ ] **Step 2: Run and see them fail:**
  `pnpm --filter @bongsu/cloudflare exec vitest run test/youtube-uploads.test.ts` and
  `pnpm --filter @bongsu/core exec vitest run test/time.test.ts`.
- [ ] **Step 3: Implement.** A job with `step.data.notBefore > now` is skipped in the active selection, without
  taking a slot.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): revise, delete and wait out quotas for youtube uploads`.

---

### Task 13: One video, one place: `bongsuVideos` in stats, calendar and the video page (D6)

**Files:**
- Create: `packages/core/src/youtube-videos.ts`
- Modify:
  - `packages/core/src/metrics.ts`: skip mapped `video:` candidates;
  - `packages/core/src/calendar.ts`;
  - `packages/api/src/agent/ops.ts`: `channelStats`, `performanceList`, `videoMetrics`, `statsOverview`;
  - `packages/web/src/App.tsx`: `#/video/<account>/<id>` redirects; list marker.
- Test: `apps/cloudflare/test/youtube-videos.test.ts` (create); `apps/cloudflare/test/workspaces.test.ts` (extend)

**Interfaces:**
- Produces: `bongsuVideos(db: Db, accountIds: string[], workspaceId: string): Promise<Map<string, string>>`, which maps
  a video id to an item key from jobs with `kind = 'video'` whose account is a channel's, using `jobs.media_id` or
  `payload.step.data.videoId`. It parses the payload in code (portable SQL). The API answers gain
  `source: "bongsu" | "elsewhere"` on video rows, and `/v1/videos/<id>` answers with `{ item: key }` for a mapped id.

- [ ] **Step 1: Write the failing tests:**
  - "the sampler doesn't start a video: series for a Bongsu upload": publish one through the tick, list it in the
    channel's uploads → no `video:<id>` sample, and the item's series grows.
  - "channel stats and the performance list show it once, marked Bongsu".
  - "the calendar shows the item, not a second entry".
  - "a manual upload keeps its video: page and series".
  - "moving a Bongsu upload's release date moves the item": the calendar's release move on a mapped id changes the
    plan item's time (so it needs approving again) and never calls `videos.update` with `publishAt`.
  - Isolation: "another workspace's channel uploads don't map to this workspace's items".
- [ ] **Step 2: Run and see them fail:**
  `pnpm --filter @bongsu/cloudflare exec vitest run test/youtube-videos.test.ts test/workspaces.test.ts`.
- [ ] **Step 3: Implement.** The sampler builds one map for every YouTube account it samples. It is a scheduler run,
  so it sees all workspaces and passes each account's workspace.
- [ ] **Step 4: Run** the tests plus `test/metrics.test.ts test/stats.test.ts test/agent-stats.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(core,api,web): count a youtube video bongsu uploaded once, under its item`.

---

### Task 14: The app (PWA): editor, approval screen, progress

Follow `packages/web/PRODUCT.md` and `DESIGN.md`.

**Files:**
- Modify: `packages/web/src/App.tsx`: item/draft editor for a YouTube channel, approval summary, item page progress
- Modify: `packages/web/src/i18n.ts`: every new string, in each locale the file has
- Modify: `packages/web/src/api.ts`: types for `youtube`, `texts`, `progress`
- Modify: `packages/api/src/pwa/routes.ts`: `/app-api/item` adds `progress`
- Create: `packages/core/src/upload-progress.ts`
- Test: `packages/core/test/upload-progress.test.ts`, `packages/web/test/i18n.test.ts` (the existing key check)

**Interfaces:**
- Produces:
  ```ts
  export type UploadProgress =
    | { phase: "uploading"; percent: number } | { phase: "extras" } | { phase: "processing" }
    | { phase: "ready"; at: number } | { phase: "locked" } | null;
  export function uploadProgress(job: { state: string; due_at: number; last_error: string | null; payload: string }): UploadProgress;
  ```
  The i18n keys are `upload.uploading` ("Uploading, {percent}%"), `upload.extras` ("Adding subtitles"),
  `upload.processing` ("YouTube is processing"), `upload.ready` ("Ready: goes public at {time}") and `upload.locked`
  ("Private: needs YouTube's audit").

- [ ] **Step 1: Write the failing tests.**
  - `upload-progress.test.ts`:
    - offset 40 of 100 → `{phase:"uploading", percent:40}`;
    - `waiting` → `{phase:"ready", at: due_at}`;
    - a failed job whose `last_error` starts with the audit text → `locked`;
    - an Instagram job → `null`.
  - The i18n test passes once the keys exist in every locale.
- [ ] **Step 2: Run and see them fail:**
  `pnpm --filter @bongsu/core exec vitest run test/upload-progress.test.ts` and
  `pnpm --filter @bongsu/web test`.
- [ ] **Step 3: Implement the editor** for a YouTube channel:
  - **Title**: required, with a counter to 100.
  - **Description**: the caption field, counter to 5000.
  - **Settings**: made for kids, public/unlisted, tags (chips; the 500 counter uses the same rule as `tagsLength`,
    imported from core), category (a select of YouTube's common categories, with the id stored).
  - **Languages**: the post's language, the audio language, and **Add a language**. Each language has a title, a
    description, and its subtitle file shown from the media.
  - **Thumbnail**: shows `thumbnail.*` from the media.

  New files are added through the existing upload flow, named `<lang>.srt` or `thumbnail.jpg`.
- [ ] **Step 4: Implement the approval screen** (lists title, description, each translation, subtitles by language,
  thumbnail, settings) and the item page progress line.
- [ ] **Step 5: Verify.** Run `pnpm --filter @bongsu/web test && pnpm --filter @bongsu/web build && pnpm typecheck`.
  Then run the app with the `run` skill against a seeded demo (dry run). Check by eye: the editor at phone width, the
  approval summary, and the progress line after one tick.
- [ ] **Step 6: Commit** `feat(web,api): edit, approve and follow a youtube upload in the app`.

---

### Task 15: Dashboard: a channel's YouTube defaults

**Files:**
- Modify: `packages/api/src/dashboard/routes.ts` (accept and return `youtube: {madeForKids, category}` on the
  account settings route, beside `captionRules`)
- Modify: `packages/dashboard/src/pages.tsx` (the channel's settings: two fields and the guide link about the audit)
- Test: `apps/cloudflare/test/dashboard.test.ts` (extend)

**Interfaces:**
- Produces: `accounts.settings.youtube = { madeForKids?: boolean; category?: string }`, validated with the same
  pattern as the option. A `null` field is dropped. This is what `youtubeSettings` (Task 4) reads.

- [ ] **Step 1: Write the failing tests:**
  - "the dashboard sets a channel's YouTube defaults";
  - "a bad category is refused";
  - "an Instagram account has no YouTube defaults" (400).
- [ ] **Step 2: Run and see them fail:**
  `pnpm --filter @bongsu/cloudflare exec vitest run test/dashboard.test.ts`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests plus `pnpm --filter @bongsu/dashboard build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(api,dashboard): a channel's youtube defaults`.

---

### Task 16: CLI: `--title` and `--translation`

**Files:**
- Modify: `packages/cli/src/commands/texts.ts`
- Test: `packages/cli/test/commands.test.ts` (extend)

**Interfaces:**
- Produces:
  - `bongsu texts set <key> --title <text>` and
    `--translation <lang> --title <text> --description <file|->`.

    `--title` after `--translation` belongs to the translation. The command sends
    `plan_update {key, texts}`, merged into `get`'s current texts.
  - `texts get` prints the title and the translations.

- [ ] **Step 1: Write the failing tests:**
  - "texts set --title sends the title";
  - "a translation needs both a title and a description";
  - "texts get prints translations".
- [ ] **Step 2: Run and see them fail:** `pnpm --filter @bongsu/cli test`.
- [ ] **Step 3: Implement.** Update the usage line.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(cli): set a youtube video's title and translations`.

---

### Task 17: Docs, the roadmap and the changeset

**Files:**
- Modify:
  - `site/docs/youtube.md`: uploads, the 6 h lead, the audit and how it shows, quotas (about 100 uploads a day; 400
    units a subtitle track), inbox names, what's out of scope;
  - `site/docs/the-app.md`;
  - `site/docs/what-agents-can-do.md`;
  - `site/docs/api-reference.md`;
  - `site/docs/cli.md`.
- Modify:
  - `docs/PLAN.md`: tick #31's box;
  - `README.md` and `AGENTS.md`'s first lines: "plus YouTube Shorts comments" becomes uploads too.
- Create: `.changeset/youtube-uploads.md` (minor for core, api, web, dashboard, cli, schema; follow an existing
  changeset's package names)
- Optional: `.trail/learnings/<date>-youtube-uploads-nyt87.md` (`graft note`), with what was decided and what to
  watch out for.

- [ ] **Step 1: Write the docs.** Use demo names and `example.com` only. Run `pnpm check-personal` if the owner's list
  is present.
- [ ] **Step 2: Verify.** Run `pnpm check && pnpm typecheck`, then `pnpm site` to build the docs nav. Expected: PASS.
- [ ] **Step 3: Commit** `docs(docs): youtube uploads, languages, subtitles and thumbnails`.

---

## Finishing

After Task 17: run the whole-branch review loop (Fable, until "No comments."), then
`pnpm check && pnpm typecheck` and the touched test files. Do not push or open the pull request until the owner says
so. The PR title will be `feat(core,api,web,dashboard,cli,schema): youtube uploads with languages and subtitles (#31)`,
with `Closes #31` in the body.
