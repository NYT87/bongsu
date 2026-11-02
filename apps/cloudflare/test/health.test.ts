import { env, exports } from "cloudflare:workers";
import { createApp } from "@bongsu/api/app";
import { upsertConnection } from "@bongsu/core/accounts";
import { describe, expect, it } from "vitest";

describe("/health", () => {
  it("reports the migrated tables, the dry-run setting and no missing secrets", async () => {
    const res = await exports.default.fetch("https://scheduler.test/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      dry_run: env.DRY_RUN !== "0", // whatever wrangler.toml says (live since 2026-10-18)
      tables: ["api_keys", "audit", "drafts", "jobs", "locks", "push_subs"],
      missing_secrets: [],
    });
  });

  it("asks for a connection kind's secret only when such a connection exists", async () => {
    const health = async (e: Record<string, unknown>) =>
      (await (await createApp(fetch).request("https://scheduler.test/health", {}, { ...env, ...e })).json()) as {
        missing_secrets: string[];
      };
    await env.DB.prepare("DELETE FROM accounts").run();
    await env.DB.prepare("DELETE FROM connections").run();
    expect((await health({ COMPOSIO_CONSUMER_KEY: undefined })).missing_secrets).toEqual([]); // no Composio connection
    await upsertConnection(env.DB, { id: "c1", provider: "composio", kind: "composio", externalRef: "x" }, 0);
    await upsertConnection(env.DB, { id: "g1", provider: "instagram", kind: "oauth", secretName: "IG" }, 0);
    expect((await health({ COMPOSIO_CONSUMER_KEY: undefined, ENCRYPTION_KEY: undefined })).missing_secrets).toEqual([
      "COMPOSIO_CONSUMER_KEY",
      "ENCRYPTION_KEY",
    ]);
    await env.DB.prepare("DELETE FROM connections").run();
  });

  it("answers unknown non-GET paths with 404 (GETs fall through to the app)", async () => {
    const res = await exports.default.fetch("https://scheduler.test/nope", { method: "POST" });
    expect(res.status).toBe(404);
  });
});
