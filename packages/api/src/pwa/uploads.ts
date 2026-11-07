// Uploads from the app: a new draft made on the Drafts page, its media sent from the browser straight to the media
// store the owner picks (createUpload: a Drive resumable session, an S3 presigned PUT), so big Reels never pass through
// the Worker. Files land in the workspace's own folder in that store, <media_folder>/_uploads (appUploads).

import { instagramAccounts } from "@bongsu/core/accounts";
import type { Env } from "@bongsu/core/env";
import { mediaPath } from "@bongsu/core/media/folders";
import { type MediaStores, mediaStores } from "@bongsu/core/media/index";
import { assertOwns, MediaError } from "@bongsu/core/media/owns";
import { isMedia, isVideo } from "@bongsu/core/media/store";
import { isSubtitle, SUBTITLE_MAX, SUBTITLE_TOO_BIG, videoWithExtras } from "@bongsu/core/platforms/youtube";
import { workspaceSettings } from "@bongsu/core/workspaces";

/** Where the app's uploads land: the workspace's folder, `_uploads` (the inbox scan skips `_` folders). */
export const appUploads = (folder: string) => mediaPath(folder, "_uploads");
const NAME = /^[A-Za-z0-9_.-]{1,80}$/;

export class UploadError extends Error {
  constructor(
    public status: 400 | 404 | 503,
    msg: string,
  ) {
    super(msg);
  }
}

const subtitleMime = (name: string) => (name.endsWith(".vtt") ? "text/vtt" : "application/x-subrip");

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
  workspaceId: string,
): Promise<{
  uploadUrl: string;
  method: string;
  headers: Record<string, string>;
  chunked: boolean;
  id: string | null;
  store: string;
}> {
  const name = String(b.name ?? "").slice(0, 200),
    size = Number(b.size);
  // a YouTube video's subtitle file (<lang>.srt or .vtt) goes with it; phones often send no type for one
  const sub = isSubtitle(name);
  const mime = String(b.mimeType ?? "") || (sub ? subtitleMime(name) : "");
  if (!name || !(isMedia({ mime }) || sub))
    throw new UploadError(400, "only images, videos and subtitle files (<lang>.srt or .vtt)");
  if (!Number.isFinite(size) || size <= 0 || size > 1024 ** 3) throw new UploadError(400, "size: up to 1 GB");
  if (sub && size > SUBTITLE_MAX) throw new UploadError(400, SUBTITLE_TOO_BIG(name));
  const store = uploadStore(await mediaStores(env, fetcher, workspaceId), b.store);
  const folder = appUploads((await workspaceSettings(env.DB, workspaceId)).mediaFolder);
  const t = await store.createUpload!(name, folder, mime, env.PUBLIC_URL.replace(/\/$/, ""));
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
  workspaceId: string,
  userId: string,
): Promise<{ id: string }> {
  const ids = Array.isArray(b.files) ? b.files.map(String) : [];
  if (!ids.length || ids.length > 10) throw new UploadError(400, "1 to 10 files");
  const project = String(b.project ?? "").trim(),
    name = String(b.name ?? "").trim();
  if (!NAME.test(project) || !NAME.test(name))
    throw new UploadError(400, "project and name: letters, digits, _ . - only");
  const stores = await mediaStores(env, fetcher, workspaceId);
  const store = uploadStore(stores, b.store);
  const mediaFolder = (await workspaceSettings(env.DB, workspaceId)).mediaFolder;
  // the files must be this workspace's, then specifically the app's uploads of it
  try {
    await assertOwns(
      stores,
      mediaFolder,
      ids.map((id) => ({ store: store.id, id })),
    );
  } catch (e) {
    if (e instanceof MediaError) throw new UploadError(e.status, e.message);
    throw e;
  }
  const folder = await store.resolve(appUploads(mediaFolder));
  const files: { store: string; id: string; name: string; mime: string; checksum: string }[] = [];
  for (const id of ids) {
    const m = await store.stat(id);
    if (!m || !folder || m.parent !== folder.id || !(isMedia(m) || isSubtitle(m.name)))
      throw new UploadError(400, `${id} isn't an upload of this app`);
    // the size the browser announced isn't the file's: the store's is
    if (isSubtitle(m.name) && m.size > SUBTITLE_MAX) throw new UploadError(400, SUBTITLE_TOO_BIG(m.name));
    files.push({ store: store.id, id: m.id, name: m.name, mime: m.mime, checksum: m.checksum });
  }
  const known = await env.DB.prepare(
    "SELECT account, COUNT(*) AS n FROM plan_items WHERE folder LIKE '%/' || ?1 AND workspace_id = ?2 GROUP BY account ORDER BY n DESC LIMIT 1",
  )
    .bind(project, workspaceId)
    .first<{ account: string }>();
  const accountIds = (await instagramAccounts(env.DB, workspaceId)).map((a) => a.id);
  const account = accountIds.includes(String(b.account)) ? String(b.account) : (known?.account ?? accountIds[0] ?? "");
  if (!files.some((f) => isMedia(f))) throw new UploadError(400, "subtitle files go with a video");
  const video = files.some((f) => isVideo(f));
  // a video with its subtitle files and thumbnail is one YouTube video, not a carousel (as in the inbox)
  const kind = videoWithExtras(files) ? "reel" : files.length > 1 ? "carousel" : video ? "reel" : "photo";
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
      "INSERT INTO drafts (id, kind, account, payload, source, created_by, user_id, status, created_at, updated_at, workspace_id) VALUES (?1, ?2, ?3, ?4, 'pwa', 'owner', ?7, 'draft', ?5, ?5, ?6)",
    ).bind(id, kind, account, JSON.stringify(payload), nowS, workspaceId, userId),
    env.DB.prepare(
      "INSERT INTO audit (at, actor, action, target, detail, user_id, workspace_id) VALUES (?1, ?2, 'draft_upload', ?3, ?4, ?5, ?6)",
    ).bind(nowS, `user:${userId}`, id, JSON.stringify({ kind, files: files.length }), userId, workspaceId),
  ]);
  return { id };
}
