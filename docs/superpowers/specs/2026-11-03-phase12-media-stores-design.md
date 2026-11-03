# Phase 12: media stores, set up from the dashboard

Issues: #15 (r2), #16 (s3), #17 (setup docs, the store's status), #32 (Connect Google Drive). Status: sections 1 and 2
approved in chat (2026-11-03); sections 3 and 4 proposed, waiting for review.

## Intent

Make Bongsu usable without Google for other self-hosters (the owner's answer: "other self-hosters" first). Success:
an instance gets its media store set up in the dashboard, with no secrets in the environment and no Google Cloud steps
unless it picks Drive, and every store passes the same conformance suite. Nothing is deployed and nobody uses Bongsu
yet, so nothing has to stay compatible with how stores are configured today.

## 1. Where the store is configured (approved)

**The database is the only place.** `MEDIA_STORE`, `DRIVE_SA_JSON` and `DRIVE_OWNER_OAUTH` leave `Env`, the example
files, the wrangler and Docker configs and the docs. The Drive service account goes too: Drive connects with the
owner's OAuth (section 3).

**What stays in the environment:** `MEDIA_DIR` on Node, which is what the server offers rather than a store setting.
The Node runtime registers `local` with that directory (`/media` in Docker), and the dashboard can only pick it. The
dashboard never takes a server path (an admin could otherwise point Bongsu at `/etc`).

**A new instance-wide table, `media_store`** (migration 0016, written once in `packages/schema`), one row:

| Column | |
|---|---|
| `id` | `"instance"`: one row per instance |
| `kind` | `drive`, `s3` or `local` |
| `settings` | JSON, nothing secret: S3 endpoint, region, bucket, prefix, path style; Drive's root folder name |
| `credentials` | encrypted with `ENCRYPTION_KEY`: the S3 key pair, or the Drive OAuth grant |
| `status` | `ok` / `broken` |
| `last_error`, `last_checked_at` | the last **Test**, keep-alive or failed use |
| `updated_at`, `updated_by` | |

Like `oauth_apps` it has no `workspace_id`: one store per instance (PLAN 2.4); stores per workspace or account stay out.

**Finding the store:** `mediaStore(env, fetcher)` becomes `async` and returns `MediaStore | null`: the row, built with
its decrypted credentials; for `local`, the store the runtime registered; `null` when there is no row. Requests read
it once each; the tick builds its store at the start of a run instead of in `Ctx`'s constructor.

**With no store:** the inbox and the cleanup skip; uploads answer 503; an item with media can't be approved (the
approval page says to set up a media store); `/health` reports `media_store: "missing"` and is not ok; Get started
shows the step as the next one.

**Changing it:** owners and admins (the `MANAGING` guard, `/admin-api/media-store`), with a fresh passkey (`FRESH_S`)
when the kind changes, because references to another store count as missing: the dashboard says how many waiting
approvals that voids. New credentials for the same kind keep the approvals.

## 2. The `s3` store (approved)

`packages/core/src/media/s3.ts`, web-standard only, signed with `aws4fetch` (new dependency: small, no dependencies,
signs requests and presigned URLs; hand-written SigV4 would be the riskier choice). One store for AWS S3, Cloudflare R2,
Backblaze B2, MinIO and the rest: the R2 Worker binding is dropped (it can't presign, and listing the inbox is one
request per 1,000 keys, so the free plan's 50 subrequests aren't a reason for it). #15 is retitled to say so.

