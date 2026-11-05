// Google Drive as a media store: the only code that talks to Drive. Everything goes through the owner's OAuth grant
// (Connect Google Drive in the dashboard, scope drive: the files they drop in by hand too, and moving them aside).
// Uploads from the app open a resumable session, so the bytes go from the browser straight to Google. Paths start at
// a top folder of the owner's ("UPLOADS/inbox/<project>"). Nothing here trashes or deletes.
import { refreshToken } from "../clients/google";
import type { Db } from "../db";
import { type MediaEntry, MediaRefused, type MediaStore, type UploadTarget } from "./store";

const API = "https://www.googleapis.com/drive/v3/files";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3/files";
/** What Connect Google Drive asks for. */
export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";
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

/** "<store id>:<folder path>" → its folder, per Worker instance (see resolve). */
const folderIds = new Map<string, { entry: MediaEntry; until: number }>();
/** How far up a file's folders are followed. */
const MAX_DEPTH = 20;
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
  /** The owner's grant: {client_id, client_secret, refresh_token, token_uri}, from Connect Google Drive. */
  oauth: string;
  fetch: typeof fetch;
  /** Where the folders made for uploads are remembered (settings), so each is created once. */
  db?: Db;
  /** The store's id ("drive" for the instance's, "drive-<workspace>" for a workspace's own): the folders remembered
   *  here are per store, since two grants have different folders under the same path. */
  id?: string;
}

export class DriveStore implements MediaStore {
  readonly id: string;

  constructor(private o: DriveStoreOptions) {
    this.id = o.id ?? "drive";
  }

  private async auth() {
    return { Authorization: `Bearer ${await refreshToken(this.o.oauth, this.o.fetch)}` };
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
      const hit = folderIds.get(`${this.id}:${parts.slice(0, i).join("/")}`);
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
      if (e.folder)
        folderIds.set(`${this.id}:${parts.slice(0, i + 1).join("/")}`, { entry: e, until: Date.now() + FOLDER_TTL_MS });
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

  /** What inside() looks up, asked once per store (built per request or cron run): a carousel's files share their
   *  folders, so checking ten costs ten stats plus the workspace's folder and the folders between once, not a walk
   *  per file. A failure isn't remembered: the next file asks again. A null (no such folder, no parent) is, for the
   *  whole run: that fails closed (a file made in the folder meanwhile is refused until the next run), so it stays. */
  private seen = new Map<string, Promise<unknown>>();
  private once<T>(key: string, ask: () => Promise<T>): Promise<T> {
    let p = this.seen.get(key) as Promise<T> | undefined;
    if (!p) {
      p = ask();
      p.catch(() => this.seen.delete(key));
      this.seen.set(key, p);
    }
    return p;
  }

  async inside(id: string, folderPath: string) {
    const folder = await this.once(`path:${folderPath}`, () => this.resolve(folderPath));
    if (!folder?.folder) return false;
    // up the parents, a bounded number of steps; the file's own stat is always fresh
    let at = (await this.stat(id))?.parent ?? null;
    for (let i = 0; i < MAX_DEPTH && at !== null; i++) {
      if (at === folder.id) return true;
      const from = at;
      at = await this.once(`parent:${from}`, async () => (await this.stat(from))?.parent ?? null);
    }
    return false;
  }

  async list(folderId: string) {
    return (await this.query(`'${folderId}' in parents and trashed=false`)).map(toEntry);
  }

  private async mkdir(name: string, parent: string): Promise<string> {
    const r = await this.o.fetch(`${API}?fields=id`, {
      method: "POST",
      headers: { ...(await this.auth()), "Content-Type": "application/json" },
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
    if (!found) throw new Error(`drive: no top folder named ${parts[0]} in the connected Drive`);
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
      headers: { ...(await this.auth()), "Content-Type": "application/json" },
      body: "{}",
    });
    if (r.status === 403 || r.status === 404) throw new MediaRefused(`move refused (${r.status})`);
    if (!r.ok) throw new Error(`drive move ${id}: ${r.status}`);
  }

  // ---------------------------------------------------------------- uploads from the app

  /** A top folder of the owner's for uploads, created on first use and remembered in settings. */
  private async ownerFolder(name: string): Promise<string> {
    const key = `drive_upload_folder:${this.id}:${name}`;
    const hit = await this.o.db
      ?.prepare("SELECT value FROM settings WHERE key = ?1")
      .bind(key)
      .first<{ value: string }>();
    if (hit && (await this.get(hit.value))) return hit.value;
    const r = await this.o.fetch(`${API}?fields=id`, {
      method: "POST",
      headers: { ...(await this.auth()), "Content-Type": "application/json" },
      body: JSON.stringify({ name, mimeType: FOLDER }),
    });
    if (!r.ok) throw new Error(`drive: creating "${name}": ${r.status}`);
    const id = ((await r.json()) as { id: string }).id;
    await this.o.db
      ?.prepare("INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = ?2")
      .bind(key, id)
      .run();
    return id;
  }

  /** A resumable upload session: the browser PUTs the bytes to the URL in chunks; the last answer names the file. */
  async createUpload(name: string, folderPath: string, mime: string, origin: string): Promise<UploadTarget> {
    const [top, ...rest] = folderPath.split("/");
    // The top folder is the owner's (made at the root when missing). Its id is kept from there, not looked up again by
    // name: Drive's search lags a create, so a first upload would find nothing. What's below it is made as needed.
    let folder = (await this.resolve(top))?.id ?? (await this.ownerFolder(top));
    for (const part of rest) {
      const have = (await this.list(folder)).find((e) => e.folder && e.name === part);
      folder = have?.id ?? (await this.mkdir(part, folder));
    }
    const r = await this.o.fetch(`${UPLOAD_API}?uploadType=resumable&fields=id,name,mimeType,md5Checksum,size`, {
      method: "POST",
      // Origin: Google then answers the browser's PUTs to the session URL with CORS headers for the app.
      // No X-Upload-Content-Length: a picked file can turn out a different size than it claims; the last chunk says.
      headers: {
        ...(await this.auth()),
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": mime,
        Origin: origin,
      },
      body: JSON.stringify({ name, parents: [folder] }),
    });
    const url = r.headers.get("Location");
    if (!r.ok || !url) throw new Error(`drive: starting the upload: ${r.status}`);
    return { url, method: "PUT", headers: {}, chunked: true };
  }
}
