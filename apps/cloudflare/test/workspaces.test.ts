// Workspace isolation (Phase 3): an agent key only sees and changes its own workspace's plan, drafts, jobs and
// accounts; the scheduler serves every workspace, each in its own time zone.
import { env, exports } from "cloudflare:workers";
import { resolveItem } from "@bongsu/api/pwa/approve";
import { appRoutes } from "@bongsu/api/pwa/routes";
import { createSession, setSessionWorkspace } from "@bongsu/api/pwa/session";
import { upsertAccount, upsertConnection } from "@bongsu/core/accounts";
import { encryptSecret } from "@bongsu/core/crypto";
import type { Env } from "@bongsu/core/env";
import { sha256Hex } from "@bongsu/core/formats/approved";
import { tick } from "@bongsu/core/tick";
import { setWorkspaceSettings } from "@bongsu/core/workspaces";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearPlan, seedReel, TEST_ENCRYPTION_KEY, testEnv, World } from "./world";

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

  // Phase 13 part 1's routes (members, invites, workspaces, connecting from the app): workspace B's people reach
  // only workspace B. invites.test.ts and workspaces-admin.test.ts try each route's behaviour; here it's the boundary.
  const send = async (userId: string, app: "dashboard" | "pwa", path: string, body: unknown = {}) => {
    const token = await createSession(env.DB, Math.floor(Date.now() / 1000), { app, userId });
    const r = await exports.default.fetch(`https://scheduler.test${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${app === "dashboard" ? "bongsu_admin" : "bongsu_session"}=${token}`,
      },
      body: JSON.stringify(body),
    });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
  };
  const role = (ws: string, user: string) =>
    env.DB.prepare("SELECT role FROM memberships WHERE workspace_id = ?1 AND user_id = ?2")
      .bind(ws, user)
      .first<string>("role");

  it("a workspace's admin can't touch another's members or invites, nor the Workspaces page", async () => {
    await env.DB.batch(
      [
        "INSERT INTO users (id, email, name, created_at) VALUES ('dan', 'dan@example.com', 'Dan', 0) ON CONFLICT (id) DO NOTHING",
        "INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES ('default', 'dan', 'editor', 0) ON CONFLICT DO NOTHING",
        "INSERT INTO invites (workspace_id, token_hash, email, role, invited_by, created_at, expires_at) VALUES ('default', 'inviteA000000000hash', 'p@example.com', 'editor', 'dan', 0, 4102444800)",
      ].map((s) => env.DB.prepare(s)),
    );
    // bea is admin of B only: a member of the default workspace isn't hers to change, and its invite isn't there
    expect((await send("bea", "dashboard", "/admin-api/members/dan", { role: "admin" })).status).toBe(404);
    expect((await send("bea", "dashboard", "/admin-api/members/dan/remove")).status).toBe(404);
    expect((await send("bea", "dashboard", "/admin-api/invites/inviteA000000000/revoke")).status).toBe(404);
    expect(await role("default", "dan")).toBe("editor");
    expect(
      await env.DB.prepare("SELECT revoked_at FROM invites WHERE token_hash = 'inviteA000000000hash'").first(
        "revoked_at",
      ),
    ).toBeNull();
    // her invites land in B, whatever the body says
    const inv = await send("bea", "dashboard", "/admin-api/invites", {
      email: "new@example.com",
      role: "creator",
      workspaceId: "default",
    });
    expect(inv.status).toBe(200);
    expect(
      await env.DB.prepare("SELECT workspace_id FROM invites WHERE email = 'new@example.com'").first("workspace_id"),
    ).toBe("b");
    // the instance admin's page: create, rename, add an admin, archive, restore, open
    for (const [path, body] of [
      ["/admin-api/workspaces", { name: "Mine", timezone: "UTC", admin: "me" }],
      ["/admin-api/workspaces/default", { name: "Mine" }],
      ["/admin-api/workspaces/default/admins", { email: "x@example.com" }],
      ["/admin-api/workspaces/default/archive", {}],
      ["/admin-api/workspaces/default/restore", {}],
      ["/admin-api/workspaces/default/open", {}],
    ] as const)
      expect((await send("bea", "dashboard", path, body)).status, path).toBe(403);
    expect((await as("bea", "dashboard", "/admin-api/workspaces")).status).toBe(403);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM workspaces WHERE name = 'Mine'").first("n")).toBe(0);
    expect(
      await env.DB.prepare("SELECT archived_at FROM workspaces WHERE id = 'default'").first("archived_at"),
    ).toBeNull();
  });

  it("switching: a member of B can't move a session into another workspace, nor see it listed", async () => {
    // bea is admin of B only: the default workspace isn't one she can open, in either app
    for (const [app, path] of [
      ["dashboard", "/admin-api/session/workspace"],
      ["pwa", "/app-api/session/workspace"],
    ] as const)
      expect(await send("bea", app, path, { id: "default" }), path).toEqual({
        status: 403,
        json: { error: "you can't open that workspace" },
      });
    const state = (await as("bea", "dashboard", "/admin-api/state")).json;
    expect(state.workspaces).toEqual([{ id: "b", name: "Workspace B", role: "admin" }]);
    const me = (await as("bea", "pwa", "/app-api/me")).json;
    expect(me).toMatchObject({ workspace: { id: "b" }, workspaces: [{ id: "b", name: "Workspace B", role: "admin" }] });
    // no session of hers works in the default workspace
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM sessions WHERE user_id = 'bea' AND workspace_id = 'default'",
      ).first("n"),
    ).toBe(0);
  });

  it("a workspace an instance admin creates starts empty and leaves the others alone", async () => {
    await env.DB.prepare(
      "INSERT INTO users (id, email, name, created_at, instance_admin) VALUES ('ina2', 'ina2@example.com', 'Ina', 0, 1) ON CONFLICT (id) DO NOTHING",
    ).run();
    const r = await send("ina2", "dashboard", "/admin-api/workspaces", { name: "Fresh", timezone: "UTC", admin: "me" });
    expect(r.status).toBe(200);
    const id = String(r.json.id);
    expect(id).not.toBe("b");
    for (const table of ["accounts", "connections", "api_keys", "plan_items", "drafts"])
      expect(
        await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE workspace_id = ?1`).bind(id).first("n"),
        table,
      ).toBe(0);
    // B still sees only its own
    const accounts = (await as("bea", "dashboard", "/admin-api/accounts")).json.accounts as { id: string }[];
    expect(accounts.map((a) => a.id)).toContain("b_shop");
    expect(accounts.map((a) => a.id)).not.toContain("demo_travel");
    expect(((await as("bea", "dashboard", "/admin-api/members")).json.members as unknown[]).length).toBe(1);
  });

  it("connecting from the app: editors are refused, a creator reads and reconnects only its own workspace's", async () => {
    await env.DB.batch(
      [
        "INSERT INTO users (id, email, name, created_at) VALUES ('cleo', 'cleo@example.com', 'Cleo', 0) ON CONFLICT (id) DO NOTHING",
        "INSERT INTO users (id, email, name, created_at) VALUES ('ed', 'ed@example.com', 'Ed', 0) ON CONFLICT (id) DO NOTHING",
        "INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES ('b', 'cleo', 'creator', 0) ON CONFLICT DO NOTHING",
        "INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES ('b', 'ed', 'editor', 0) ON CONFLICT DO NOTHING",
      ].map((s) => env.DB.prepare(s)),
    );
    expect((await as("ed", "pwa", "/app-api/connections")).status).toBe(403);
    expect((await send("ed", "pwa", "/app-api/connect/youtube/start")).status).toBe(403);
    const conns = (await as("cleo", "pwa", "/app-api/connections")).json.connections as { id: string }[];
    expect(conns.map((c) => c.id)).toContain("c_b");
    expect(conns.map((c) => c.id)).not.toContain("c_main");
    // the default workspace's YouTube connection isn't B's to reconnect, with the Google app set up (so the refusal
    // is the ownership check's, not a missing app)
    await env.DB.prepare(
      "INSERT INTO oauth_apps (id, client_id, client_secret, updated_at) VALUES ('google', 'google-app-id', ?1, 0) ON CONFLICT (id) DO UPDATE SET client_secret = excluded.client_secret",
    )
      .bind(await encryptSecret(TEST_ENCRYPTION_KEY, "google-secret"))
      .run();
    await upsertConnection(
      env.DB,
      { id: "c_def_tube", workspaceId: "default", provider: "youtube", kind: "oauth", secretName: "YT_DEF_OAUTH" },
      0,
    );
    const before = await env.DB.prepare("SELECT COUNT(*) AS n FROM oauth_states").first("n");
    // through the app's routes with a full test env (the Worker binding here has no ENCRYPTION_KEY)
    const e = await testEnv(env, { PUBLIC_URL: "https://bongsu.test" } as Partial<Env>);
    const token = await createSession(env.DB, Math.floor(Date.now() / 1000), { app: "pwa", userId: "cleo" });
    const start = async (body?: unknown) => {
      const res = await appRoutes(w.fetch).request(
        "https://bongsu.test/app-api/connect/youtube/start",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: `bongsu_session=${token}` },
          body: JSON.stringify(body ?? {}),
        },
        e,
      );
      return { status: res.status, json: (await res.json()) as Record<string, unknown> };
    };
    const r = await start({ reconnect: "c_def_tube" });
    expect([r.status, r.json.error]).toEqual([400, "no such connection to reconnect"]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM oauth_states").first("n")).toBe(before);
    // its own flow starts fine with the app there
    expect((await start()).status).toBe(200);
  });

  it("the audit log: a workspace's people read only its rows, the instance's rows only an instance admin", async () => {
    await env.DB.batch(
      [
        "INSERT INTO users (id, email, name, created_at, instance_admin) VALUES ('ina3', 'ina3@example.com', 'Ina', 0, 1) ON CONFLICT (id) DO NOTHING",
        "INSERT INTO users (id, email, name, created_at) VALUES ('ed', 'ed@example.com', 'Ed', 0) ON CONFLICT (id) DO NOTHING",
        "INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES ('b', 'ed', 'editor', 0) ON CONFLICT DO NOTHING",
        "INSERT INTO users (id, email, name, created_at) VALUES ('cleo', 'cleo@example.com', 'Cleo', 0) ON CONFLICT (id) DO NOTHING",
        "INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES ('b', 'cleo', 'creator', 0) ON CONFLICT DO NOTHING",
        "DELETE FROM audit",
      ].map((q) => env.DB.prepare(q)),
    );
    // the instance admin makes workspace A for someone else, and changes a media store: instance rows, and A's own
    const made = await send("ina3", "dashboard", "/admin-api/workspaces", {
      name: "Client A",
      timezone: "UTC",
      admin: "ann@example.com",
    });
    expect(made.status).toBe(200);
    const a = String(made.json.id);
    const stores = (await as("ina3", "dashboard", "/admin-api/media-stores")).json.stores as { kind: string }[];
    expect(stores.length).toBeGreaterThan(0);
    const inbox = await send("ina3", "dashboard", `/admin-api/media-stores/${stores[0].kind}/inbox`, { workspace: a });
    expect(inbox.status).toBe(200);
    const where = async () =>
      (
        await env.DB.prepare("SELECT action, workspace_id FROM audit ORDER BY id").all<{
          action: string;
          workspace_id: string | null;
        }>()
      ).results;
    expect(await where()).toEqual([
      { action: "workspace_create", workspace_id: null },
      { action: "invite_create", workspace_id: a },
      { action: "media_store_inbox", workspace_id: null },
    ]);
    // B's admin and editor: none of A's rows, none of the instance's, and no way to ask for them; a device's error
    // in B's app is B's
    expect((await send("ed", "pwa", "/app-api/client-error", { msg: "upload failed" })).status).toBe(200);
    // and a creator's pause names her, in the log as in the pause itself: not "owner"
    expect((await send("cleo", "pwa", "/app-api/pause", { reason: "checking" })).status).toBe(200);
    const paused = await env.DB.prepare("SELECT paused FROM workspace_settings WHERE workspace_id = 'b'").first<string>(
      "paused",
    );
    await env.DB.prepare("UPDATE workspace_settings SET paused = NULL WHERE workspace_id = 'b'").run();
    expect(JSON.parse(paused ?? "{}")).toMatchObject({ by: "Cleo" });
    for (const who of ["bea", "ed"]) {
      const log = await as(who, "dashboard", "/admin-api/audit");
      expect(log.status, who).toBe(200);
      expect(log.json.entries, who).toEqual([
        expect.objectContaining({ action: "pause", actor: "user:cleo", user_id: "cleo", who: "Cleo" }),
        expect.objectContaining({ action: "client_error", actor: "user:ed", user_id: "ed", who: "Ed" }),
      ]);
      expect((await as(who, "dashboard", "/admin-api/audit?instance=1")).status, who).toBe(403);
    }
    // the instance admin, in no workspace (A's admin is someone else): the instance's rows
    const inst = await as("ina3", "dashboard", "/admin-api/audit?instance=1");
    expect(inst.status).toBe(200);
    expect((inst.json.entries as { action: string }[]).map((x) => x.action)).toEqual([
      "media_store_inbox",
      "workspace_create",
    ]);
    expect((await as("ina3", "dashboard", "/admin-api/audit")).json).toMatchObject({ noWorkspace: true });
  });

  it("notification settings: a change in B leaves the default workspace's alone, and each GET reads its own", async () => {
    await env.DB.batch(
      [
        "DELETE FROM notify_prefs",
        "INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES ('default', 'bea', 'admin', 0) ON CONFLICT DO NOTHING",
      ].map((q) => env.DB.prepare(q)),
    );
    // bea is an admin of both workspaces: one session working in each
    const prefs = async (ws: string, method: "GET" | "PUT", body?: unknown) => {
      const token = await createSession(env.DB, Math.floor(Date.now() / 1000), { userId: "bea" });
      await setSessionWorkspace(env.DB, token, ws);
      const r = await exports.default.fetch("https://scheduler.test/app-api/notify-prefs", {
        method,
        headers: { "Content-Type": "application/json", Cookie: `bongsu_session=${token}` },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const json = (await r.json()) as { groups: { grp: string; enabled: boolean; isDefault: boolean }[] };
      return { status: r.status, digest: json.groups.find((g) => g.grp === "digest") };
    };
    const off = await prefs("b", "PUT", { grp: "digest", enabled: false });
    expect([off.status, off.digest]).toEqual([200, { grp: "digest", enabled: false, isDefault: false }]);
    expect((await prefs("b", "GET")).digest).toEqual({ grp: "digest", enabled: false, isDefault: false });
    expect((await prefs("default", "GET")).digest).toEqual({ grp: "digest", enabled: true, isDefault: true });
    const rows = await env.DB.prepare("SELECT workspace_id, user_id, grp FROM notify_prefs").all();
    expect(rows.results).toEqual([{ workspace_id: "b", user_id: "bea", grp: "digest" }]);
  });

  it("a user in no workspace is turned away", async () => {
    expect((await as("nobody", "dashboard", "/admin-api/accounts")).status).toBe(403);
    expect((await as("nobody", "pwa", "/app-api/status")).status).toBe(403);
  });
});