Settings: endpoint, region, bucket, prefix (the store's root, optional), path style. The dashboard's presets fill them:
AWS S3, Cloudflare R2 (`https://<account>.r2.cloudflarestorage.com`, region `auto`), Backblaze B2, MinIO or other.

| Interface | S3 |
|---|---|
| ids | the object key under the prefix, as base64url: opaque, safe in URLs (`/m/`'s pattern). A folder is a key prefix ending in `/` |
| `stat` | `HEAD`: size, `Content-Type`, `Last-Modified`, the ETag as checksum; 404 → `null`. A folder: a one-key listing |
| `stream` | `GET` with the `Range` header passed through (S3 answers 206 itself) |
| `readText` | `GET`, the first 20,000 characters |
| `resolve` | `HEAD` the key, else a one-key listing under `path/` (a folder) |
| `list` | `ListObjectsV2`, `prefix` + `delimiter=/`, following continuation tokens; types from the extension |
| `ensureFolder` | an empty `path/` marker object, so empty folders show in consoles |
| `move` | copy each object (a folder: all under its prefix), then delete the originals once every copy succeeded; 403 → `MediaRefused` |
| `publicUrl` | a presigned `GET` for `ttlS` seconds: Instagram fetches the bucket directly |
| `createUpload` | a presigned `PUT` with the `Content-Type` signed; a short random suffix before the extension, so an upload never replaces a file |

**Ids change when a file moves.** That breaks the conformance case "move takes a folder with its contents" (same id
after), and the cleanup's comment ("the ids don't change"). Nothing needs an id after the cleanup's move (a day after
posting; only `stat` before publishing and the media links read ids), so the case changes to: the content is at the
new path. Keeping ids is a property of `drive` and `local`, documented, not required.

Limits, documented: moving a file by hand changes its id (approve again); a multipart ETag depends on the part size
(the same file uploaded again may need a new approval); a single copy is at most 5 GB; uploads from the app need a CORS
rule on the bucket allowing `PUT` from the instance's origin (the guide gives it per service).

**Tests:** the conformance suite against a fake S3 in the test world (checks the `Authorization` header is SigV4 and
serves objects from a map); unit tests for the presigned URLs (expiry, signed headers); the same suite against a real
MinIO when `S3_TEST_ENDPOINT` is set, skipped in CI.

## 3. Connect Google Drive (#32, proposed)

- The `drive` store works with one OAuth grant of the owner's, made with the **Google app already used for YouTube**
  (`oauth_apps` id `google`), scope `https://www.googleapis.com/auth/drive`. The full scope is what lets it see the
  files the owner drops in by hand (`drive.file` only sees what the app made) and move them. An unverified app of the
  owner's own may use it after Google's warning screen; the guide says so.
- The flow reuses `oauth_states` (state + PKCE, single use): `POST /admin-api/media-store/drive/start` → Google →
  `GET /admin-api/media-store/drive/callback` → the grant is stored encrypted in `media_store.credentials`. The OAuth
  apps page lists that redirect URL under the Google app, next to YouTube's.
- `DriveStore` takes the grant for every call (reads, moves, uploads). The root is a top folder named in the settings
  (default `UPLOADS`). Uploads from the app keep their own top folder (`Bongsu app uploads`), now without the sharing
  step. The weekly keep-alive the YouTube connection has also checks this grant and sets `status` to `broken` when
  Google refuses it (a revoked grant, or an app still in testing, whose tokens expire after 7 days).

## 4. Dashboard, app, health and docs (#17, proposed)

- **Dashboard → Media** (a new page beside Connections): the current store and its status; **Choose a store**:
  Google Drive (**Connect Google Drive**), S3-compatible (a form with the presets), This server's disk (only when the
  runtime offers `local`). **Test** runs `resolve` and `ensureFolder("UPLOADS/inbox")` with the entered settings
  before saving (a write check too) and stores the result. Secrets are never sent back to the browser.
- **Get started** gets a fifth step, "Media store", read from the row (`setup.mediaStore`).
- **The app's Settings** shows the store (kind, bucket or folder) and its status, read-only, with a link to the
  dashboard for owners and admins.
- `/health`: `media_store` (`missing`, `ok`, `broken`), and `ENCRYPTION_KEY` is needed when the row has credentials.
- **Docs:** `site/docs/s3.md` (new: presets, keys with the least rights, the CORS rule per service),
  `site/docs/drive.md` (rewritten for Connect Google Drive), `configuration.md`, `self-hosting.md`, `faq.md`,
  `backups.md`, `.env.example`, `docker-compose.yml`, `docs/media-stores.md`, `docs/schema.md` (generated), PLAN.md.
  A changeset (minor): users notice where the store is set up.

## Order of work

1. Schema: `media_store` (0016), generated SQL and docs.
2. `mediaStore()` async, from the row; `local` from the runtime; the env variables removed; the callers, the tick and
   the tests (the fake world and the Node tests write a row).
3. The `s3` store, the fake S3, conformance and presign tests; the conformance case on moved ids.
4. Drive on OAuth: the connect flow, the store, the keep-alive (after section 3 is approved).
5. The dashboard page, Get started, the app's Settings, `/health` (after section 4 is approved).
6. Docs, changeset, PLAN ticks; issues #15, #16, #17, #32 closed from the pull request.
