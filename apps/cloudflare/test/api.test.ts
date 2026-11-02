import { env, exports } from "cloudflare:workers";
import { withinRate } from "@bongsu/api/agent/auth";
import { TOOLS } from "@bongsu/api/agent/tools";
import { sha256Hex } from "@bongsu/core/formats/approved";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearPlan, seedAccounts, seedReel, World } from "./world";

const KEY_READ = "bongsu_readreadreadreadreadreadre";
const KEY_ALL = "bongsu_allallallallallallallallal";
// the default set: "reschedule" is opt-in, so this key never gets it
const ALL_SCOPES = ["read", "draft", "pause", "plan"];
const KEY_REVOKED = "bongsu_revokedrevokedrevokedrevok";

let w: World;
const origFetch = globalThis.fetch;

async function addKey(id: string, key: string, scopes: string[], revoked = false) {
  await env.DB.prepare("INSERT INTO api_keys (id, name, key_hash, scopes, revoked_at) VALUES (?1, ?2, ?3, ?4, ?5)")
    .bind(id, `test ${id}`, await sha256Hex(key), JSON.stringify(scopes), revoked ? 1 : null)
    .run();
}

const req = (path: string, key: string | null, init: RequestInit = {}) =>
  exports.default.fetch(`https://scheduler.test${path}`, {
    ...init,
    headers: {
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
const mcp = (key: string, method: string, params?: unknown, id: number | null = 1) =>
  req("/mcp", key, {
    method: "POST",
    body: JSON.stringify({ jsonrpc: "2.0", ...(id === null ? {} : { id }), method, ...(params ? { params } : {}) }),
  });

beforeEach(async () => {
  await seedAccounts();
  await env.DB.batch(
    [
      "DELETE FROM api_keys",
      "DELETE FROM drafts",
      "DELETE FROM audit",
      "DELETE FROM rate_limits",
      "DELETE FROM jobs",
    ].map((s) => env.DB.prepare(s)),
  );
  await addKey("k_read", KEY_READ, ["read"]);
  await addKey("k_all", KEY_ALL, ALL_SCOPES);
  await clearPlan();
  await addKey("k_rev", KEY_REVOKED, ["read"], true);
  w = new World();
  globalThis.fetch = w.fetch; // the routes use the global fetch (realFetch)
});
afterEach(() => {
  globalThis.fetch = origFetch;
});

describe("API keys", () => {
  it("refuses missing, unknown and revoked keys", async () => {
    expect((await req("/v1/status", null)).status).toBe(401);
    expect((await req("/v1/status", "bongsu_nopenopenopenopenopenopeno")).status).toBe(401);
    expect((await req("/v1/status", KEY_REVOKED)).status).toBe(401);
    expect((await req("/v1/status", KEY_READ)).status).toBe(200);
  });

  it("enforces scopes: a read key can't draft or pause", async () => {
    expect(
      (
        await req("/v1/drafts", KEY_READ, {
          method: "POST",
          body: JSON.stringify({ kind: "reel", account: "demo_travel", note: "x" }),
        })
      ).status,
    ).toBe(403);
    expect((await req("/v1/pause", KEY_READ, { method: "POST", body: JSON.stringify({ reason: "x" }) })).status).toBe(
      403,
    );
  });

  it("rate-limits each key to 60 requests a minute", async () => {
    const at = 1_800_000_000; // a fixed minute
    const ok: boolean[] = [];
    for (let i = 0; i < 61; i++) ok.push(await withinRate(env.DB, "k_x", at));
    expect(ok.slice(0, 60).every(Boolean)).toBe(true);
    expect(ok[60]).toBe(false);
    expect(await withinRate(env.DB, "k_x", at + 60)).toBe(true); // the next minute starts again
    // Over HTTP: a key already at 60 this minute gets 429.
    await env.DB.prepare("INSERT INTO rate_limits (key_id, window, n) VALUES ('k_read', ?1, 60)")
      .bind(Math.floor(Date.now() / 60000))
      .run();
    expect((await req("/v1/status", KEY_READ)).status).toBe(429);
  }, 90_000); // 61 D1 writes are slow in the local test runtime (more so under load)

  it("has no tool that approves, resumes or manages keys", () => {
    expect(TOOLS.map((t) => t.name).filter((n) => /approve|resume|key/i.test(n))).toEqual([]);
  });
});

describe("REST reads", () => {
  it("lists the queue with hold and approval state", async () => {
    await seedReel(w, { base: "short1_x" }); // approved
    await seedReel(w, { base: "short2_y", date: "2026-10-21", approve: false });
    const r = await req("/v1/queue?days=120", KEY_READ);
    const body = (await r.json()) as {
      items: { key: string; approved: boolean; approval_matches_schedule: boolean; due: string }[];
    };
    const byKey = Object.fromEntries(body.items.map((i) => [i.key, i]));
    expect(byKey["reel:20260823_LISBON/short1_x"]).toMatchObject({
      approved: true,
      approval_matches_schedule: true,
      due: "2026-10-20 18:00 Asia/Seoul",
    });
    expect(byKey["reel:20260823_LISBON/short2_y"]).toMatchObject({ approved: false });
  });

  it("returns one item's texts as they'd be published", async () => {
    await seedReel(w, { base: "short1_x" });
    const r = await req(`/v1/items/${encodeURIComponent("reel:20260823_LISBON/short1_x")}`, KEY_READ);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({
      caption: "A caption\n\nWhere next?\n\n#travel",
      comment: "📍 Somewhere. Have you been?",
      approval: { media: 1, matches_schedule: true },
      posted: null,
    });
    expect((await req(`/v1/items/${encodeURIComponent("reel:NOPE/x")}`, KEY_READ)).status).toBe(404);
  });
});

describe("drafts and pause", () => {
  it("creates a draft (audited) and withdraws it", async () => {
    const r = await req("/v1/drafts", KEY_ALL, {
      method: "POST",
      body: JSON.stringify({ kind: "reel", account: "demo_travel", caption: "Idea", date: "2026-11-01" }),
    });
    expect(r.status).toBe(200);
    const { id } = (await r.json()) as { id: string };
    const list = (await (await req("/v1/drafts", KEY_READ)).json()) as {
      drafts: { id: string; created_by: string; payload: { caption: string } }[];
    };
    expect(list.drafts).toHaveLength(1);
    expect(list.drafts[0]).toMatchObject({ id, created_by: "key:k_all", payload: { caption: "Idea" } });
    expect((await req(`/v1/drafts/${id}/withdraw`, KEY_ALL, { method: "POST" })).status).toBe(200);
    expect(
      (await env.DB.prepare("SELECT action FROM audit WHERE actor = 'key:k_all' ORDER BY id").all()).results.map(
        (r) => r.action,
      ),
    ).toEqual(["draft_create", "draft_withdraw"]);
  });

  it("validates drafts", async () => {
    const bad = (b: object) =>
      req("/v1/drafts", KEY_ALL, { method: "POST", body: JSON.stringify(b) }).then((r) => r.status);
    expect(await bad({ kind: "story", account: "demo_travel", note: "x" })).toBe(400);
    expect(await bad({ kind: "reel", account: "someone_else", note: "x" })).toBe(400);
    expect(await bad({ kind: "reel", account: "demo_travel" })).toBe(400);
    expect(await bad({ kind: "reel", account: "demo_travel", note: "x", date: "20/10" })).toBe(400);
  });

  it("pauses (in D1, never in the repo), once", async () => {
    const first = await (
      await req("/v1/pause", KEY_ALL, { method: "POST", body: JSON.stringify({ reason: "caption typo" }) })
    ).json();
    expect(first).toMatchObject({ paused: true });
    const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'paused'").first<{ value: string }>();
    expect(JSON.parse(row!.value)).toMatchObject({ reason: "caption typo", by: 'API key "test k_all"' });
    expect(
      await (await req("/v1/pause", KEY_ALL, { method: "POST", body: JSON.stringify({ reason: "again" }) })).json(),
    ).toMatchObject({ already: true });
    expect(await (await req("/v1/status", KEY_READ)).json()).toMatchObject({ paused: true });
  });
});

describe("MCP", () => {
  it("initializes, acknowledges notifications, and lists only the tools the key may use", async () => {
    const init = (await (
      await mcp(KEY_READ, "initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "t", version: "0" },
      })
    ).json()) as { result: { protocolVersion: string; serverInfo: { name: string } } };
    expect(init.result).toMatchObject({ protocolVersion: "2025-06-18", serverInfo: { name: "bongsu" } });
    expect((await mcp(KEY_READ, "notifications/initialized", undefined, null)).status).toBe(202);
    const readTools = (await (await mcp(KEY_READ, "tools/list")).json()) as { result: { tools: { name: string }[] } };
    expect(readTools.result.tools.map((t) => t.name)).not.toContain("create_draft");
    const allTools = (await (await mcp(KEY_ALL, "tools/list")).json()) as { result: { tools: { name: string }[] } };
    expect(allTools.result.tools.map((t) => t.name)).toEqual(
      TOOLS.filter((t) => ALL_SCOPES.includes(t.scope)).map((t) => t.name),
    );
    expect(allTools.result.tools.map((t) => t.name)).not.toContain("youtube_reschedule");
  });

  it("calls tools, and reports a scope error as a tool error", async () => {
    await seedReel(w, { base: "short1_x" });
    const q = (await (await mcp(KEY_READ, "tools/call", { name: "list_queue", arguments: { days: 120 } })).json()) as {
      result: { isError: boolean; structuredContent: { items: unknown[] } };
    };
    expect(q.result.isError).toBe(false);
    expect(q.result.structuredContent.items).toHaveLength(1);
    const denied = (await (
      await mcp(KEY_READ, "tools/call", { name: "pause_scheduler", arguments: { reason: "x" } })
    ).json()) as { result: { isError: boolean; content: { text: string }[] } };
    expect(denied.result).toMatchObject({ isError: true });
    expect(denied.result.content[0].text).toContain('"pause" scope');
    expect(await env.DB.prepare("SELECT 1 FROM settings WHERE key = 'paused'").first()).toBeNull();
  });

  it("rejects calls without a key", async () => {
    expect((await req("/mcp", null, { method: "POST", body: "{}" })).status).toBe(401);
  });
});

describe("editing the plan (scope plan)", () => {
  const post = (path: string, body: object, key = KEY_ALL) =>
    req(path, key, { method: "POST", body: JSON.stringify(body) });

  it("adds, reschedules, holds and removes items; a read key can't", async () => {
    const add = {
      kind: "reel",
      account: "demo_travel",
      folder: "vlogs/CONTENT/20260823_LISBON",
      name: "short9_new",
      date: "2026-11-01",
      time: "17:00",
    };
    expect((await post("/v1/plan", add, KEY_READ)).status).toBe(403);
    // 17:00 in the workspace's zone (Asia/Seoul) is stored as the UTC instant, 08:00Z
    expect(await (await post("/v1/plan", add)).json()).toEqual({
      key: "reel:20260823_LISBON/short9_new",
      added: true,
      due: "2026-11-01 17:00 Asia/Seoul",
      due_at: "2026-11-01T08:00:00Z",
    });
    expect((await post("/v1/plan", add)).status).toBe(409);
    expect(
      await (
        await post("/v1/plan/update", { key: "reel:20260823_LISBON/short9_new", date: "2026-11-02", hold: true })
      ).json(),
    ).toMatchObject({
      due: "2026-11-02 17:00 Asia/Seoul",
      due_at: "2026-11-02T08:00:00Z",
      hold: true,
      approved: false,
    });
    expect((await post("/v1/plan/update", { key: "reel:20260823_LISBON/short9_new", date: "2/11" })).status).toBe(400);
    expect((await post("/v1/plan/remove", { key: "reel:20260823_LISBON/short9_new" })).status).toBe(200);
    expect((await post("/v1/plan/remove", { key: "reel:20260823_LISBON/short9_new" })).status).toBe(404);
  });

  it("takes an instant with its zone (at), stores UTC, and refuses one without a zone", async () => {
    const add = {
      kind: "post",
      account: "demo_travel",
      folder: "vlogs/CONTENT/20260823_LISBON",
      name: "posts/carousel9_at",
      at: "2026-11-03T12:30:00+02:00",
    };
    expect(await (await post("/v1/plan", add)).json()).toMatchObject({
      due: "2026-11-03 19:30 Asia/Seoul",
      due_at: "2026-11-03T10:30:00Z",
    });
    const row = await env.DB.prepare(
      "SELECT due_at FROM plan_items WHERE item_key = 'post:20260823_LISBON/carousel9_at'",
    ).first("due_at");
    expect(row).toBe(Date.UTC(2026, 10, 3, 10, 30) / 1000);
    const key = "post:20260823_LISBON/carousel9_at";
    expect((await post("/v1/plan/update", { key, at: "2026-11-04T10:30" })).status).toBe(400);
    expect(await (await post("/v1/plan/update", { key, at: "2026-11-04T01:00:00Z" })).json()).toMatchObject({
      due: "2026-11-04 10:00 Asia/Seoul",
    });
    // a time alone keeps the date; a date alone keeps the time
    expect(await (await post("/v1/plan/update", { key, time: "21:15" })).json()).toMatchObject({
      due_at: "2026-11-04T12:15:00Z",
    });
    expect(await (await post("/v1/plan/update", { key, date: "2026-11-05" })).json()).toMatchObject({
      due_at: "2026-11-05T12:15:00Z",
    });
    expect(await (await post("/v1/plan/update", { key, date: null })).json()).toMatchObject({
      due: null,
      due_at: null,
    });
  });

  it("says when a reschedule breaks an approval", async () => {
    await seedReel(w, { base: "short1_x" });
    const r = await (await post("/v1/plan/update", { key: "reel:20260823_LISBON/short1_x", time: "20:00" })).json();
    expect(r).toMatchObject({ approved: false, note: expect.stringContaining("approve again") });
  });

  it("records manual posts and comments, once", async () => {
    await seedReel(w, { base: "short1_x" });
    expect(
      await (
        await post("/v1/posted", { key: "reel:20260823_LISBON/short1_x", media_id: "m1", permalink: "https://x/" })
      ).json(),
    ).toMatchObject({ recorded: true });
    expect(await (await post("/v1/posted", { key: "reel:20260823_LISBON/short1_x" })).json()).toMatchObject({
      recorded: false,
    });
    expect(
      await env.DB.prepare("SELECT published_at FROM posted WHERE item_key = 'reel:20260823_LISBON/short1_x'").first(
        "published_at",
      ),
    ).toEqual(expect.any(Number));
    await post("/v1/posted", {
      key: "reel:20260823_LISBON/short2_y",
      account: "demo_travel",
      date: "2026-10-01",
      published_at: "2026-10-01T03:31:00+0000",
    });
    expect(
      await env.DB.prepare("SELECT published_at FROM posted WHERE item_key = 'reel:20260823_LISBON/short2_y'").first(
        "published_at",
      ),
    ).toBe(Date.UTC(2026, 9, 1, 3, 31) / 1000);
    expect(
      (
        await post("/v1/posted", {
          key: "reel:20260823_LISBON/short3_z",
          account: "demo_travel",
          published_at: "yesterday",
        })
      ).status,
    ).toBe(400);
    expect((await post("/v1/plan/remove", { key: "reel:20260823_LISBON/short1_x" })).status).toBe(409); // published: kept as history
    expect(
      (
        await post("/v1/shorts", {
          video_id: "abcdefghijk",
          channel: "main",
          file: "channels/main/x.comment.txt",
          label: "s1",
        })
      ).status,
    ).toBe(200);
    expect((await post("/v1/shorts/commented", { video_id: "abcdefghijk", thread_id: "t1" })).status).toBe(200);
    expect((await env.DB.prepare("SELECT source FROM shorts_commented").first<{ source: string }>())?.source).toBe(
      "manual",
    );
  });
});

describe("queue filters", () => {
  it("filters by channel and group in the query, and lists the groups", async () => {
    await seedReel(w, { base: "short1_x" }); // vlogs / 20260823_LISBON
    const { planItem } = await import("./world");
    await planItem({ folder: "main/CONTENT/20260101_TRIP", name: "short5_ferry", date: "2026-10-21" });
    await planItem({ folder: "vlogs/CONTENT/20260923_JAPAN", name: "short6_hiroshima", date: "2026-10-22" });
    const keys = async (qs: string) =>
      ((await (await req(`/v1/queue?days=120&${qs}`, KEY_READ)).json()) as { items: { key: string }[] }).items.map(
        (i) => i.key,
      );
    expect(await keys("channel=main")).toEqual(["reel:20260101_TRIP/short5_ferry"]);
    expect(await keys("channel=vlogs")).toEqual([
      "reel:20260823_LISBON/short1_x",
      "reel:20260923_JAPAN/short6_hiroshima",
    ]);
    expect(await keys("group=20260923_JAPAN")).toEqual(["reel:20260923_JAPAN/short6_hiroshima"]);
    expect(await keys("channel=main&group=20260923_JAPAN")).toEqual([]);
    expect((await req("/v1/queue?group=../x%27", KEY_READ)).status).toBe(400);
    const g = (await (await req("/v1/queue/groups?days=120", KEY_READ)).json()) as {
      channels: { channel: string; n: number }[];
      groups: { channel: string; group: string; n: number }[];
    };
    expect(g.channels).toEqual([
      { channel: "main", n: 1 },
      { channel: "vlogs", n: 2 },
    ]);
    expect(g.groups.map((x) => `${x.channel}/${x.group}:${x.n}`)).toEqual([
      "main/20260101_TRIP:1",
      "vlogs/20260823_LISBON:1",
      "vlogs/20260923_JAPAN:1",
    ]);
  });
});

describe("one item per account per hour", () => {
  const post = (path: string, body: object, key = KEY_ALL) =>
    req(path, key, { method: "POST", body: JSON.stringify(body) });

  it("refuses adding or moving an item into an hour the account already uses; other hours are fine", async () => {
    const add = (name: string, date: string, time?: string, account = "demo_travel") =>
      post("/v1/plan", {
        kind: "reel",
        account,
        folder: "vlogs/CONTENT/20260823_LISBON",
        name,
        date,
        ...(time ? { time } : {}),
      });
    expect((await add("short1_a", "2026-10-24")).status).toBe(200); // 18:00 (the Reel default)
    const clash = await add("short2_b", "2026-10-24", "18:30");
    expect(clash.status).toBe(409);
    expect(((await clash.json()) as { error: string }).error).toMatch(
      /already has reel:20260823_LISBON\/short1_a at 2026-10-24 18:00 Asia\/Seoul:/,
    );
    expect((await add("short2_b", "2026-10-24", "21:00")).status).toBe(200); // same day, another hour
    expect((await add("short3_c", "2026-10-24", "18:00", "demo_running")).status).toBe(200); // another account
    expect((await post("/v1/plan/update", { key: "reel:20260823_LISBON/short2_b", time: "18:15" })).status).toBe(409);
    expect((await post("/v1/plan/update", { key: "reel:20260823_LISBON/short2_b", time: "20:00" })).status).toBe(200);
    expect((await post("/v1/plan/update", { key: "reel:20260823_LISBON/short1_a", time: "18:45" })).status).toBe(200); // its own slot
  });
});
