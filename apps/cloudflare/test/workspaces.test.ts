// Workspace isolation (Phase 3): an agent key only sees and changes its own workspace's plan, drafts, jobs and
// accounts; the scheduler serves every workspace, each in its own time zone.
import { env, exports } from "cloudflare:workers";
import { resolveItem } from "@bongsu/api/pwa/approve";
import { createSession } from "@bongsu/api/pwa/session";
import { upsertAccount, upsertConnection } from "@bongsu/core/accounts";
import { sha256Hex } from "@bongsu/core/formats/approved";
import { tick } from "@bongsu/core/tick";
import { setWorkspaceSettings } from "@bongsu/core/workspaces";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearPlan, seedReel, testEnv, World } from "./world";

const KEY_A = "bongsu_workspaceAworkspaceAworksp";
const KEY_B = "bongsu_workspaceBworkspaceBworksp";
const origFetch = globalThis.fetch;
let w: World;

async function addKey(id: string, key: string, workspace: string) {
  await env.DB.prepare(
    'INSERT INTO api_keys (id, name, key_hash, scopes, workspace_id) VALUES (?1, ?1, ?2, \'["read","draft","plan","reschedule"]\', ?3)',
  )
    .bind(id, await sha256Hex(key), workspace)
    .run();
}

const call = async (key: string, path: string, body?: unknown) => {
  const r = await exports.default.fetch(`https://scheduler.test${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
};

beforeEach(async () => {
  w = new World();
  globalThis.fetch = w.fetch;
  await clearPlan();
  await env.DB.batch(["DELETE FROM api_keys", "DELETE FROM drafts", "DELETE FROM jobs"].map((s) => env.DB.prepare(s)));
  await testEnv(env);
  await env.DB.prepare(
    "INSERT INTO workspaces (id, name, created_at) VALUES ('b', 'Workspace B', 0) ON CONFLICT (id) DO NOTHING",
  ).run();
  await setWorkspaceSettings(env.DB, "b", { timezone: "Europe/Madrid", digestHour: 8 }, 0);
  await upsertConnection(
    env.DB,
    { id: "c_b", workspaceId: "b", provider: "composio", kind: "composio", externalRef: "instagram_conn-b2" },
    0,
  );
  await upsertAccount(
    env.DB,
    {
      id: "b_shop",
      workspaceId: "b",
      platform: "instagram",
      handle: "b_shop",
      externalId: "17841400000000099",
      connectionId: "c_b",
    },
    0,
  );
  await addKey("ka", KEY_A, "default");
  await addKey("kb", KEY_B, "b");
});
afterEach(() => {
  globalThis.fetch = origFetch;
});

describe("an agent key in workspace B", () => {
  it("doesn't see or touch workspace A's items", async () => {
    const { key } = await seedReel(w, { date: "2026-10-30" }); // workspace A (default), demo_travel
    expect((await call(KEY_A, `/v1/items/${encodeURIComponent(key)}`)).status).toBe(200);
    expect((await call(KEY_B, `/v1/items/${encodeURIComponent(key)}`)).status).toBe(404);
    const queueB = (await call(KEY_B, "/v1/queue?days=30")).json as { items: unknown[] };
    expect(queueB.items).toEqual([]);
    expect((await call(KEY_B, "/v1/plan/update", { key, date: "2026-10-31" })).status).toBe(404);
    expect((await call(KEY_B, "/v1/plan/remove", { key })).status).toBe(404);
    expect((await call(KEY_A, `/v1/items/${encodeURIComponent(key)}`)).json).toMatchObject({
      key,
      due: "2026-10-30 18:00 Asia/Seoul",
    });
  });

  it("plans only for its own accounts, and its items stay its own", async () => {
    const own = {
      kind: "reel",
      account: "b_shop",
      folder: "shop/CONTENT/20261101_LAUNCH",
      name: "short1_launch",
      date: "2026-11-01",
      caption: "Hi",
    };
    expect((await call(KEY_B, "/v1/plan", { ...own, account: "demo_travel" })).status).toBe(400);
    const added = await call(KEY_B, "/v1/plan", own);
    expect(added.status).toBe(200);
    const key = String(added.json.key);
    expect((await call(KEY_A, `/v1/items/${encodeURIComponent(key)}`)).status).toBe(404);
    const row = await env.DB.prepare("SELECT workspace_id FROM plan_items WHERE item_key = ?1").bind(key).first();
    expect(row).toEqual({ workspace_id: "b" });
    const status = (await call(KEY_B, "/v1/status")).json;
    expect(status).toMatchObject({ accounts: ["b_shop"], timezone: "Europe/Madrid" });
    expect((await call(KEY_A, "/v1/status")).json).toMatchObject({ timezone: "Asia/Seoul" });
  });

  it("can't move workspace A's YouTube video", async () => {
    w.ytUploads = [
      {
        id: "v-sched",
        title: "Lisbon Short",
        privacy: "private",
        publishedAt: "2026-10-01T10:00:00Z",
        publishAt: new Date(Date.now() + 7 * 86400e3).toISOString(),
        duration: "PT45S",
      },
    ];
    const at = new Date(Date.now() + 10 * 86400e3).toISOString();
    expect((await call(KEY_B, "/v1/youtube/reschedule", { video: "v-sched", at })).status).toBe(404);
    expect(w.ytUpdates).toEqual([]);
  });

  it("sees only its own drafts", async () => {
    const d = await call(KEY_A, "/v1/drafts", { kind: "reel", account: "demo_travel", caption: "A draft" });
    expect(d.status).toBe(200);
    expect(((await call(KEY_B, "/v1/drafts")).json as { drafts: unknown[] }).drafts).toEqual([]);
    expect((await call(KEY_B, `/v1/drafts/${d.json.id}/withdraw`, {})).status).toBe(404);
    expect(((await call(KEY_A, "/v1/drafts")).json as { drafts: unknown[] }).drafts).toHaveLength(1);
  });

  it("withdraws any open draft of its workspace, whoever made it, and none of another's", async () => {
    // the owner's (made in the app), another key's, the Drive inbox's, and one in workspace B
    await env.DB.batch(
      [
        ["d_owner", "pwa", "owner", "default"],
        ["d_other", "api", "key:k_other", "default"],
        ["d_mcp", "drive", "drive-inbox", "default"],
        ["d_b", "api", "key:kb", "b"],
      ].map(([id, source, by, ws]) =>
        env.DB.prepare(
          "INSERT INTO drafts (id, kind, account, payload, source, created_by, status, created_at, updated_at, workspace_id) VALUES (?1, 'reel', 'demo_travel', '{\"caption\":\"x\"}', ?2, ?3, 'draft', 0, 0, ?4)",
        ).bind(id, source, by, ws),
      ),
    );
    expect((await call(KEY_A, "/v1/drafts/d_owner/withdraw", {})).json).toEqual({ id: "d_owner", status: "withdrawn" });
    expect((await call(KEY_A, "/v1/drafts/d_other/withdraw", {})).status).toBe(200);
    // MCP runs the same tool
    const viaMcp = await exports.default.fetch("https://scheduler.test/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY_A}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "withdraw_draft", arguments: { id: "d_mcp" } },
      }),
    });
    expect(((await viaMcp.json()) as { result: { isError: boolean } }).result.isError).toBe(false);
    // workspace B's draft isn't there for A, and stays open
    expect((await call(KEY_A, "/v1/drafts/d_b/withdraw", {})).status).toBe(404);
    const status = async (id: string) =>
      env.DB.prepare("SELECT status FROM drafts WHERE id = ?1").bind(id).first<string>("status");
    expect(await status("d_owner")).toBe("withdrawn");
    expect(await status("d_mcp")).toBe("withdrawn");
    expect(await status("d_b")).toBe("draft");
  });
});

describe("the scheduler", () => {
  it("serves every workspace, each job tagged with its own", async () => {
    const e = await testEnv(env);
    const a = await seedReel(w, { date: "2026-10-20" }); // 18:00 Seoul = 09:00 UTC
    const added = await call(KEY_B, "/v1/plan", {
      kind: "reel",
      account: "b_shop",
      folder: "shop/CONTENT/20261020_SALE",
      name: "short1_sale",
      date: "2026-10-20",
      time: "08:00", // 08:00 Madrid = 06:00 UTC
      caption: "Sale",
    });
    await tick(e, { fetch: w.fetch, now: new Date("2026-10-20T09:05:00Z") });
    const jobs = await env.DB.prepare("SELECT item_key, workspace_id, due_at FROM jobs ORDER BY due_at").all();
    // B's item isn't approved, so it's refused; it's still B's job, at 08:00 Madrid time.
    expect(jobs.results).toEqual([
      { item_key: added.json.key, workspace_id: "b", due_at: Date.UTC(2026, 9, 20, 6, 0) / 1000 },
      { item_key: a.key, workspace_id: "default", due_at: Date.UTC(2026, 9, 20, 9, 0) / 1000 },
    ]);
  });
});

describe("the owner's apps follow the signed-in user's workspace (Phase 4b)", () => {
  // A second person, member of workspace B only, signed in to the dashboard and the app.
  it("the stats tools and the ingest see only the key's workspace", async () => {
    const token = "bongsu_bstatsbstatsbstatsbstatsbst";
    await env.DB.prepare(
      "INSERT INTO api_keys (id, name, key_hash, scopes, workspace_id) VALUES ('tb', 'tb', ?1, '[\"read\",\"metrics\"]', 'b')",
    )
      .bind(await sha256Hex(token))
      .run();
    const { key } = await seedReel(w); // the default workspace's
    expect((await call(token, `/v1/items/${key}/metrics`)).status).toBe(404);
    expect((await call(token, "/v1/accounts/demo_travel/metrics")).status).toBe(404);
    expect((await call(token, "/v1/accounts/b_shop/metrics")).status).toBe(200);
    // the default workspace has a post with samples this month: workspace B's key must not see it
    await env.DB.prepare(
      "INSERT INTO post_metrics (item_key, account, platform, media_id, taken_at, views) VALUES (?1, 'demo_travel', 'instagram', 'm', ?2, 10)",
    )
      .bind(key, Math.floor(Date.now() / 1000) - 86400)
      .run();
    expect(((await call(token, "/v1/performance")).json.rows as unknown[]).length).toBe(0);
    const up = await call(token, "/v1/metrics", {
      accounts: [{ account: "demo_travel", at: "2026-10-21T03:00:00Z", followers: 5 }],
    });
    expect(up.status).toBe(400);
  });

  const as = async (userId: string, app: "dashboard" | "pwa", path: string) => {
    const token = await createSession(env.DB, Math.floor(Date.now() / 1000), { app, userId });
    const r = await exports.default.fetch(`https://scheduler.test${path}`, {
      headers: { Cookie: `${app === "dashboard" ? "bongsu_admin" : "bongsu_session"}=${token}` },
    });
    return { status: r.status, json: (await r.json()) as Record<string, unknown> };
  };
  beforeEach(async () => {
    await env.DB.batch(
      [
        "INSERT INTO users (id, email, name, created_at) VALUES ('bea', 'bea@example.com', 'Bea', 0) ON CONFLICT (id) DO NOTHING",
        "INSERT INTO users (id, email, name, created_at) VALUES ('nobody', 'nobody@example.com', 'Nobody', 0) ON CONFLICT (id) DO NOTHING",
        "INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES ('b', 'bea', 'admin', 0) ON CONFLICT DO NOTHING",
      ].map((s) => env.DB.prepare(s)),
    );
  });

  it("the dashboard shows and changes only the user's workspace", async () => {
    const accounts = (await as("bea", "dashboard", "/admin-api/accounts")).json.accounts as { id: string }[];
    expect(accounts.map((a) => a.id)).toEqual(["b_shop"]);
    expect((await as("bea", "dashboard", "/admin-api/settings")).json.timezone).toBe("Europe/Madrid");
    const keys = (await as("bea", "dashboard", "/admin-api/keys")).json.keys as { id: string }[];
    expect(keys.map((k) => k.id)).toEqual(["kb"]);
    const conns = (await as("bea", "dashboard", "/admin-api/connections")).json.connections as { id: string }[];
    expect(conns.map((c) => c.id)).toEqual(["c_b"]);
    // its members and invites only (invites.test.ts tries the changes across workspaces)
    const people = (await as("bea", "dashboard", "/admin-api/members")).json;
    expect((people.members as { userId: string }[]).map((m) => m.userId)).toEqual(["bea"]);
    expect(people.invites).toEqual([]);
    // the owner, in the default workspace, doesn't see B's
    const own = (await as("owner", "dashboard", "/admin-api/accounts")).json.accounts as { id: string }[];
    expect(own.map((a) => a.id)).not.toContain("b_shop");
  });

  it("the app reads the user's workspace: its zone, and no items of another", async () => {
    const { key } = await seedReel(w, { date: "2026-10-30" }); // the default workspace's
    expect((await as("bea", "pwa", "/app-api/me")).json.workspaceTimezone).toBe("Europe/Madrid");
    expect((await as("bea", "pwa", `/app-api/item?key=${encodeURIComponent(key)}`)).status).toBe(404);
    // Settings' connections: workspace B's only
    const conns = (await as("bea", "pwa", "/app-api/connections")).json.connections as { id: string }[];
    expect(conns.map((c) => c.id)).toEqual(["c_b"]);
    // the same lookup in the item's own workspace finds it
    expect(await resolveItem(await testEnv(env), w.fetch, key, "UTC", "default")).not.toBeNull();
  });

  it("an owner's CLI token of workspace B can't see another workspace's item to approve it", async () => {
    const { key } = await seedReel(w, { approve: false }); // the default workspace's
    const token = "bongsu_beaclibeaclibeaclibeaclibe";
    await env.DB.prepare(
      "INSERT INTO api_keys (id, name, key_hash, scopes, workspace_id, user_id) VALUES ('tb', 'tb', ?1, '[]', 'b', 'bea')",
    )
      .bind(await sha256Hex(token))
      .run();
    expect(await call(token, `/v1/approve/${encodeURIComponent(key)}`)).toEqual({
      status: 404,
      json: { error: `${key} isn't planned` },
    });
    expect((await call(token, "/v1/approve", { key, snapshot: { key } })).status).toBe(404);
  });

  it("an owner's CLI token of workspace B exports none of another workspace's items", async () => {
    await seedReel(w, { approve: false }); // the default workspace's
    const token = "bongsu_beaexportbeaexportbeaexportb";
    await env.DB.prepare(
      "INSERT INTO api_keys (id, name, key_hash, scopes, workspace_id, user_id) VALUES ('te', 'te', ?1, '[]', 'b', 'bea')",
    )
      .bind(await sha256Hex(token))
      .run();
    const r = await call(token, "/v1/export?texts=1");
    expect(r.status).toBe(200);
    expect(r.json.items).toEqual([]);
  });

  it("the channel route answers only for the user's workspace's accounts", async () => {
    expect((await as("owner", "pwa", "/app-api/stats/channel?account=demo_travel")).status).toBe(200);
    expect((await as("bea", "pwa", "/app-api/stats/channel?account=demo_travel")).status).toBe(404);
    expect((await as("bea", "pwa", "/app-api/stats/channel?account=b_shop")).status).toBe(200);
  });

  it("the Stats tab lists only the user's workspace's accounts", async () => {
    const ids = async (who: string) =>
      ((await as(who, "pwa", "/app-api/stats")).json.accounts as { id: string }[]).map((a) => a.id);
    expect(await ids("owner")).toContain("demo_travel");
    expect(await ids("owner")).not.toContain("b_shop");
    expect(await ids("bea")).toEqual(["b_shop"]);
  });

  it("the metrics routes answer only for the user's workspace: its items and its channels' videos", async () => {
    await env.DB.prepare("DELETE FROM post_metrics").run();
    const { key } = await seedReel(w, { date: "2026-10-30" }); // the default workspace's
    await env.DB.prepare(
      "INSERT INTO posted (item_key, account, media_id, source, published_at) VALUES (?1, 'demo_travel', 'm-1', 'scheduler', 1)",
    )
      .bind(key)
      .run();
    const path = `/app-api/item/metrics?key=${encodeURIComponent(key)}`;
    expect((await as("owner", "pwa", path)).status).toBe(200);
    expect((await as("bea", "pwa", path)).status).toBe(404);
    // workspace B's channel, its uploads already cached; the default workspace's channels list none
    await upsertConnection(
      env.DB,
      { id: "c_b_tube", workspaceId: "b", provider: "youtube", kind: "oauth", secretName: "YT_B_OAUTH" },
      0,
    );
    await upsertAccount(
      env.DB,
      { id: "b_tube", workspaceId: "b", platform: "youtube", handle: "b_tube", connectionId: "c_b_tube" },
      0,
    );
    const upload = { id: "vidB00000002", title: "B", privacy: "public", when: "2026-10-01T10:00:00Z", short: true };
    await env.DB.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('yt_uploads:b_tube', ?1, ?2)")
      .bind(JSON.stringify([upload]), Math.floor(Date.now() / 1000))
      .run();
    await env.DB.prepare(
      "INSERT INTO post_metrics (item_key, account, platform, media_id, taken_at, views, workspace_id) VALUES ('video:vidB00000002', 'b_tube', 'youtube', 'vidB00000002', 1, 5, 'b')",
    ).run();
    const video = "/app-api/video/metrics?video=vidB00000002";
    expect((await as("owner", "pwa", video)).status).toBe(404);
    const own = await as("bea", "pwa", video);
    expect(own.status).toBe(200);
    expect(own.json.samples).toMatchObject([{ views: 5 }]);
  });

  it("a channel both workspaces connect: each reads only its own workspace's samples of a video", async () => {
    await env.DB.prepare("DELETE FROM post_metrics").run();
    await upsertConnection(
      env.DB,
      { id: "c_b_tube", workspaceId: "b", provider: "youtube", kind: "oauth", secretName: "YT_B_OAUTH" },
      0,
    );
    await upsertAccount(
      env.DB,
      { id: "b_tube", workspaceId: "b", platform: "youtube", handle: "b_tube", connectionId: "c_b_tube" },
      0,
    );
    const upload = { id: "vidS00000003", title: "S", privacy: "public", when: "2026-10-01T10:00:00Z", short: true };
    for (const account of ["main", "b_tube"])
      await env.DB.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)")
        .bind(`yt_uploads:${account}`, JSON.stringify([upload]), Math.floor(Date.now() / 1000))
        .run();
    // the sampler took the series for workspace B's account
    await env.DB.prepare(
      "INSERT INTO post_metrics (item_key, account, platform, media_id, taken_at, views, workspace_id) VALUES ('video:vidS00000003', 'b_tube', 'youtube', 'vidS00000003', 1, 7, 'b')",
    ).run();
    const video = "/app-api/video/metrics?video=vidS00000003";
    const owner = await as("owner", "pwa", video);
    expect(owner.status).toBe(200);
    expect(owner.json.samples).toEqual([]);
    expect((await as("bea", "pwa", video)).json.samples).toMatchObject([{ views: 7 }]);
  });

  it("a user in no workspace is turned away", async () => {
    expect((await as("nobody", "dashboard", "/admin-api/accounts")).status).toBe(403);
    expect((await as("nobody", "pwa", "/app-api/status")).status).toBe(403);
  });
});
