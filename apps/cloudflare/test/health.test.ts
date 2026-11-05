import { env, exports } from "cloudflare:workers";
import { createApp } from "@bongsu/api/app";
import { upsertConnection } from "@bongsu/core/accounts";
import { describe, expect, it } from "vitest";

describe("/health", () => {
  it("reports the migrated tables, the dry-run setting, no missing secrets and the media stores", async () => {
    await env.DB.prepare("DELETE FROM media_store").run();
    await env.DB.prepare(
      "INSERT INTO media_store (id, kind, is_default, settings, status, updated_at) VALUES ('s3', 's3', 1, '{}', 'ok', 0)",
    ).run();
    const res = await exports.default.fetch("https://scheduler.test/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      dry_run: env.DRY_RUN !== "0", // whatever wrangler.toml says (live since 2026-10-18)
      tables: ["api_keys", "audit", "drafts", "jobs", "locks", "push_subs"],
      missing_secrets: [],
      media_stores: [{ kind: "s3", status: "ok", default: true }],
    });
  });

  it("needs ENCRYPTION_KEY once a media store keeps credentials", async () => {
    await env.DB.prepare("DELETE FROM media_store").run();
    await env.DB.prepare(
      "INSERT INTO media_store (id, kind, is_default, settings, credentials, status, updated_at) VALUES ('s3', 's3', 1, '{}', 'x', 'ok', 0)",
    ).run();
    const r = await createApp(fetch).request(
      "https://scheduler.test/health",
      {},
      { ...env, ENCRYPTION_KEY: undefined },
    );
    expect(((await r.json()) as { missing_secrets: string[] }).missing_secrets).toContain("ENCRYPTION_KEY");
    await env.DB.prepare("DELETE FROM media_store").run();
  });

  it("needs ENCRYPTION_KEY once a workspace keeps its own OAuth app", async () => {
    await env.DB.prepare("DELETE FROM media_store").run();
    await env.DB.prepare("DELETE FROM workspace_oauth_apps").run();
    await env.DB.prepare(
      "INSERT INTO workspace_oauth_apps (workspace_id, id, client_id, client_secret, updated_at, updated_by) VALUES ('default', 'google', 'demo-client', 'x', 0, 'u')",
    ).run();
    const r = await createApp(fetch).request(
      "https://scheduler.test/health",
      {},
      { ...env, ENCRYPTION_KEY: undefined },
    );
    expect(((await r.json()) as { missing_secrets: string[] }).missing_secrets).toContain("ENCRYPTION_KEY");
    await env.DB.prepare("DELETE FROM workspace_oauth_apps").run();
  });

  it("asks for a connection kind's secret only when such a connection exists", async () => {
    const health = async (e: Record<string, unknown>) =>
      (await (await createApp(fetch).request("https://scheduler.test/health", {}, { ...env, ...e })).json()) as {
        missing_secrets: string[];
      };
    await env.DB.prepare("DELETE FROM accounts").run();
    await env.DB.prepare("DELETE FROM connections").run();
    expect((await health({ COMPOSIO_CONSUMER_KEY: undefined })).missing_secrets).toEqual([]); // no Composio connection
    await upsertConnection(
      env.DB,
      { workspaceId: "default", id: "c1", provider: "composio", kind: "composio", externalRef: "x" },
      0,
    );
    await upsertConnection(
      env.DB,
      { workspaceId: "default", id: "g1", provider: "instagram", kind: "oauth", secretName: "IG" },
      0,
    );
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
