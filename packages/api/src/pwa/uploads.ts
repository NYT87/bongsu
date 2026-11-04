// Uploads from the app: a new draft made on the Drafts page, its media sent from the browser straight to the media
// store the owner picks (createUpload: a Drive resumable session, an S3 presigned PUT), so big Reels never pass through
// the Worker. Files land in the app's own folder in that store, APP_FOLDER.

import { DEFAULT_WORKSPACE, instagramAccounts } from "@bongsu/core/accounts";
import type { Env } from "@bongsu/core/env";
import { type MediaStores, mediaStores } from "@bongsu/core/media/index";
import { isMedia, isVideo } from "@bongsu/core/media/store";

export const APP_FOLDER = "Bongsu app uploads";
const NAME = /^[A-Za-z0-9_.-]{1,80}$/;

export class UploadError extends Error {
  constructor(
    public status: 400 | 404 | 503,
    msg: string,
  ) {
    super(msg);
  }
}

/** The store an upload goes to: the one asked for, else the default (when it takes uploads). */
function uploadStore(stores: MediaStores, asked: unknown) {
  const store = typeof asked === "string" && asked ? stores.get(asked) : stores.default;
  if (!store?.createUpload)
    throw new UploadError(503, "uploads aren't set up for this media store: add one in the dashboard (Media)");
  return store;
}

/** Where the browser sends one file: a PUT of the bytes to `uploadUrl`, in pieces when `chunked` (Drive); `id` is the
 *  new file's when the store knows it already (S3), else the last answer names it. */
export async function startUpload(
  env: Env,
  fetcher: typeof fetch,
  b: Record<string, unknown>,
): Promise<{
  uploadUrl: string;
  method: string;
  headers: Record<string, string>;
  chunked: boolean;
  id: string | null;
  store: string;
}> {
  const name = String(b.name ?? "").slice(0, 200),
    mime = String(b.mimeType ?? ""),
    size = Number(b.size);
  if (!name || !isMedia({ mime })) throw new UploadError(400, "only images and videos");
  if (!Number.isFinite(size) || size <= 0 || size > 1024 ** 3) throw new UploadError(400, "size: up to 1 GB");
  const store = uploadStore(await mediaStores(env, fetcher), b.store);
  const t = await store.createUpload!(name, APP_FOLDER, mime, env.PUBLIC_URL.replace(/\/$/, ""));
  return {
    uploadUrl: t.url,
    method: t.method,
    headers: t.headers,
    chunked: t.chunked,
    id: t.id ?? null,
    store: store.id,
  };
}

/** A draft from uploaded files (in slide order) and its texts; it opens on the Drafts page, ready to schedule. */
export async function draftFromUploads(
  env: Env,
  fetcher: typeof fetch,
  b: Record<string, unknown>,
  nowS: number,
  workspaceId = DEFAULT_WORKSPACE,
): Promise<{ id: string }> {
  const ids = Array.isArray(b.files) ? b.files.map(String) : [];
  if (!ids.length || ids.length > 10) throw new UploadError(400, "1 to 10 files");
  const project = String(b.project ?? "").trim(),
    name = String(b.name ?? "").trim();
  if (!NAME.test(project) || !NAME.test(name))
    throw new UploadError(400, "project and name: letters, digits, _ . - only");
  const store = uploadStore(await mediaStores(env, fetcher), b.store);
  const folder = await store.resolve(APP_FOLDER);
  const files: { store: string; id: string; name: string; mime: string; checksum: string }[] = [];
  for (const id of ids) {
    const m = await store.stat(id);
    if (!m || !folder || m.parent !== folder.id || !isMedia(m))
      throw new UploadError(400, `${id} isn't an upload of this app`);
    files.push({ store: store.id, id: m.id, name: m.name, mime: m.mime, checksum: m.checksum });
  }
  const known = await env.DB.prepare(
    "SELECT account, COUNT(*) AS n FROM plan_items WHERE folder LIKE '%/' || ?1 AND workspace_id = ?2 GROUP BY account ORDER BY n DESC LIMIT 1",
  )
    .bind(project, workspaceId)
    .first<{ account: string }>();
  const accountIds = (await instagramAccounts(env.DB, workspaceId)).map((a) => a.id);
  const account = accountIds.includes(String(b.account)) ? String(b.account) : (known?.account ?? accountIds[0] ?? "");
  const video = files.some((f) => isVideo(f));
  const kind = files.length > 1 ? "carousel" : video ? "reel" : "photo";
  const t = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
  const payload = {
    title: `${project}/${name}`,
    folder: project,
    name,
    caption: t(b.caption, 2200),
    comment: t(b.comment, 2200),
    comment2: t(b.comment2, 2200),
    alt: t(b.alt, 5000),
    media: files.map((f) => ({ store: f.store, id: f.id })),
    files,
  };
  const id = `d_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO drafts (id, kind, account, payload, source, created_by, status, created_at, updated_at, workspace_id) VALUES (?1, ?2, ?3, ?4, 'pwa', 'owner', 'draft', ?5, ?5, ?6)",
    ).bind(id, kind, account, JSON.stringify(payload), nowS, workspaceId),
    env.DB.prepare(
      "INSERT INTO audit (at, actor, action, target, detail) VALUES (?1, 'owner', 'draft_upload', ?2, ?3)",
    ).bind(nowS, id, JSON.stringify({ kind, files: files.length })),
  ]);
  return { id };
}
