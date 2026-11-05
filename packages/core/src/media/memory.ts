// A media store in memory: for tests, and as the smallest example of the interface (docs/media-stores.md).
import { type MediaEntry, MediaRefused, type MediaStore } from "./store";

interface Node {
  entry: MediaEntry;
  parent: string | null;
  bytes: Uint8Array<ArrayBuffer>;
}

/** How far up a file's folders are followed (the same bound as Drive's). */
const MAX_DEPTH = 20;

const sha256 = async (b: Uint8Array<ArrayBuffer>) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", b))].map((x) => x.toString(16).padStart(2, "0")).join("");

export class MemoryStore implements MediaStore {
  private nodes = new Map<string, Node>();
  private n = 0;
  /** Refuse every write, as a store without edit rights would. */
  refuseWrites = false;

  constructor(readonly id = "memory") {}

  /** Adds a file at a path (folders created as needed); returns its id. */
  async put(path: string, bytes: string | Uint8Array<ArrayBuffer>, mime: string, modifiedAt = "2026-10-01T00:00:00Z") {
    const parts = path.split("/").filter(Boolean);
    const parent = parts.length > 1 ? this.mkdirs(parts.slice(0, -1)) : null;
    const b = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
    const id = `m${++this.n}`;
    const name = parts[parts.length - 1];
    this.nodes.set(id, {
      parent,
      bytes: b,
      entry: { id, name, mime, size: b.length, checksum: await sha256(b), modifiedAt, folder: false, parent },
    });
    return id;
  }

  private child(parent: string | null, name: string) {
    return [...this.nodes.values()].find((x) => x.parent === parent && x.entry.name === name);
  }

  private mkdirs(parts: string[]): string {
    let parent: string | null = null;
    for (const name of parts) {
      let node = this.child(parent, name);
      if (!node) {
        const id = `m${++this.n}`;
        node = {
          parent,
          bytes: new Uint8Array(),
          entry: { id, name, mime: "folder", size: 0, checksum: "", modifiedAt: "", folder: true, parent },
        };
        this.nodes.set(id, node);
      }
      parent = node.entry.id;
    }
    return parent as string;
  }

  private view(n: Node): MediaEntry {
    return { ...n.entry, parent: n.parent };
  }

  async stat(id: string) {
    const n = this.nodes.get(id);
    return n ? this.view(n) : null;
  }

  async stream(id: string, range?: string | null) {
    const node = this.nodes.get(id);
    if (!node || node.entry.folder) return new Response("not found", { status: 404 });
    const m = /^bytes=(\d+)-(\d*)$/.exec(range ?? "");
    if (!m) return new Response(node.bytes, { headers: { "Content-Length": String(node.bytes.length) } });
    const start = Number(m[1]);
    const end = Math.min(m[2] ? Number(m[2]) : node.bytes.length - 1, node.bytes.length - 1);
    const part = node.bytes.slice(start, end + 1);
    return new Response(part, {
      status: 206,
      headers: { "Content-Length": String(part.length), "Content-Range": `bytes ${start}-${end}/${node.bytes.length}` },
    });
  }

  async readText(id: string) {
    const node = this.nodes.get(id);
    if (!node) throw new Error(`memory text ${id}: missing`);
    return new TextDecoder().decode(node.bytes).slice(0, 20000);
  }

  async resolve(path: string) {
    let parent: string | null = null;
    let node: Node | undefined;
    for (const name of path.split("/").filter(Boolean)) {
      node = this.child(parent, name);
      if (!node) return null;
      parent = node.entry.id;
    }
    return node ? this.view(node) : null;
  }

  async inside(id: string, folderPath: string) {
    const folder = await this.resolve(folderPath);
    if (!folder?.folder) return false;
    let at = this.nodes.get(id)?.parent ?? null;
    for (let i = 0; i < MAX_DEPTH && at !== null; i++) {
      if (at === folder.id) return true;
      at = this.nodes.get(at)?.parent ?? null;
    }
    return false;
  }

  async list(folderId: string) {
    return [...this.nodes.values()].filter((x) => x.parent === folderId).map((x) => this.view(x));
  }

  async ensureFolder(path: string) {
    if (this.refuseWrites) throw new MediaRefused("memory store refuses writes");
    return this.mkdirs(path.split("/").filter(Boolean));
  }

  async move(id: string, toFolderPath: string) {
    const node = this.nodes.get(id);
    if (!node) throw new Error(`memory move ${id}: missing`);
    if (this.refuseWrites) throw new MediaRefused("memory store refuses writes");
    node.parent = this.mkdirs(toFolderPath.split("/").filter(Boolean));
  }
}
