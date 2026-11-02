// Signed, expiring links that stream a private file from the media store to Instagram:
//   GET|HEAD /m/<id>[.<ext>]?exp=<unix seconds>&sig=<hex HMAC-SHA256 of "<id>.<exp>">
// A store with publicUrl (presigned URLs) doesn't need them: Instagram fetches the store directly (mediaUrl).
import type { MediaStore } from "./media/store";

const utf8 = (s: string) => new TextEncoder().encode(s);
const hmacKey = (secret: string, use: "sign" | "verify") =>
  crypto.subtle.importKey("raw", utf8(secret), { name: "HMAC", hash: "SHA-256" }, false, [use]);

export async function signedLink(base: string, secret: string, id: string, ext: string, exp: number): Promise<string> {
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret, "sign"), utf8(`${id}.${exp}`));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${base.replace(/\/$/, "")}/m/${id}.${ext}?exp=${exp}&sig=${hex}`;
}

/** The URL a platform fetches a file from for `ttlS` seconds: the store's own presigned URL when it has one, else a
 *  signed /m/ link to this Worker. */
export async function mediaUrl(
  store: MediaStore,
  o: { base: string; secret: string; id: string; video: boolean; nowS: number; ttlS: number },
): Promise<string> {
  if (store.publicUrl) return store.publicUrl(o.id, o.ttlS);
  return signedLink(o.base, o.secret, o.id, o.video ? "mp4" : "jpg", o.nowS + o.ttlS);
}

async function validSig(secret: string, id: string, exp: string, sig: string): Promise<boolean> {
  if (!/^[0-9a-f]{64}$/.test(sig)) return false;
  const bytes = Uint8Array.from(sig.match(/../g)!, (h) => parseInt(h, 16));
  return crypto.subtle.verify("HMAC", await hmacKey(secret, "verify"), bytes, utf8(`${id}.${exp}`)); // constant-time
}

export async function serveMedia(req: Request, secret: string, store: MediaStore, nowS: number): Promise<Response> {
  const url = new URL(req.url);
  const m = url.pathname.match(/^\/m\/([A-Za-z0-9_-]{2,})(?:\.[a-z0-9]{2,4})?$/);
  if (!m || (req.method !== "GET" && req.method !== "HEAD")) return new Response("not found", { status: 404 });
  const id = m[1],
    exp = url.searchParams.get("exp") ?? "",
    sig = url.searchParams.get("sig") ?? "";
  if (!/^\d+$/.test(exp) || Number(exp) < nowS || !(await validSig(secret, id, exp, sig))) {
    return new Response("forbidden", { status: 403 });
  }
  const meta = await store.stat(id);
  if (!meta || meta.folder) return new Response("not found", { status: 404 });
  const common = {
    "Content-Type": meta.mime || "application/octet-stream",
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store",
  };
  if (req.method === "HEAD") return new Response(null, { headers: { ...common, "Content-Length": String(meta.size) } });
  const up = await store.stream(id, req.headers.get("Range"));
  if (!up.ok) return new Response("upstream error", { status: 502 });
  const h: Record<string, string> = {
    ...common,
    "Content-Length": up.headers.get("Content-Length") ?? String(meta.size),
  };
  const cr = up.headers.get("Content-Range");
  if (cr) h["Content-Range"] = cr;
  return new Response(up.body, { status: up.status, headers: h });
}
