// Google Drive as a media store: the only code that talks to Drive. Reads go through the service account (read-only
// scope); moving posted media aside and creating folders use its write scope (Editor on UPLOADS/). Uploads from the
// app open a resumable session as the owner (scope drive.file), so the bytes go from the browser straight to Google;
// that scope only lets the app write into folders it created, so those are created as the owner and shared with the
// service account. Paths start at a folder shared with the service account ("UPLOADS/inbox/<project>"). Nothing here
// trashes or deletes.
import { refreshToken, serviceAccountToken } from "../clients/google";
import type { Db } from "../db";
import { type MediaEntry, MediaRefused, type MediaStore, type UploadTarget } from "./store";

const API = "https://www.googleapis.com/drive/v3/files";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3/files";
const READ = "https://www.googleapis.com/auth/drive.readonly";
const WRITE = "https://www.googleapis.com/auth/drive";
const FOLDER = "application/vnd.google-apps.folder";
const FIELDS = "id,name,mimeType,md5Checksum,size,modifiedTime,parents,trashed";

interface DriveFile {
  id: string;
  name?: string;
  mimeType: string;
  md5Checksum?: string;
  size?: string;
  modifiedTime?: string;
  parents?: string[];
  trashed?: boolean;
}

/** Folder path → its folder, per Worker instance (see resolve). */
const folderIds = new Map<string, { entry: MediaEntry; until: number }>();
const FOLDER_TTL_MS = 10 * 60_000;
export const clearFolderCache = () => folderIds.clear();

const toEntry = (f: DriveFile): MediaEntry => ({
  id: f.id,
  name: f.name ?? f.id,
  mime: f.mimeType,
  size: Number(f.size ?? 0),
  checksum: f.md5Checksum ?? "",
  modifiedAt: f.modifiedTime ?? "",
  folder: f.mimeType === FOLDER,
  parent: f.parents?.[0] ?? null,
});

export interface DriveStoreOptions {
  /** The service account's JSON key. */
  saJson: string;
  fetch: typeof fetch;
  /** The owner's OAuth (client id/secret, refresh token, scope drive.file): enables uploads from the app. */
  ownerOauth?: string;
  /** Where the folders made for uploads are remembered (settings), so each is created once. */
  db?: Db;
}

export class DriveStore implements MediaStore {
  readonly id = "drive";
  createUpload?: (name: string, folderPath: string, mime: string, origin: string) => Promise<UploadTarget>;

  constructor(private o: DriveStoreOptions) {
    if (o.ownerOauth) this.createUpload = (n, p, m, origin) => this.upload(n, p, m, origin);
  }

  private async auth(scope = READ) {
    return { Authorization: `Bearer ${await serviceAccountToken(this.o.saJson, scope, this.o.fetch)}` };
  }

