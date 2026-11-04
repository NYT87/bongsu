# Media stores

Bongsu never keeps your Reels and photos itself: they stay in a **media store** you control, and the database only
references them. Three kinds exist: **Google Drive** (`drive`), **an S3-compatible bucket** (`s3`: AWS S3, R2, B2,
MinIO…) and, on Node and Docker, **a directory on the server** (`local`). The interface is small, so others can be
added without touching the scheduler.

## Several stores, set up in the dashboard

The stores are set up on the dashboard's **Media** page and kept in `media_store` (one row per kind: its settings, its
credentials encrypted with `ENCRYPTION_KEY`, the last check, whether it's the default). Nothing about them is in the
environment, apart from `MEDIA_DIR` on Node: the directory the server offers as `local` (the runtime registers it, the
dashboard only picks it; it never takes a server path).

Several can be set up side by side, one of each kind. Every reference to a file names its store, so each file is read
from its own; the **default** store is used where nothing names one (plan items given by a path, file ids from the
agent API, the upload page's first choice).

`media/index.ts`: `await mediaStores(env, fetcher)` builds every store once per request or cron run (a store whose
credentials don't decrypt, or a kind the runtime doesn't offer, lands in `errors` instead of failing the request), with
`for(ref)` (the store a reference names, or null), `default`, `all` and `uploadable`. `media/manage.ts` is the
dashboard's side: `testStore`, `saveStore` (tests first), `setDefaultStore`, `removeStore`, `waitingApprovalsIn`,
Connect Google Drive (`startDriveConnect`, `finishDriveConnect`) and the weekly `checkStores` in the inbox's cron run.

## How a store is used

| Where | What it does with the stores |
|---|---|
| Publishing (`core/tick.ts`) | `stat` each approved file in its own store just before publishing: it must still exist with the approved checksum |
| Media links (`core/media.ts`) | `publicUrl` when the file's store has it (Instagram fetches the store directly); otherwise a signed `/m/<store>/<id>` link that `stat`s and `stream`s the file, ranges included |
| The inbox (`core/inbox.ts`) | in every store: `resolve("UPLOADS/inbox")`, `list` each project, `readText` the caption files; a store that fails doesn't stop the others |
| Cleanup (`core/cleanup.ts`) | `move` posted media (a post as its folder) to `UPLOADS/_posted/` in its own store, `ensureFolder` |
| The app (`api/pwa/approve.ts`, `uploads.ts`) | `resolve` / `list` / `stat` an item's media for the approval page; `createUpload` in the store the owner picks |

**References.** Approvals, plan items and drafts store `{store, id, checksum}`. The checksum is whatever the store
guarantees (Drive's md5, an S3 ETag, a sha256) and is only compared for equality, so a store can use any. A reference
to a store that isn't set up counts as missing: removing a store means approving its items again (the dashboard says
how many).

**Paths are logical** (`UPLOADS/inbox/<project>/`, `UPLOADS/_posted/`), relative to the store's root: for Drive, the
connected account's top folders; for a bucket, its prefix; for a disk, a directory.

**Nothing is deleted.** Bongsu only moves files aside. A store without a native move (S3) copies, then removes the
originals once every copy exists: still a move, and nothing leaves the store.

**Ids may change on a move.** Drive and `local` keep a file's id when it moves; in a bucket the id is the key, so a
moved file is a new one. Nothing reads an id after the cleanup's move (only `stat` before publishing and the media
links do), so the conformance suite checks the moved file's content, not its id.

## The interface

`packages/core/src/media/store.ts`:

| Method | Contract |
|---|---|
| `id` | the store's kind, recorded in every reference (`drive`, `s3`, …) |
| `stat(id)` | `{id, name, mime, size, checksum, modifiedAt, folder, parent}`, or `null` when missing or trashed. `checksum` may be empty while the store is still computing it (the inbox and the approval page wait) |
| `stream(id, range?)` | a `Response` with the bytes; a `Range: bytes=a-b` gives 206 with `Content-Range` (Instagram fetches ranges); 404 when missing |
| `readText(id)` | a small text file, at most 20,000 characters |
| `resolve(path)` | the file or folder at a logical path, or `null` |
| `list(folderId)` | what's directly inside a folder |
| `ensureFolder(path)` | the folder at a path, created with its parents when missing; the same id every time |
| `move(id, toFolderPath)` | moves a file, or a folder with its contents, into a folder (created when missing). Throw `MediaRefused` when the store says no (no permission): the cleanup records it once and doesn't retry. Anything else throws a plain `Error` |
| `publicUrl?(id, ttlS)` | optional: a presigned URL valid for `ttlS` seconds. With it, media never passes through Bongsu |
| `createUpload?(name, folderPath, mime, origin)` | optional: where the browser sends a new file, `{url, method, headers, chunked, id?}`: `chunked` sends it in pieces with `Content-Range` (a Drive resumable session), else in one request (a presigned PUT); `id` is the new file's when the store knows it before the upload. Without it, the store isn't offered for uploads |

