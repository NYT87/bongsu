// Access in packages/api is decided by what the router matched, never by reading the request's path again. Hono
// matches the decoded path, so a guard that tests the raw URL (`new URL(c.req.url).pathname`) misses
// `/admin-api/%77orkspaces` while its handler still runs; the guards are tagged on route patterns instead
// (dashboard/routes.ts AREAS, pwa/routes.ts NEEDS). Reading the path stays allowed only for serving the static files.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "../..");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
  });
}

const found = (re: RegExp) => {
  const out: Record<string, number> = {};
  for (const f of files(join(ROOT, "api/src"))) {
    const n = readFileSync(f, "utf8").match(re)?.length ?? 0;
    if (n) out[relative(ROOT, f)] = n;
  }
  return out;
};

describe("the api's guards match what the router matched", () => {
  it("never read the raw URL's path", () => {
    expect(found(/\.pathname\b(?!\s*=[^=])/g)).toEqual({});
  });

  it("read the decoded path only to serve the apps' static files", () => {
    expect(found(/\bc\.req\.path\b/g)).toEqual({ "api/src/app.ts": 4 });
  });
});