  private async get(id: string): Promise<DriveFile | null> {
    const r = await this.o.fetch(`${API}/${encodeURIComponent(id)}?fields=${FIELDS}`, { headers: await this.auth() });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`drive stat ${id}: ${r.status}`);
    const f = (await r.json()) as DriveFile;
    return f.trashed ? null : f;
  }

  private async query(q: string): Promise<DriveFile[]> {
    const r = await this.o.fetch(
      `${API}?q=${encodeURIComponent(q)}&fields=${encodeURIComponent(`files(${FIELDS})`)}&pageSize=200`,
      { headers: await this.auth() },
    );
    if (!r.ok) throw new Error(`drive list: ${r.status}`);
    return ((await r.json()) as { files: DriveFile[] }).files;
  }

  async stat(id: string) {
    const f = await this.get(id);
    return f ? toEntry(f) : null;
  }

  async stream(id: string, range?: string | null) {
    const h: Record<string, string> = await this.auth();
    if (range) h.Range = range;
    const r = await this.o.fetch(`${API}/${encodeURIComponent(id)}?alt=media`, { headers: h });
    return r.status === 404 ? new Response("not found", { status: 404 }) : r;
  }

  async readText(id: string) {
    const r = await this.stream(id);
    if (!r.ok) throw new Error(`drive text ${id}: ${r.status}`);
    return (await r.text()).slice(0, 20000);
  }

  /** Walking a path costs one query per level (8 for a Reel), so folders are remembered for a while (they rarely
   *  move); a miss below a remembered folder walks again from the top, in case it did. */
  async resolve(path: string) {
    const parts = path.split("/").filter(Boolean);
    let start = 0,
      node: MediaEntry | null = null;
    for (let i = parts.length - 1; i > 0; i--) {
      const hit = folderIds.get(parts.slice(0, i).join("/"));
      if (hit && hit.until > Date.now()) {
        node = hit.entry;
        start = i;
        break;
      }
    }
    const found = await this.walk(parts, start, node);
    return found === null && start > 0 ? this.walk(parts, 0, null) : found;
  }

  private async walk(parts: string[], start: number, from: MediaEntry | null): Promise<MediaEntry | null> {
    const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const remember = (i: number, e: MediaEntry) => {
      if (e.folder) folderIds.set(parts.slice(0, i + 1).join("/"), { entry: e, until: Date.now() + FOLDER_TTL_MS });
    };
    let node = from;
    if (start === 0) {
      const tops = await this.query(`name='${esc(parts[0])}' and mimeType='${FOLDER}' and trashed=false`);
      if (tops.length !== 1) return null;
      node = toEntry(tops[0]);
      remember(0, node);
      start = 1;
    }
    for (let i = start; i < parts.length; i++) {
      const hits = await this.query(`'${node!.id}' in parents and name='${esc(parts[i])}' and trashed=false`);
      if (hits.length !== 1) return null;
      node = toEntry(hits[0]);
      remember(i, node);
    }
    return node;
  }

  async list(folderId: string) {
    return (await this.query(`'${folderId}' in parents and trashed=false`)).map(toEntry);
  }

  private async mkdir(name: string, parent: string): Promise<string> {
    const r = await this.o.fetch(`${API}?fields=id`, {
      method: "POST",
      headers: { ...(await this.auth(WRITE)), "Content-Type": "application/json" },
      body: JSON.stringify({ name, mimeType: FOLDER, parents: [parent] }),
    });
    if (r.status === 403) throw new MediaRefused(`Drive refused creating ${name} (403)`);
    if (!r.ok) throw new Error(`drive mkdir ${name}: ${r.status}`);
    return ((await r.json()) as { id: string }).id;
  }

  async ensureFolder(path: string) {
    const parts = path.split("/").filter(Boolean);
    // the deepest folder that exists, then the missing levels below it
    let at = parts.length;
    let found = await this.resolve(path);
    while (!found && --at > 0) found = await this.resolve(parts.slice(0, at).join("/"));
    if (!found) throw new Error(`drive: no top folder ${parts[0]} shared with the service account`);
    let id = found.id;
    for (let i = at; i < parts.length; i++) id = await this.mkdir(parts[i], id);
    return id;
  }

  async move(id: string, toFolderPath: string) {
    const f = await this.get(id);
    if (!f) throw new Error(`drive move ${id}: gone`);
    const to = await this.ensureFolder(toFolderPath);
    if (f.parents?.includes(to)) return;
    const qs = `&addParents=${encodeURIComponent(to)}&removeParents=${encodeURIComponent((f.parents ?? []).join(","))}`;
    const r = await this.o.fetch(`${API}/${encodeURIComponent(id)}?fields=id${qs}`, {
      method: "PATCH",
      headers: { ...(await this.auth(WRITE)), "Content-Type": "application/json" },
      body: "{}",
    });
    if (r.status === 403 || r.status === 404) throw new MediaRefused(`move refused (${r.status})`);
    if (!r.ok) throw new Error(`drive move ${id}: ${r.status}`);
  }

  // ---------------------------------------------------------------- uploads from the app (owner, drive.file)

  private async owner() {
    return { Authorization: `Bearer ${await refreshToken(this.o.ownerOauth!, this.o.fetch)}` };
  }

  /** A top folder of the owner's for uploads, created on first use and shared with the service account (writer: it
   *  moves posted files); remembered in settings. Only top folders: drive.file can't write into UPLOADS/. */
  private async ownerFolder(name: string): Promise<string> {
    const key = `drive_upload_folder:${name}`;
    const hit = await this.o.db
      ?.prepare("SELECT value FROM settings WHERE key = ?1")
      .bind(key)
      .first<{ value: string }>();
    if (hit) return hit.value;
    const h = { ...(await this.owner()), "Content-Type": "application/json" };
    const r = await this.o.fetch(`${API}?fields=id`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ name, mimeType: FOLDER }),
    });
    if (!r.ok) throw new Error(`drive: creating "${name}": ${r.status}`);
    const id = ((await r.json()) as { id: string }).id;
    const sa = (JSON.parse(this.o.saJson) as { client_email: string }).client_email;
    const p = await this.o.fetch(`${API}/${id}/permissions?sendNotificationEmail=false`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ type: "user", role: "writer", emailAddress: sa }),
    });
    if (!p.ok) throw new Error(`drive: sharing "${name}" with the service account: ${p.status}`);
    await this.o.db
      ?.prepare("INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = ?2")
      .bind(key, id)
      .run();
    return id;
  }

  /** A resumable upload session: the browser PUTs the bytes to the URL in chunks. */
  private async upload(name: string, folderPath: string, mime: string, origin: string): Promise<UploadTarget> {
    if (folderPath.includes("/")) throw new Error("drive uploads go to a top folder of the owner's");
    const folder = await this.ownerFolder(folderPath);
    const r = await this.o.fetch(`${UPLOAD_API}?uploadType=resumable&fields=id,name,mimeType,md5Checksum,size`, {
      method: "POST",
      // Origin: Google then answers the browser's PUTs to the session URL with CORS headers for the app.
      // No X-Upload-Content-Length: a picked file can turn out a different size than it claims; the last chunk says.
      headers: {
        ...(await this.owner()),
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": mime,
        Origin: origin,
      },
      body: JSON.stringify({ name, parents: [folder] }),
    });
    const url = r.headers.get("Location");
    if (!r.ok || !url) throw new Error(`drive: starting the upload: ${r.status}`);
    return { url, method: "PUT", headers: {} };
  }
}
