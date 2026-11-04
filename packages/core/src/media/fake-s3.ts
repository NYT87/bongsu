// A fake S3 bucket for tests: a fetch function that answers the requests the s3 store makes (HEAD, GET with Range,
// PUT, PUT with x-amz-copy-source, DELETE, ListObjectsV2), from a map. It checks each request is SigV4-signed (in a
// header, or a presigned query that hasn't expired) for its access key; it doesn't recompute signatures (the optional
// MinIO run does that against a real server).

export interface FakeObject {
  bytes: Uint8Array<ArrayBuffer>;
  type: string;
  etag: string;
  modified: Date;
}

const md5ish = async (b: Uint8Array<ArrayBuffer>) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", b))]
    .slice(0, 16)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");

const xmlEsc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export class FakeS3 {
  readonly objects = new Map<string, FakeObject>();
  /** Refuse every write with a 403, as a read-only key would. */
  refuseWrites = false;
  /** Every request, for tests that count them. */
  readonly log: { method: string; url: string }[] = [];
  now = () => new Date();

  constructor(readonly o: { host: string; bucket: string; accessKeyId: string }) {}

  async put(key: string, bytes: string | Uint8Array<ArrayBuffer>, type: string) {
    const b = typeof bytes === "string" ? (new TextEncoder().encode(bytes) as Uint8Array<ArrayBuffer>) : bytes;
    this.objects.set(key, { bytes: b, type, etag: `"${await md5ish(b)}"`, modified: this.now() });
  }

  /** The bucket and key a request names, path style or virtual-hosted. */
  private target(u: URL): { bucket: string; key: string } | null {
    const path = u.pathname.split("/").map(decodeURIComponent);
    if (u.host === this.o.host) return { bucket: path[1] ?? "", key: path.slice(2).join("/") };
    if (u.host === `${this.o.bucket}.${this.o.host}`) return { bucket: this.o.bucket, key: path.slice(1).join("/") };
    return null;
  }

  private signed(req: Request, u: URL): boolean {
    const auth = req.headers.get("Authorization") ?? "";
    if (auth.startsWith("AWS4-HMAC-SHA256 ")) return auth.includes(`Credential=${this.o.accessKeyId}/`);
    const cred = u.searchParams.get("X-Amz-Credential") ?? "";
    const date = u.searchParams.get("X-Amz-Date") ?? "";
    const exp = Number(u.searchParams.get("X-Amz-Expires"));
    if (!cred.startsWith(`${this.o.accessKeyId}/`) || !u.searchParams.get("X-Amz-Signature")) return false;
    const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(date);
    if (!m || !Number.isFinite(exp)) return false;
    const at = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    return this.now().getTime() <= at + exp * 1000;
  }

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    const u = new URL(req.url);
    this.log.push({ method: req.method, url: req.url });
    const t = this.target(u);
    if (!t) return new Response("unknown host", { status: 502 });
    if (t.bucket !== this.o.bucket) return new Response("<Error><Code>NoSuchBucket</Code></Error>", { status: 404 });
    if (!this.signed(req, u)) return new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 });
    const write = req.method === "PUT" || req.method === "DELETE";
    if (write && this.refuseWrites) return new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 });

    if (req.method === "GET" && !t.key && u.searchParams.get("list-type") === "2") return this.list(u);
    if (req.method === "HEAD" || req.method === "GET") {
      const o = this.objects.get(t.key);
      if (!o) return new Response(null, { status: 404 });
      const h: Record<string, string> = {
        "Content-Type": o.type,
        ETag: o.etag,
        "Last-Modified": o.modified.toUTCString(),
        "Accept-Ranges": "bytes",
      };
      const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.get("Range") ?? "");
      if (req.method === "HEAD")
        return new Response(null, { headers: { ...h, "Content-Length": String(o.bytes.length) } });
      if (!range) return new Response(o.bytes, { headers: { ...h, "Content-Length": String(o.bytes.length) } });
      const start = Number(range[1]);
      const end = Math.min(range[2] ? Number(range[2]) : o.bytes.length - 1, o.bytes.length - 1);
      const part = o.bytes.slice(start, end + 1);
      return new Response(part, {
        status: 206,
        headers: {
          ...h,
          "Content-Length": String(part.length),
          "Content-Range": `bytes ${start}-${end}/${o.bytes.length}`,
        },
      });
    }
    if (req.method === "PUT") {
      const source = req.headers.get("x-amz-copy-source");
      if (source) {
        const [, bucket, ...rest] = source.split("/").map(decodeURIComponent);
        const from = bucket === this.o.bucket ? this.objects.get(rest.join("/")) : undefined;
        if (!from) return new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 });
        this.objects.set(t.key, { ...from, modified: this.now() });
        return new Response(`<CopyObjectResult><ETag>${xmlEsc(from.etag)}</ETag></CopyObjectResult>`);
      }
      await this.put(
        t.key,
        new Uint8Array(await req.arrayBuffer()),
        req.headers.get("Content-Type") ?? "binary/octet-stream",
      );
      return new Response(null, { headers: { ETag: this.objects.get(t.key)!.etag } });
    }
    if (req.method === "DELETE") {
      this.objects.delete(t.key);
      return new Response(null, { status: 204 });
    }
    return new Response("not implemented", { status: 501 });
  };

  /** ListObjectsV2, with prefix, delimiter, max-keys and continuation tokens (the next key, as S3's are opaque). */
  private list(u: URL): Response {
    const prefix = u.searchParams.get("prefix") ?? "";
    const delimiter = u.searchParams.get("delimiter");
    const max = Number(u.searchParams.get("max-keys") ?? 1000);
    const after = u.searchParams.get("continuation-token") ?? "";
    const keys = [...this.objects.keys()].filter((k) => k.startsWith(prefix) && k > after).sort();
    // sorted, the keys under one common prefix are adjacent: each prefix is one entry, as in S3's listings
    const entries: { key?: string; prefix?: string }[] = [];
    for (const k of keys) {
      const rest = k.slice(prefix.length);
      const cut = delimiter ? rest.indexOf(delimiter) : -1;
      const p = cut >= 0 ? prefix + rest.slice(0, cut + 1) : null;
      if (p === null) entries.push({ key: k });
      else if (entries.at(-1)?.prefix !== p) entries.push({ prefix: p });
    }
    const page = entries.slice(0, max);
    const truncated = entries.length > max;
    const end = page.at(-1);
    // the next page starts after the last key, or after everything under the last prefix
    const last = end?.key ?? `${end?.prefix ?? ""}\uffff`;
    const contents = page
      .filter((e) => e.key)
      .map((e) => {
        const o = this.objects.get(e.key!)!;
        return `<Contents><Key>${xmlEsc(e.key!)}</Key><LastModified>${o.modified.toISOString()}</LastModified><ETag>${xmlEsc(o.etag)}</ETag><Size>${o.bytes.length}</Size></Contents>`;
      });
    const prefixes = page.filter((e) => e.prefix).map((e) => e.prefix!);
    const xml = `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${this.o.bucket}</Name><Prefix>${xmlEsc(prefix)}</Prefix><IsTruncated>${truncated}</IsTruncated>${truncated ? `<NextContinuationToken>${xmlEsc(last)}</NextContinuationToken>` : ""}${contents.join("")}${prefixes.map((p) => `<CommonPrefixes><Prefix>${xmlEsc(p)}</Prefix></CommonPrefixes>`).join("")}</ListBucketResult>`;
    return new Response(xml, { headers: { "Content-Type": "application/xml" } });
  }
}
