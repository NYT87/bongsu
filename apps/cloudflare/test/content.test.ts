// The platform-neutral content model (Phase 4, docs/PLAN.md 2.10): a post has a format (or its media decide) and the
// platform's options; agents plan with format/options, the older kind/location still work.
import { env, exports } from "cloudflare:workers";
import { sha256Hex } from "@bongsu/core/formats/approved";
import { beforeEach, describe, expect, it } from "vitest";
import { clearPlan, testEnv } from "./world";

const KEY = "bongsu_contentcontentcontentconte";
const post = async (path: string, body: unknown) => {
  const r = await exports.default.fetch(`https://scheduler.test${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
};
const row = (key: string) =>
  env.DB.prepare("SELECT format, options FROM plan_items WHERE item_key = ?1").bind(key).first<{
    format: string | null;
    options: string;
  }>();
const base = { account: "demo_travel", folder: "vlogs/CONTENT/20261101_TRIP", date: "2026-11-01" };

beforeEach(async () => {
  await clearPlan();
  await env.DB.prepare("DELETE FROM api_keys").run();
  await env.DB.prepare("INSERT INTO api_keys (id, name, key_hash, scopes) VALUES ('k', 'content', ?1, ?2)")
    .bind(await sha256Hex(KEY), JSON.stringify(["read", "plan"]))
    .run();
  await testEnv(env);
});

describe("planning with format and options", () => {
  it("stores the format and the platform's options; the key keeps today's shape", async () => {
    const r = await post("/v1/plan", {
      ...base,
      name: "short1_bridge",
      format: "video",
      options: { location: "111", coverMs: 2300, trial: false },
    });
    expect(r.json).toMatchObject({ key: "reel:20261101_TRIP/short1_bridge", due: "2026-11-01 18:00 Asia/Seoul" });
    expect(await row("reel:20261101_TRIP/short1_bridge")).toEqual({
      format: "video",
      options: JSON.stringify({ location: "111", coverMs: 2300, trial: false }),
    });
    const s = await post("/v1/plan", { ...base, name: "posts/story1", format: "story", time: "09:00" });
    expect(s.json.key).toBe("post:20261101_TRIP/story1");
    expect((await row("post:20261101_TRIP/story1"))?.format).toBe("story");
    // no format: its media decide at approval; default time for a non-video 19:00
    const p = await post("/v1/plan", { ...base, name: "posts/carousel1" });
    expect(p.json.due).toBe("2026-11-01 19:00 Asia/Seoul");
    expect((await row("post:20261101_TRIP/carousel1"))?.format).toBeNull();
  });

  it("refuses formats and options the platform doesn't have", async () => {
    expect((await post("/v1/plan", { ...base, name: "x1", format: "text" })).json.error).toMatch(
      /format must be one of/,
    );
    expect(
      (await post("/v1/plan", { ...base, name: "x2", format: "video", options: { privacy: "public" } })).status,
    ).toBe(400);
    expect(
      (await post("/v1/plan", { ...base, name: "posts/x3", format: "image", options: { trial: true } })).json.error,
    ).toMatch(/doesn't apply to a image/);
    expect((await post("/v1/plan", { ...base, name: "x4", format: "video", options: { coverMs: -5 } })).status).toBe(
      400,
    );
  });

  it("the older kind and location still work", async () => {
    const r = await post("/v1/plan", { ...base, kind: "reel", name: "short2_old", location: "222" });
    expect(r.status).toBe(200);
    expect(await row("reel:20261101_TRIP/short2_old")).toEqual({ format: "video", options: '{"location":"222"}' });
    await post("/v1/plan", { ...base, kind: "post", format: "story", name: "posts/story2", time: "10:00" });
    expect((await row("post:20261101_TRIP/story2"))?.format).toBe("story");
    expect((await post("/v1/plan", { ...base, kind: "short", name: "x" })).status).toBe(400);
  });

  it("plan_update changes options (null removes one) and the queue shows format and options", async () => {
    const key = String((await post("/v1/plan", { ...base, name: "short3", format: "video" })).json.key);
    await post("/v1/plan/update", { key, options: { coverMs: 900, location: "333" } });
    await post("/v1/plan/update", { key, options: { location: null } });
    expect(JSON.parse((await row(key))!.options)).toEqual({ coverMs: 900 });
    const q = await exports.default.fetch("https://scheduler.test/v1/queue?days=30", {
      headers: { Authorization: `Bearer ${KEY}` },
    });
    const items = ((await q.json()) as { items: Record<string, unknown>[] }).items;
    expect(items.find((i) => i.key === key)).toMatchObject({
      format: "video",
      kind: "reel",
      options: { coverMs: 900 },
    });
  });
});

describe("platform names for the app and agents", () => {
  it("/app-api/platforms describes each platform; list_accounts says what can be planned", async () => {
    const r = (await (await exports.default.fetch("https://scheduler.test/app-api/platforms")).json()) as {
      platforms: { id: string; formats: { format: string; name: string }[]; features: Record<string, boolean> }[];
    };
    const ig = r.platforms.find((p) => p.id === "instagram")!;
    expect(ig.formats).toContainEqual({ format: "video", name: "Reel", plural: "Reels" });
    expect(ig.features.trial).toBe(true);
    expect(r.platforms.find((p) => p.id === "youtube")?.formats).toEqual([]);
    // and how each kind of account gets connected (for the dashboard's Connect screens)
    const conns = (r as unknown as { connections: { provider: string; kind: string; scopes?: string[] }[] })
      .connections;
    expect(conns.find((x) => x.provider === "instagram")).toMatchObject({ kind: "oauth2", pasteToken: true });
    expect(conns.find((x) => x.provider === "instagram")?.scopes).toContain("instagram_business_content_publish");
    expect(conns.find((x) => x.provider === "youtube")).toMatchObject({ kind: "oauth2" });
    const a = await exports.default.fetch("https://scheduler.test/v1/accounts", {
      headers: { Authorization: `Bearer ${KEY}` },
    });
    const accounts = ((await a.json()) as { accounts: Record<string, unknown>[] }).accounts;
    expect(accounts.find((x) => x.id === "demo_travel")).toMatchObject({
      platform: "instagram",
      platform_name: "Instagram",
      formats: expect.arrayContaining([{ format: "story", name: "Story" }]),
      features: expect.arrayContaining(["firstComment", "trial"]),
    });
  });

  it("queue items say what their platform calls them", async () => {
    await post("/v1/plan", { ...base, name: "short9", format: "video" });
    await post("/v1/plan", { ...base, name: "posts/p9", time: "20:00" });
    const q = await exports.default.fetch("https://scheduler.test/v1/queue?days=30", {
      headers: { Authorization: `Bearer ${KEY}` },
    });
    const items = ((await q.json()) as { items: { name: string; platform: string; label: string }[] }).items;
    expect(items.map((i) => [i.name, i.platform, i.label])).toEqual([
      ["short9", "instagram", "Reel"],
      ["posts/p9", "instagram", "Post"],
    ]);
  });
});
