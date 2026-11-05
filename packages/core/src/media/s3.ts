// An S3-compatible bucket as a media store (MEDIA kind "s3"): AWS S3, Cloudflare R2, Backblaze B2, MinIO and the like,
// signed with SigV4 (aws4fetch: web-standard, so the same code runs on Workers and Node). Paths are keys under the
// store's prefix; a folder is a key prefix ending in "/" (with an empty marker object once Bongsu creates it). Ids are
// the key relative to the prefix, base64url-encoded: opaque, and safe in the /m/ links. A key is the file's only name,
// so a moved file gets a new id; nothing reads an id after the cleanup's move (docs/media-stores.md). Instagram fetches
// presigned URLs and the app uploads to presigned PUTs, so media never passes through Bongsu. A move copies, then
// removes the original once every copy is made: nothing leaves the bucket.
import { AwsClient } from "aws4fetch";
import { type MediaEntry, MediaRefused, type MediaStore, type UploadTarget } from "./store";

export interface S3Settings {
  /** https://s3.eu-west-1.amazonaws.com, https://<account>.r2.cloudflarestorage.com, http://minio:9000 … */
  endpoint: string;
  /** "auto" for R2. */
  region: string;
  bucket: string;
  /** The store's root inside the bucket ("bongsu/"), or "" for the whole bucket. */
  prefix?: string;
  /** https://endpoint/bucket/key instead of https://bucket.endpoint/key (MinIO, most self-hosted services). */
  pathStyle?: boolean;
}

export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
}

/** The longest a presigned URL may last (SigV4 allows seven days). */
const MAX_TTL_S = 7 * 86400;
/** How long the app has to send a file to a presigned PUT. */
const UPLOAD_TTL_S = 3600;

const TYPES: Record<string, string> = {
  mp4: "video/mp4",
  mov: "video/quicktime",
  m4v: "video/x-m4v",
  webm: "video/webm",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  heic: "image/heic",
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
};
const mimeOf = (name: string) => TYPES[/\.([^.]+)$/.exec(name)?.[1]?.toLowerCase() ?? ""] ?? "application/octet-stream";

const b64url = {
  encode: (s: string) => {
    const bytes = new TextEncoder().encode(s);
    return btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  },
  /** null when it isn't one of ours. */
  decode: (id: string): string | null => {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) return null;
    try {
      const bin = atob(id.replace(/-/g, "+").replace(/_/g, "/"));
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
        Uint8Array.from(bin, (c) => c.charCodeAt(0)),
      );
    } catch {
      return null;
    }
  },
};

/** "a//b/" → "a/b": a logical path without empty segments. */
const clean = (path: string) => path.split("/").filter(Boolean).join("/");
/** RFC 3986 for one path segment (S3 signs the encoded path). */
const seg = (s: string) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const encodeKey = (key: string) => key.split("/").map(seg).join("/");
const baseName = (rel: string) => rel.replace(/\/$/, "").split("/").pop() ?? "";
/** The folder a key is in, as a relative prefix ("a/b/"), or null at the root. */
const parentOf = (rel: string) => {
  const i = rel.replace(/\/$/, "").lastIndexOf("/");
  return i < 0 ? null : rel.slice(0, i + 1);
};

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unxml = (s: string) =>
  s.replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos);/gi, (_, e: string) =>
    e.startsWith("#")
      ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1)))
      : XML_ENTITIES[e.toLowerCase()],
  );
