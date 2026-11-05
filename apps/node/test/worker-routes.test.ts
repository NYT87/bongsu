import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// On Cloudflare the assets layer answers any path not listed in run_worker_first (with the SPA's index.html), so a
// route the app serves at the top level must be listed there. workerd tests can't read files; this one can.
const SERVED = ["/icon", "/m", "/health", "/v1", "/mcp", "/app-api", "/admin-api", "/dashboard"];

describe("wrangler.toml run_worker_first", () => {
  const toml = readFileSync(new URL("../../cloudflare/wrangler.toml", import.meta.url), "utf8");
  const list = /^run_worker_first\s*=\s*\[([^\]]*)\]/m.exec(toml)?.[1] ?? "";
  const patterns = [...list.matchAll(/"([^"]+)"/g)].map((m) => m[1]);

  it.each(SERVED)("lists %s", (prefix) => {
    expect(patterns.some((p) => p === prefix || p === `${prefix}/*`)).toBe(true);
  });

  it("reads the list", () => {
    expect(patterns.length).toBeGreaterThan(0);
  });
});
