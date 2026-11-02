// The ASSETS binding on Node: the built app (packages/web/dist, the dashboard inside it under dashboard/), served the
// way Workers assets serve it (apps/cloudflare/wrangler.toml): a folder's index.html, and the app's index.html for any
// other path without a file (a single-page app). The HTTP app sends here whatever its routes don't handle.
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json",
};

export function staticAssets(dir: string): { fetch(request: Request): Promise<Response> } {
  const root = resolve(dir);
  const file = async (path: string) => {
    const p = resolve(root, `.${path}`);
    if (p !== root && !p.startsWith(root + sep)) return null; // never outside the folder
    const s = await stat(p).catch(() => null);
    if (s?.isDirectory()) return file(`${path.replace(/\/$/, "")}/index.html`);
    return s?.isFile() ? p : null;
  };
  const send = async (p: string, method: string) => {
    // Vite's hashed bundles never change; everything else (index.html, sw.js, the manifest) is checked every time.
    const immutable = p.includes(`${sep}assets${sep}`);
    return new Response(method === "HEAD" ? null : await readFile(p), {
      headers: {
        "Content-Type": TYPES[extname(p)] ?? "application/octet-stream",
        "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
      },
    });
  };
  return {
    async fetch(request) {
      const url = new URL(request.url);
      let path: string;
      try {
        path = decodeURIComponent(url.pathname);
      } catch {
        return new Response("bad path", { status: 400 });
      }
      const found = await file(path);
      if (found) return send(found, request.method);
      // a path without a file: the app's page, unless it asked for a file by name
      if (extname(path) && !path.endsWith(".html")) return new Response("not found", { status: 404 });
      const index = await file("/index.html");
      return index ? send(index, request.method) : new Response("the app isn't built", { status: 404 });
    },
  };
}