/** Each <tag>…</tag> in a piece of XML (S3's listings are flat enough not to need a parser, which Workers lack). */
const tags = (xml: string, tag: string) =>
  [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g"))].map((m) => m[1]);
const tag = (xml: string, name: string) => {
  const v = tags(xml, name)[0];
  return v === undefined ? undefined : unxml(v);
};
/** An ETag without its quotes (and weak marker): the checksum. */
const etag = (v: string | null | undefined) => (v ?? "").replace(/^W\//, "").replace(/"/g, "");

interface Listed {
  files: { rel: string; size: number; checksum: string; modifiedAt: string }[];
  folders: string[];
}

export class S3Store implements MediaStore {
  private readonly aws: AwsClient;
  private readonly prefix: string;

  constructor(
    private readonly s: S3Settings,
    credentials: S3Credentials,
    private readonly fetcher: typeof fetch,
    readonly id = "s3",
  ) {
    this.aws = new AwsClient({
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      service: "s3",
      region: s.region || "auto",
      retries: 0,
    });
    const p = clean(s.prefix ?? "");
    this.prefix = p ? `${p}/` : "";
  }

  // ---------------------------------------------------------------- requests

  /** The bucket's URL, with a key (relative to the prefix) and a query. */
  private url(rel: string | null, query: Record<string, string> = {}) {
    const ep = new URL(this.s.endpoint.replace(/\/+$/, ""));
    const base = this.s.pathStyle
      ? `${ep.origin}${ep.pathname.replace(/\/$/, "")}/${seg(this.s.bucket)}`
      : `${ep.protocol}//${this.s.bucket}.${ep.host}${ep.pathname.replace(/\/$/, "")}`;
    const u = new URL(rel === null ? `${base}/` : `${base}/${encodeKey(this.prefix + rel)}`);
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
    return u.toString();
  }

  private async send(url: string, init: RequestInit = {}) {
    // aws4fetch signs; the request goes out through the instance's fetch (the tests' fake world)
    return this.fetcher(await this.aws.sign(url, init));
  }

  private refused(r: Response, what: string): never {
    if (r.status === 403) throw new MediaRefused(`the bucket refused ${what} (403)`);
    throw new Error(`s3 ${what}: ${r.status}`);
  }

  /** One page of ListObjectsV2 under a relative prefix; all pages when `all`. Without a delimiter: every key below. */
  private async listing(relPrefix: string, o: { delimiter?: boolean; max?: number; all?: boolean }): Promise<Listed> {
    const out: Listed = { files: [], folders: [] };
    let token: string | undefined;
    do {
      const q: Record<string, string> = { "list-type": "2", prefix: this.prefix + relPrefix };
      if (o.delimiter) q.delimiter = "/";
      if (o.max) q["max-keys"] = String(o.max);
      if (token) q["continuation-token"] = token;
      const r = await this.send(this.url(null, q));
      if (!r.ok) this.refused(r, `listing ${relPrefix || "/"}`);
      const xml = await r.text();
      for (const c of tags(xml, "Contents")) {
        const key = tag(c, "Key") ?? "";
        out.files.push({
          rel: key.slice(this.prefix.length),
          size: Number(tag(c, "Size") ?? 0),
          checksum: etag(tag(c, "ETag")),
          modifiedAt: tag(c, "LastModified") ?? "",
        });
      }
      for (const p of tags(xml, "CommonPrefixes")) out.folders.push((tag(p, "Prefix") ?? "").slice(this.prefix.length));
      token = o.all && tag(xml, "IsTruncated") === "true" ? tag(xml, "NextContinuationToken") : undefined;
    } while (token);
    return out;
  }

  private folderEntry(rel: string): MediaEntry {
    const p = parentOf(rel);
    return {
      id: b64url.encode(rel),
      name: baseName(rel),
      mime: "folder",
      size: 0,
      checksum: "",
      modifiedAt: "",
      folder: true,
      parent: p === null ? null : b64url.encode(p),
    };
  }

  private fileEntry(rel: string, f: { size: number; checksum: string; modifiedAt: string; mime?: string }): MediaEntry {
    const p = parentOf(rel);
    const name = baseName(rel);
    const mime = f.mime && f.mime !== "application/octet-stream" && f.mime !== "binary/octet-stream" ? f.mime : "";
    return {
      id: b64url.encode(rel),
      name,
      mime: mime || mimeOf(name),
      size: f.size,
      checksum: f.checksum,
      modifiedAt: f.modifiedAt ? new Date(f.modifiedAt).toISOString() : "",
      folder: false,
      parent: p === null ? null : b64url.encode(p),
    };
  }

  /** A file's entry from a HEAD, or null. */
  private async head(rel: string): Promise<MediaEntry | null> {
    const r = await this.send(this.url(rel), { method: "HEAD" });
    if (r.status === 404) return null;
    if (!r.ok) this.refused(r, `reading ${rel}`);
    return this.fileEntry(rel, {
      size: Number(r.headers.get("Content-Length") ?? 0),
      checksum: etag(r.headers.get("ETag")),
      modifiedAt: r.headers.get("Last-Modified") ?? "",
      mime: r.headers.get("Content-Type") ?? undefined,
    });
  }

  /** A folder's entry when anything (its marker included) is under the prefix. */
  private async folder(relPrefix: string): Promise<MediaEntry | null> {
    const l = await this.listing(relPrefix, { max: 1 });
    return l.files.length ? this.folderEntry(relPrefix) : null;
  }

  // ---------------------------------------------------------------- the interface

  async stat(id: string) {
    const rel = b64url.decode(id);
    if (!rel) return null;
    return rel.endsWith("/") ? this.folder(rel) : this.head(rel);
  }

  async stream(id: string, range?: string | null) {
    const rel = b64url.decode(id);
    if (!rel || rel.endsWith("/")) return new Response("not found", { status: 404 });
    const r = await this.send(this.url(rel), { headers: range ? { Range: range } : {} });
    if (r.status === 404) return new Response("not found", { status: 404 });
    return r;
  }

  async readText(id: string) {
    const r = await this.stream(id);
    if (!r.ok) throw new Error(`s3 text: ${r.status}`);
    return (await r.text()).slice(0, 20000);
  }

  async resolve(path: string) {
    const rel = clean(path);
    if (!rel) return null;
    return (await this.head(rel)) ?? (await this.folder(`${rel}/`));
  }

  async inside(id: string, folderPath: string) {
    const rel = b64url.decode(id);
    const folder = clean(folderPath);
    // the key says where it is: the trailing slash keeps "inbox/tr" from matching "inbox/trip"
    return !!rel && !!folder && rel.startsWith(`${folder}/`) && rel.length > folder.length + 1;
  }

  async list(folderId: string) {
    const rel = b64url.decode(folderId);
    if (rel === null || (rel && !rel.endsWith("/"))) return [];
    const l = await this.listing(rel, { delimiter: true, all: true });
    return [
      ...l.folders.map((f) => this.folderEntry(f)),
      ...l.files.filter((f) => f.rel !== rel).map((f) => this.fileEntry(f.rel, f)),
    ];
  }

  async ensureFolder(path: string) {
    const rel = `${clean(path)}/`;
    const r = await this.send(this.url(rel), { method: "PUT", body: "" });
    if (!r.ok) this.refused(r, `creating ${rel}`);
    return b64url.encode(rel);
  }

  async move(id: string, toFolderPath: string) {
    const rel = b64url.decode(id);
    if (!rel) throw new Error("s3 move: not an id of this store");
    const to = `${clean(toFolderPath)}/`;
    await this.ensureFolder(to);
    const isFolder = rel.endsWith("/");
    const target = `${to}${baseName(rel)}${isFolder ? "/" : ""}`;
    if (target === rel) return;
    // every key to move (a folder: everything below it, its marker included) → its new key
    const keys = isFolder ? (await this.listing(rel, { all: true })).files.map((f) => f.rel) : [rel];
    if (!keys.length) throw new Error(`s3 move ${rel}: gone`);
    for (const k of keys) {
      const r = await this.send(this.url(target + k.slice(rel.length)), {
        method: "PUT",
        headers: { "x-amz-copy-source": `/${seg(this.s.bucket)}/${encodeKey(this.prefix + k)}` },
      });
      if (!r.ok) this.refused(r, `copying ${k}`);
      // a copy can fail after its 200 has been sent: the error is then in the body
      if ((await r.text()).includes("<Error>")) throw new Error(`s3 copying ${k}: the bucket reported an error`);
    }
    // only once every copy exists: the originals go
    for (const k of keys) {
      const r = await this.send(this.url(k), { method: "DELETE" });
      if (!r.ok && r.status !== 404) this.refused(r, `removing ${k} after copying it`);
    }
  }

  async publicUrl(id: string, ttlS: number) {
    const rel = b64url.decode(id);
    if (!rel) throw new Error("s3: not an id of this store");
    const ttl = Math.max(1, Math.min(Math.floor(ttlS), MAX_TTL_S));
    const req = await this.aws.sign(this.url(rel, { "X-Amz-Expires": String(ttl) }), {
      method: "GET",
      aws: { signQuery: true },
    });
    return req.url;
  }

  async createUpload(name: string, folderPath: string, mime: string): Promise<UploadTarget> {
    // a random suffix: an upload never replaces a file of the same name
    const safe = name.replace(/[^A-Za-z0-9_.-]+/g, "_").slice(-80) || "upload";
    const dot = safe.lastIndexOf(".");
    const suffix = crypto.randomUUID().slice(0, 8);
    const file = dot > 0 ? `${safe.slice(0, dot)}-${suffix}${safe.slice(dot)}` : `${safe}-${suffix}`;
    const rel = `${clean(folderPath)}/${file}`;
    const req = await this.aws.sign(this.url(rel, { "X-Amz-Expires": String(UPLOAD_TTL_S) }), {
      method: "PUT",
      headers: { "Content-Type": mime },
      aws: { signQuery: true },
    });
    return { url: req.url, method: "PUT", headers: { "Content-Type": mime }, id: b64url.encode(rel), chunked: false };
  }
}
