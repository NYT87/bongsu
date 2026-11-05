// The "local" media store (MEDIA_STORE=local): a directory on the server (MEDIA_DIR), for instances that keep their
// media next to them instead of on Drive. A file's id is its inode, so it stays the same when the file (or its folder)
// is moved, also by hand; its checksum is the content's sha256. The signed /m/ links stream from here. Nothing
// outside the directory is ever read: a path is checked as written and again where it really leads (symlinks).
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { type MediaEntry, MediaRefused, type MediaStore } from "@bongsu/core/media/store";

const TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".m4v": "video/x-m4v",
  ".webm": "video/webm",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".heic": "image/heic",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
};
const mimeOf = (name: string) => TYPES[extname(name).toLowerCase()] ?? "application/octet-stream";

export class LocalStore implements MediaStore {
  private readonly root: string;
  /** inode → path relative to the root; checked on use, rebuilt by a walk when stale. */
  private paths = new Map<string, string>();
  /** "path:size:mtime" → sha256, so an unchanged file isn't hashed again. */
  private sums = new Map<string, string>();

  constructor(
    root: string,
    readonly id = "local",
  ) {
    this.root = resolve(root);
  }

  /** The absolute path of a logical one, never outside the root. */
  private abs(path: string) {
    const p = resolve(this.root, path.split("/").filter(Boolean).join(sep));
    if (p !== this.root && !p.startsWith(this.root + sep)) throw new Error(`${path} is outside the media folder`);
    return p;
  }

  /** Where a logical path really leads (symlinks followed), never outside the root's real location: a link planted
   *  in the folder can't expose a file elsewhere. ENOENT when the path isn't there. */
  private async real(path: string) {
    const abs = this.abs(path); // the lexical check first: "../x" is refused whether or not the folder exists
    const root = await realpath(this.root);
    const p = await realpath(abs);
    if (p !== root && !p.startsWith(root + sep)) {
      const e = new Error(`${path} leads outside the media folder`) as NodeJS.ErrnoException;
      e.code = "ENOENT";
      throw e;
    }
    return p;
  }