Ids must be safe in a URL path segment (`/m/<store>/<id>`: letters, digits, `-` and `_`): the S3 store encodes its
keys as base64url. Only web-standard APIs (`fetch`, `Response`, `crypto.subtle`): `core` runs on Workers and on Node.

## Writing a store

1. Add `packages/core/src/media/<name>.ts` with a class implementing `MediaStore`. `memory.ts` is the smallest
   complete example; `s3.ts` and `drive.ts` are the real ones.
2. Add its kind to `STORE_KINDS` and `buildStore()` in `media/index.ts`, with its settings and credentials from the
   row (and its kind to the `media_store.kind` values, a schema migration). A store that needs Node APIs stays out of
   core: the runtime registers it (`registerStore`, as `apps/node` does for `local`). The dashboard's Media page needs
   a form for its settings (`packages/dashboard/src/pages.tsx`) and `manage.ts` a check of what the form sends.
3. Run the conformance suite against it. It's framework-free, so any test runner calls it:

   ```ts
   import { mediaStoreCases } from "@bongsu/core/media/conformance";

   describe("media store conformance: mine", () => {
     for (const c of mediaStoreCases(async (files) => {
       const store = new MyStore(/* a fresh, empty root */);
       const ids: Record<string, string> = {};
       for (const [path, f] of Object.entries(files)) ids[path] = await putFile(store, path, f.bytes, f.mime);
       return { store, ids };
     }))
       it(c.name, c.run);
   });
   ```

   The suite runs today against the in-memory store (`packages/core/test/media-memory.test.ts`), the fake S3
   (`media-s3.test.ts`, with path-style and virtual-hosted addresses), the fake Drive (`apps/cloudflare/test/tick.test.ts`)
   and a temporary directory (`apps/node/test/node.test.ts`).
4. Document its setup, as [drive.md](../site/docs/drive.md) and [s3.md](../site/docs/s3.md) do: credentials, the root,
   what `checksum` is, whether it has `publicUrl` and `createUpload`.

Checklist:

- [ ] `stat` returns `null` (not an error) for an unknown or trashed id.
- [ ] Ranges work: 206, the right bytes, `Content-Range: bytes a-b/total`.
- [ ] The checksum changes when the content changes, and only then.
- [ ] `move` works on folders, and a refusal is a `MediaRefused`.
- [ ] Nothing deletes a file (a move may remove the original once the copy exists).
- [ ] Ids are URL-safe.
- [ ] Subrequests: on Cloudflare's free plan a cron run may make 50; resolving a path one level at a time adds up, so
      cache folder ids (as `drive.ts` does) if the store walks paths.

## Drive

The `drive` store (`media/drive.ts`) does everything with one OAuth grant of the owner's, made by **Connect Google
Drive** with the owner's Google app (`oauth_apps` id `google`, the one YouTube uses) and the scope `drive`: it sees the
files the owner drops in by hand and can move them. Uploads from the app open a resumable session in a top folder,
"Bongsu app uploads", made on first use. The checksum is Drive's md5, which Drive computes a moment after an upload.
The `/m/` proxy streams the files (Drive has no presigned URLs).

## S3

The `s3` store (`media/s3.ts`) signs with SigV4 (`aws4fetch`, web-standard): settings `{endpoint, region, bucket,
prefix, pathStyle}` and a key pair. A folder is a key prefix ending in `/` (with an empty marker object once Bongsu
makes it); listings parse ListObjectsV2's XML without a parser (Workers have none) and follow continuation tokens. The
checksum is the ETag. `publicUrl` presigns a GET (at most seven days); `createUpload` presigns a PUT with the
`Content-Type` signed, and a random suffix before the extension so an upload never replaces a file. Uploads from the
browser need a CORS rule on the bucket ([s3.md](../site/docs/s3.md)).

Tests: `FakeS3` (`media/fake-s3.ts`) answers the requests from a map and checks each is signed for its key; the same
suite against a real server runs when `S3_TEST_ENDPOINT` is set (with `S3_TEST_BUCKET`, `S3_TEST_KEY`,
`S3_TEST_SECRET`). MinIO's image is no longer on Docker Hub; versitygw works:

```sh
docker run -d --rm --name bongsu-s3 -p 127.0.0.1:9100:7070 --entrypoint sh versity/versitygw:latest \
  -c 'mkdir -p /data/media /tmp/vgw && exec versitygw --access bongsutest --secret bongsutest-secret --port :7070 posix --sidecar /tmp/vgw /data'
S3_TEST_ENDPOINT=http://127.0.0.1:9100 S3_TEST_BUCKET=media S3_TEST_KEY=bongsutest S3_TEST_SECRET=bongsutest-secret \
  pnpm --filter @bongsu/core exec vitest run test/media-s3.test.ts
docker stop bongsu-s3
```
