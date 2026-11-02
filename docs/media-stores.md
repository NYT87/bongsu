# Media stores

Bongsu never keeps your Reels and photos itself: they stay in a **media store** you control, and the database only
references them. Two stores exist: **Google Drive** (`drive`, the default) and, on Node and Docker, **a directory on
the server** (`local`, [self-hosting.md](../site/docs/self-hosting.md)). The interface is small so others (R2, S3) can be added
without touching the scheduler.

## The local store

`MEDIA_STORE=local` with `MEDIA_DIR` (`apps/node/src/local-store.ts`): the same logical paths as folders under that
directory (`UPLOADS/inbox/<project>/` to drop files in, `UPLOADS/_posted/`). A file's id is its inode, so it keeps its
id when it or its folder is moved, by Bongsu or by hand; its checksum is the content's sha256. Instagram fetches the
media through the signed `/m/` links. Uploading from the app isn't supported yet (no `createUpload`): copy files into
the inbox folder instead.

## How a store is used

| Where | What it does with the store |
|---|---|
| Publishing (`core/tick.ts`) | `stat` each approved file just before publishing: it must still exist with the approved checksum |
| Media links (`core/media.ts`) | `publicUrl` when the store has it (Instagram fetches the store directly); otherwise a signed `/m/<id>` link that `stat`s and `stream`s the file, ranges included |
| The inbox (`core/inbox.ts`) | `resolve("UPLOADS/inbox")`, `list` each project, `readText` the caption files |
| Cleanup (`core/cleanup.ts`) | `move` posted media (a post as its folder) to `UPLOADS/_posted/`, `ensureFolder` |
| The app (`api/pwa/approve.ts`, `uploads.ts`) | `resolve` / `list` / `stat` an item's media for the approval page; `createUpload` for uploads from the phone |

**References.** Approvals, plan items and drafts store `{store, id, checksum}`. The checksum is whatever the store
guarantees (Drive's md5, an S3 ETag, a sha256) and is only compared for equality, so a store can use any. A reference
to another store than the instance's counts as missing: switching stores means approving again.

**Paths are logical** (`UPLOADS/inbox/<project>/`, `UPLOADS/_posted/`), relative to the store's root: for Drive, a
folder shared with the service account; for a bucket, a prefix; for a disk, a directory.

**Nothing is deleted.** Bongsu only moves files aside. A store without a native move (S3, R2) copies, then removes the
original: still a move, and nothing leaves the store.

## The interface

`packages/core/src/media/store.ts`:

| Method | Contract |
|---|---|
| `id` | the store's name, recorded in every reference (`drive`, `r2`, …) |
| `stat(id)` | `{id, name, mime, size, checksum, modifiedAt, folder, parent}`, or `null` when missing or trashed. `checksum` may be empty while the store is still computing it (the inbox and the approval page wait) |
| `stream(id, range?)` | a `Response` with the bytes; a `Range: bytes=a-b` gives 206 with `Content-Range` (Instagram fetches ranges); 404 when missing |
| `readText(id)` | a small text file, at most 20,000 characters |
| `resolve(path)` | the file or folder at a logical path, or `null` |
| `list(folderId)` | what's directly inside a folder |
| `ensureFolder(path)` | the folder at a path, created with its parents when missing; the same id every time |
| `move(id, toFolderPath)` | moves a file, or a folder with its contents, into a folder (created when missing). Throw `MediaRefused` when the store says no (no permission): the cleanup records it once and doesn't retry. Anything else throws a plain `Error` |
| `publicUrl?(id, ttlS)` | optional: a presigned URL valid for `ttlS` seconds. With it, media never passes through the Worker |
| `createUpload?(name, folderPath, mime, origin)` | optional: where the browser sends a new file (`{url, method, headers}`). Without it, the app hides the upload button |

Only web-standard APIs (`fetch`, `Response`, `crypto.subtle`): `core` runs on Workers and on Node.

## Writing a store

1. Add `packages/core/src/media/<name>.ts` with a class implementing `MediaStore`. `memory.ts` is the smallest
   complete example; `drive.ts` is the real one.
2. Wire it into `mediaStore()` in `media/index.ts` under its `MEDIA_STORE` value, with its settings from `Env`. A
   store that needs Node APIs stays out of core: the runtime registers it (`registerStore`, as `apps/node` does for
   `local`).
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

   The suite runs today against the in-memory store (`packages/core/test/media-memory.test.ts`) and the fake Drive
   (`apps/cloudflare/test/tick.test.ts`).
4. Document its setup, as the [Drive](#drive) section below does: credentials, the root, what `checksum` is, whether it has
   `publicUrl` and `createUpload`.

Checklist:

- [ ] `stat` returns `null` (not an error) for an unknown or trashed id.
- [ ] Ranges work: 206, the right bytes, `Content-Range: bytes a-b/total`.
- [ ] The checksum changes when the content changes, and only then.
- [ ] `move` works on folders, and a refusal is a `MediaRefused`.
- [ ] Nothing deletes a file.
- [ ] Subrequests: on Cloudflare's free plan a cron run may make 50; resolving a path one level at a time adds up, so
      cache folder ids (as `drive.ts` does) if the store walks paths.

## Drive

The `drive` store (`media/drive.ts`) reads through a service account (scope `drive.readonly`) and moves and creates
folders with the same account's write scope, so the account needs Editor on `UPLOADS/`. Uploads from the app go
through the owner's OAuth (scope `drive.file`), which can only write into folders the app created: they land in
"Bongsu app uploads", shared with the service account on first use. The checksum is Drive's md5, which Drive computes a
moment after an upload. The `/m/` proxy streams the files (Drive has no presigned URLs).