  private async entry(rel: string): Promise<MediaEntry | null> {
    try {
      const s = await stat(await this.real(rel));
      const id = String(s.ino);
      this.paths.set(id, rel);
      const parentRel = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
      const parent = parentRel ? String((await stat(this.abs(parentRel))).ino) : null;
      const folder = s.isDirectory();
      return {
        id,
        name: basename(rel),
        mime: folder ? "folder" : mimeOf(rel),
        size: folder ? 0 : s.size,
        checksum: folder ? "" : await this.sum(rel, s.size, s.mtimeMs),
        modifiedAt: s.mtime.toISOString(),
        folder,
        parent,
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }

  private async sum(rel: string, size: number, mtime: number) {
    const key = `${rel}:${size}:${mtime}`;
    let s = this.sums.get(key);
    if (!s) {
      const h = createHash("sha256");
      for await (const chunk of createReadStream(await this.real(rel))) h.update(chunk as Buffer);
      s = h.digest("hex");
      this.sums.set(key, s);
    }
    return s;
  }

  /** The path of an id: the cached one when it still has that inode, else found by walking the folder. */
  private async pathOf(id: string): Promise<string | null> {
    if (!/^\d+$/.test(id)) return null;
    const cached = this.paths.get(id);
    if (cached !== undefined) {
      const s = await stat(this.abs(cached)).catch(() => null);
      if (s && String(s.ino) === id) return cached;
    }
    this.paths.clear();
    const walk = async (rel: string): Promise<void> => {
      for (const d of await readdir(this.abs(rel), { withFileTypes: true }).catch(() => [])) {
        const child = rel ? `${rel}/${d.name}` : d.name;
        const s = await stat(this.abs(child)).catch(() => null);
        if (!s) continue;
        this.paths.set(String(s.ino), child);
        if (d.isDirectory()) await walk(child);
      }
    };
    await walk("");
    return this.paths.get(id) ?? null;
  }

  async stat(id: string) {
    const rel = await this.pathOf(id);
    return rel === null ? null : this.entry(rel);
  }

  async stream(id: string, range?: string | null): Promise<Response> {
    const e = await this.stat(id);
    const rel = e && !e.folder ? await this.pathOf(id) : null;
    if (!e || rel === null) return new Response("not found", { status: 404 });
    const headers = { "Content-Type": e.mime, "Accept-Ranges": "bytes" };
    const m = /^bytes=(\d*)-(\d*)$/.exec(range ?? "");
    if (m && (m[1] || m[2])) {
      // "a-b", "a-" (to the end) or "-n" (the last n bytes)
      const start = m[1] ? Number(m[1]) : Math.max(0, e.size - Number(m[2]));
      const end = m[1] && m[2] ? Math.min(Number(m[2]), e.size - 1) : e.size - 1;
      if (start > end || start >= e.size)
        return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${e.size}` } });
      const body = Readable.toWeb(createReadStream(await this.real(rel), { start, end })) as ReadableStream;
      return new Response(body, {
        status: 206,
        headers: {
          ...headers,
          "Content-Range": `bytes ${start}-${end}/${e.size}`,
          "Content-Length": `${end - start + 1}`,
        },
      });
    }
    const body = Readable.toWeb(createReadStream(await this.real(rel))) as ReadableStream;
    return new Response(body, { status: 200, headers: { ...headers, "Content-Length": `${e.size}` } });
  }

  async readText(id: string) {
    const rel = await this.pathOf(id);
    if (rel === null) throw new Error(`no file ${id}`);
    const f = await open(await this.real(rel));
    try {
      const buf = Buffer.alloc(80_000); // 20,000 characters of up to 4 bytes
      const { bytesRead } = await f.read(buf, 0, buf.length, 0);
      return buf.subarray(0, bytesRead).toString("utf8").slice(0, 20_000);
    } finally {
      await f.close();
    }
  }

  async resolve(path: string) {
    return this.entry(path.split("/").filter(Boolean).join("/"));
  }

  async inside(id: string, folderPath: string) {
    const rel = await this.pathOf(id);
    const folder = folderPath.split("/").filter(Boolean).join("/");
    return rel !== null && !!folder && rel.startsWith(`${folder}/`);
  }

  async list(folderId: string) {
    const rel = await this.pathOf(folderId);
    if (rel === null) return [];
    const out: MediaEntry[] = [];
    for (const name of await readdir(this.abs(rel))) {
      if (name.startsWith(".")) continue;
      const e = await this.entry(rel ? `${rel}/${name}` : name);
      if (e) out.push(e);
    }
    return out;
  }

  async ensureFolder(path: string) {
    const rel = path.split("/").filter(Boolean).join("/");
    await this.guard(() => mkdir(this.abs(rel), { recursive: true }));
    const e = await this.entry(rel);
    if (!e?.folder) throw new Error(`${path} isn't a folder`);
    return e.id;
  }

  async move(id: string, toFolderPath: string) {
    const rel = await this.pathOf(id);
    if (rel === null) throw new Error(`no file or folder ${id}`);
    await this.ensureFolder(toFolderPath);
    const to = this.abs(toFolderPath);
    // Never overwrite: a name already there gets " (2)", " (3)"… before its extension.
    const name = basename(rel);
    const ext = extname(name);
    let target = join(to, name);
    for (let n = 2; await stat(target).catch(() => null); n++)
      target = join(to, `${name.slice(0, name.length - ext.length)} (${n})${ext}`);
    await this.guard(() => rename(this.abs(rel), target));
    this.paths.set(id, relative(this.root, target).split(sep).join("/"));
  }

  /** A write the filesystem refuses (permissions) is a MediaRefused, reported once and not retried. */
  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EACCES" || code === "EPERM" || code === "EROFS") throw new MediaRefused((e as Error).message);
      throw e;
    }
  }
}

/** Writes a file at a logical path (folders created as needed); returns its id. For tests and imports. */
export async function putFile(store: LocalStore, root: string, path: string, bytes: string | Uint8Array) {
  const abs = join(resolve(root), ...path.split("/").filter(Boolean));
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, bytes);
  return (await store.resolve(path))!.id;
}
