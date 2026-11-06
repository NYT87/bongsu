// Workspace isolation (Phase 3): an agent key only sees and changes its own workspace's plan, drafts, jobs and
// accounts; the scheduler serves every workspace, each in its own time zone.
import { env, exports } from "cloudflare:workers";
import { adminRoutes } from "@bongsu/api/dashboard/routes";
import { resolveItem } from "@bongsu/api/pwa/approve";
import { appRoutes } from "@bongsu/api/pwa/routes";
import { createSession, markVerified, setSessionWorkspace } from "@bongsu/api/pwa/session";
import { upsertAccount, upsertConnection } from "@bongsu/core/accounts";
import { encryptSecret } from "@bongsu/core/crypto";
import type { Env } from "@bongsu/core/env";
import { sha256Hex } from "@bongsu/core/formats/approved";
import { iconByHash, removeIcon, setIcon } from "@bongsu/core/icon";
import { notifier } from "@bongsu/core/notify";
import { addMember } from "@bongsu/core/people";
import { tick } from "@bongsu/core/tick";
import { setDisplayName, setWorkspaceSettings } from "@bongsu/core/workspaces";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { png } from "./icon-png";
import { decrypt, keys } from "./push-helpers";
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

  it("another workspace can't read or write an item's texts", async () => {
    // a YouTube channel item with texts, in workspace A
    const key = "reel:20261101_DEMO/clip1";
    expect(
      (
        await call(KEY_A, "/v1/plan", {
          account: "main",
          format: "video",
          folder: "vlogs/CONTENT/20261101_DEMO",
          name: "clip1",
          date: "2026-11-01",
          texts: { title: "Private title" },
        })
      ).status,
    ).toBe(200);
    await call(KEY_A, "/v1/drafts", { kind: "reel", account: "main", texts: { title: "Draft title" } });
    expect((await call(KEY_A, `/v1/items/${encodeURIComponent(key)}`)).json).toMatchObject({
      texts: { title: "Private title" },
    });
    expect((await call(KEY_B, `/v1/items/${encodeURIComponent(key)}`)).status).toBe(404);
    expect((await call(KEY_B, "/v1/plan/update", { key, texts: { title: "Taken over" } })).status).toBe(404);
    expect(
      JSON.parse(
        (await env.DB.prepare("SELECT texts FROM plan_items WHERE item_key = ?1").bind(key).first<{ texts: string }>())
          ?.texts ?? "null",
      ),
    ).toEqual({ title: "Private title" });
    expect(JSON.stringify((await call(KEY_B, "/v1/drafts")).json)).not.toContain("Draft title");
    // nor can it draft for A's channel
    expect((await call(KEY_B, "/v1/drafts", { kind: "reel", account: "main", texts: { title: "x" } })).status).toBe(
      400,
    );
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

  it("another workspace can't set a video's settings, edit its texts or schedule its draft in the app", async () => {
    const key = "reel:20261101_DEMO/clip2";
    await env.DB.batch(
      [
        `INSERT INTO plan_items (item_key, format, account, folder, name, due_at, options, hold, sort, created_at, updated_at, workspace_id, content, caption, texts) VALUES ('${key}', 'video', 'main', '20261101_DEMO', 'clip2', 1893456000, '{}', 0, 1, 0, 0, 'default', 'db', 'Description', '{"title":"Private title"}')`,
        "INSERT INTO drafts (id, kind, account, payload, source, created_by, status, created_at, updated_at, workspace_id) VALUES ('d_yt_a', 'reel', 'main', '{\"media\":[]}', 'api', 'key:k', 'draft', 0, 0, 'default')",
        "INSERT INTO users (id, email, name, created_at) VALUES ('ytb', 'ytb@example.com', 'ytb', 0) ON CONFLICT (id) DO NOTHING",
        "INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES ('b', 'ytb', 'admin', 0) ON CONFLICT DO NOTHING",
      ].map((q) => env.DB.prepare(q)),
    );
    const e = await testEnv(env, { PUBLIC_URL: "https://bongsu.test" } as Partial<Env>);
    const token = await createSession(env.DB, Math.floor(Date.now() / 1000), { userId: "ytb" });
    await setSessionWorkspace(env.DB, token, "b");
    const app = async (path: string, body: unknown) =>
      (
        await appRoutes(w.fetch).request(
          `https://bongsu.test${path}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", Cookie: `bongsu_session=${token}` },
            body: JSON.stringify(body),
          },
          e,
        )
      ).status;
    expect(await app("/app-api/item/youtube", { key, privacy: "unlisted" })).toBe(404);
    expect(await app("/app-api/item/texts", { key, caption: "Taken", texts: { title: "Taken over" } })).toBe(404);
    expect(await app("/app-api/drafts/d_yt_a/schedule", { date: "2026-11-02", time: "18:00" })).toBe(404);
    // the drafts page offers B's accounts only: A's channel isn't among them
    const drafts = (await (
      await appRoutes(w.fetch).request(
        "https://bongsu.test/app-api/drafts",
        { headers: { Cookie: `bongsu_session=${token}` } },
        e,
      )
    ).json()) as { accounts: string[]; accountInfo: Record<string, unknown> };
    expect(Object.keys(drafts.accountInfo)).toEqual(drafts.accounts);
    expect(drafts.accountInfo).not.toHaveProperty("main");
    const r = await env.DB.prepare("SELECT options, caption, texts FROM plan_items WHERE item_key = ?1")
      .bind(key)
      .first();
    expect(r).toEqual({ options: "{}", caption: "Description", texts: '{"title":"Private title"}' });
    expect(await env.DB.prepare("SELECT status FROM drafts WHERE id = 'd_yt_a'").first("status")).toBe("draft");
    // the member list tests below count B's members
    await env.DB.batch(
      [
        "DELETE FROM sessions WHERE user_id = 'ytb'",
        "DELETE FROM memberships WHERE user_id = 'ytb'",
        "DELETE FROM users WHERE id = 'ytb'",
      ].map((q) => env.DB.prepare(q)),
    );
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

  it("a Bongsu upload's video id points to its item only in its own workspace", async () => {
    await env.DB.prepare("DELETE FROM post_metrics").run();
    const { key } = await seedReel(w, { date: "2026-10-30" }); // the default workspace's item
    await env.DB.prepare(
      "INSERT INTO jobs (item_key, kind, account, due_at, state, media_id, dry_run, payload, created_at, updated_at, workspace_id) VALUES (?1, 'video', 'conn-main', 1, 'done', 'vidU00000004', 0, '{\"username\":\"main\"}', 0, 0, 'default')",
    )
      .bind(key)
      .run();
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
    // workspace B's channel lists a video with the same id (a channel both connect), and has its series
    const upload = { id: "vidU00000004", title: "U", privacy: "public", when: "2026-10-01T10:00:00Z", short: true };
    await env.DB.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('yt_uploads:b_tube', ?1, ?2)")
      .bind(JSON.stringify([upload]), Math.floor(Date.now() / 1000))
      .run();
    await env.DB.prepare(
      "INSERT INTO post_metrics (item_key, account, platform, media_id, taken_at, views, workspace_id) VALUES ('video:vidU00000004', 'b_tube', 'youtube', 'vidU00000004', 1, 4, 'b')",
    ).run();
    const video = "/app-api/video/metrics?video=vidU00000004";
    expect((await as("owner", "pwa", video)).json).toEqual({ item_key: key });
    const own = await as("bea", "pwa", video);
    expect(own.json.item).toMatchObject({ key: "video:vidU00000004", account: "b_tube" });
    expect(own.json.samples).toMatchObject([{ views: 4 }]);
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
    // another workspace's channel defaults (or any settings of its accounts) can't be set
    expect(
      (await send("bea", "dashboard", "/admin-api/accounts/demo_travel", { youtube: { category: "10" } })).status,
    ).toBe(404);
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
    expect(state.workspaces).toEqual([{ id: "b", name: "Workspace B", iconUrl: null, role: "admin" }]);
    const me = (await as("bea", "pwa", "/app-api/me")).json;
    expect(me).toMatchObject({
      workspace: { id: "b" },
      workspaces: [{ id: "b", name: "Workspace B", iconUrl: null, shownAs: expect.anything(), role: "admin" }],
    });
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
    // an instance-level action of the instance admin: its audit row is in no workspace
    const dflt = await send("ina3", "dashboard", `/admin-api/media-stores/${stores[0].kind}/default`, {});
    expect(dflt.status).toBe(200);
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
      { action: "media_store_default", workspace_id: null },
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
      "media_store_default",
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

describe("a workspace's media settings", () => {
  it("an admin of B reads and changes B's folder, stores and OAuth apps, never A's", async () => {
    const nowS = Math.floor(Date.now() / 1000);
    const e = await testEnv(env, { PUBLIC_URL: "https://bongsu.test", RP_ID: "bongsu.test" });
    await env.DB.batch(
      [
        "INSERT INTO users (id, name, created_at, instance_admin) VALUES ('bob', 'Bob', 0, 0) ON CONFLICT (id) DO UPDATE SET instance_admin = 0",
        "DELETE FROM memberships WHERE user_id = 'bob'",
        "INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES ('b', 'bob', 'admin', 0)",
        "DELETE FROM media_store WHERE workspace_id IS NOT NULL",
        "DELETE FROM workspace_oauth_apps",
        "UPDATE workspace_settings SET media_folder = 'UPLOADS' WHERE workspace_id = 'default'",
        "UPDATE workspace_settings SET media_folder = 'shop-files' WHERE workspace_id = 'b'",
      ].map((q) => env.DB.prepare(q)),
    );
    // workspace A has its own bucket and OAuth app
    await env.DB.prepare(
      "INSERT INTO media_store (id, kind, workspace_id, is_default, settings, status, updated_at) VALUES ('s3-default', 's3', 'default', 1, '{\"bucket\":\"a-only\"}', 'ok', 0)",
    ).run();
    await env.DB.prepare(
      "INSERT INTO workspace_oauth_apps (workspace_id, id, client_id, client_secret, updated_at, updated_by) VALUES ('default', 'google', 'a-client', 'x', 0, 'owner')",
    ).run();
    const token = await createSession(env.DB, nowS, { app: "dashboard", userId: "bob" });
    await markVerified(env.DB, token, nowS);
    const call = async (path: string, body?: unknown, method?: string) => {
      const r = await adminRoutes(w.fetch).request(
        `https://bongsu.test${path}`,
        {
          method: method ?? (body === undefined ? "GET" : "POST"),
          headers: { Cookie: `bongsu_admin=${token}`, "Content-Type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
        e,
      );
      return { status: r.status, json: (await r.json()) as Record<string, any> };
    };
    const media = (await call("/admin-api/settings/media")).json;
    expect(media.folder).toBe("shop-files");
    expect((media.stores as { id: string }[]).map((s) => s.id)).not.toContain("s3-default");
    expect(JSON.stringify(media)).not.toContain("a-only");
    expect((await call("/admin-api/settings/media/folder", { folder: "UPLOADS" }, "PUT")).status).toBe(400); // A's
    // A's bucket and OAuth app aren't B's to default, remove or see
    expect((await call("/admin-api/settings/media/stores/s3/default", {})).status).toBe(400);
    expect((await call("/admin-api/settings/media/stores/s3/remove", {})).status).toBe(400);
    expect(
      ((await call("/admin-api/settings/oauth-apps")).json.apps as { clientId: string | null }[]).map(
        (a) => a.clientId,
      ),
    ).not.toContain("a-client");
    expect((await call("/admin-api/settings/oauth-apps/google/remove", {})).status).toBe(200);
    expect((await call("/admin-api/scheduler")).status).toBe(403);
    expect(
      await env.DB.prepare("SELECT 1 FROM media_store WHERE id = 's3-default' AND is_default = 1").first(),
    ).toBeTruthy();
    expect(
      await env.DB.prepare("SELECT 1 FROM workspace_oauth_apps WHERE workspace_id = 'default'").first(),
    ).toBeTruthy();
    expect(
      (await call("/admin-api/settings/oauth-apps/google", { clientId: "b-client", clientSecret: "s" })).status,
    ).toBe(200);
    expect(
      await env.DB.prepare("SELECT client_id FROM workspace_oauth_apps WHERE workspace_id = 'b'").first("client_id"),
    ).toBe("b-client");
    expect(
      await env.DB.prepare("SELECT client_id FROM workspace_oauth_apps WHERE workspace_id = 'default'").first(
        "client_id",
      ),
    ).toBe("a-client");
  });
});

describe("a workspace's icon and people's names stay in their workspace (Phase 13 part 3b)", () => {
  const nowS = () => Math.floor(Date.now() / 1000);
  const IDS = ["isoa", "isob", "isoe"];
  const SECRET_NAME = "Ana Only-In-A";
  let iconA: Uint8Array;
  let hashA: string;
  const req = async (method: string, path: string, headers: Record<string, string>, body?: BodyInit) => {
    const r = await exports.default.fetch(`https://scheduler.test${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
    });
    const text = await r.text();
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: r.status, text, json };
  };
  // isoa: admin of the default workspace (A), shown as SECRET_NAME there; isob: admin of B; isoe: editor of A only
  const cookie = async (userId: string, app: "dashboard" | "pwa") =>
    ({
      Cookie: `${app === "dashboard" ? "bongsu_admin" : "bongsu_session"}=${await createSession(env.DB, nowS(), { app, userId })}`,
    }) as Record<string, string>;
  const PNG = { "Content-Type": "image/png" };
  type Ref = { iconUrl?: string | null; displayName?: string | null; shownAs?: string | null };

  beforeEach(async () => {
    const ids = IDS.map((i) => `'${i}'`).join(", ");
    await env.DB.batch(
      [
        `DELETE FROM sessions WHERE user_id IN (${ids})`,
        "DELETE FROM workspace_icons",
        `DELETE FROM memberships WHERE user_id IN (${ids})`,
        `DELETE FROM users WHERE id IN (${ids})`,
        ...IDS.map(
          (i) => `INSERT INTO users (id, email, name, created_at) VALUES ('${i}', '${i}@example.com', '${i}', 0)`,
        ),
      ].map((q) => env.DB.prepare(q)),
    );
    await addMember(env.DB, "default", "isoa", "admin", 0);
    await addMember(env.DB, "default", "isoe", "editor", 0);
    await addMember(env.DB, "b", "isob", "admin", 0);
    await setDisplayName(env.DB, "default", "isoa", SECRET_NAME);
    iconA = png(256, 3);
    hashA = await setIcon(env.DB, "default", iconA, nowS());
  });
  afterEach(async () => {
    await env.DB.batch(
      [
        `DELETE FROM sessions WHERE user_id IN (${IDS.map((i) => `'${i}'`).join(", ")})`,
        "DELETE FROM workspace_icons",
        "DELETE FROM push_subs WHERE endpoint LIKE '%iso-%'",
      ].map((q) => env.DB.prepare(q)),
    );
  });

  it("A's icon URL and display name never reach B's me, state, settings, members or audit", async () => {
    // A's own views have them (so the absence below means something)
    const a = await req("GET", "/admin-api/state", await cookie("isoa", "dashboard"));
    expect(a.text).toContain(hashA);
    expect(((await req("GET", "/app-api/me", await cookie("isoa", "pwa"))).json.you as Ref).shownAs).toBe(SECRET_NAME);
    await req(
      "POST",
      "/admin-api/members/isoe/name",
      {
        ...(await cookie("isoa", "dashboard")),
        "Content-Type": "application/json",
      },
      JSON.stringify({ name: "Eve Only-In-A" }),
    );
    for (const [app, path] of [
      ["pwa", "/app-api/me"],
      ["dashboard", "/admin-api/state"],
      ["dashboard", "/admin-api/settings"],
      ["dashboard", "/admin-api/members"],
      ["dashboard", "/admin-api/audit"],
    ] as const) {
      const r = await req("GET", path, await cookie("isob", app));
      expect(r.status, path).toBe(200);
      expect(r.text, path).not.toContain(hashA);
      expect(r.text, path).not.toContain("Only-In-A");
    }
    // B's me and state name no icon for B itself
    const meB = (await req("GET", "/app-api/me", await cookie("isob", "pwa"))).json as {
      workspace: Ref;
      you: Ref;
    };
    expect(meB.workspace.iconUrl).toBeNull();
    expect(meB.you.displayName).toBeNull();
  });

  it("a B session sets and removes B's icon only: A's row and URL are unchanged", async () => {
    const h = await cookie("isob", "dashboard");
    const put = await req("PUT", "/admin-api/settings/icon", { ...h, ...PNG }, png(256, 9));
    expect(put.status).toBe(200);
    expect(String(put.json.iconUrl)).not.toContain(hashA);
    expect((await iconByHash(env.DB, hashA))?.length).toBe(iconA.length);
    const del = await req("DELETE", "/admin-api/settings/icon", h);
    expect(del.status).toBe(200);
    expect((await iconByHash(env.DB, hashA))?.length).toBe(iconA.length);
    const rows = await env.DB.prepare("SELECT workspace_id FROM workspace_icons").all();
    expect(rows.results).toEqual([{ workspace_id: "default" }]);
    // an editor of A can't remove A's
    expect((await req("DELETE", "/admin-api/settings/icon", await cookie("isoe", "dashboard"))).status).toBe(403);
    expect((await iconByHash(env.DB, hashA))?.length).toBe(iconA.length);
  });

  it("a B admin can't name a member who is only in A", async () => {
    const r = await req(
      "POST",
      "/admin-api/members/isoe/name",
      { ...(await cookie("isob", "dashboard")), "Content-Type": "application/json" },
      JSON.stringify({ name: "Hijacked" }),
    );
    expect(r.status).toBe(404);
    const row = await env.DB.prepare("SELECT display_name FROM memberships WHERE user_id = 'isoe'").first();
    expect(row).toEqual({ display_name: null });
  });

  it("agent keys get 401 or 403 on every route of the icon and the names", async () => {
    const json = { "Content-Type": "application/json" };
    for (const key of [KEY_A, KEY_B]) {
      const h = { Authorization: `Bearer ${key}` };
      for (const [method, path, headers, body] of [
        ["PUT", "/admin-api/settings/icon", { ...h, ...PNG }, png(256)],
        ["DELETE", "/admin-api/settings/icon", h, undefined],
        ["POST", "/app-api/me/name", { ...h, ...json }, JSON.stringify({ name: "X" })],
        ["POST", "/app-api/me/display-name", { ...h, ...json }, JSON.stringify({ name: "X" })],
        ["POST", "/admin-api/members/isoe/name", { ...h, ...json }, JSON.stringify({ name: "X" })],
        ["GET", "/admin-api/settings", h, undefined],
      ] as const) {
        const r = await req(method, path, headers, body);
        expect([401, 403], `${method} ${path}`).toContain(r.status);
      }
      // the app's me and the dashboard's state are public (the sign-in screens read them): to a key, the signed-out ones
      const me = (await req("GET", "/app-api/me", h)).json;
      expect([me.signedIn, me.workspace ?? null, me.workspaces ?? [], me.you ?? null]).toEqual([false, null, [], null]);
      const state = (await req("GET", "/admin-api/state", h)).json;
      expect([state.signedIn, state.workspace, state.workspaces]).toEqual([false, null, []]);
    }
    expect((await iconByHash(env.DB, hashA))?.length).toBe(iconA.length);
    expect(await env.DB.prepare("SELECT display_name FROM memberships WHERE user_id = 'isoe'").first()).toEqual({
      display_name: null,
    });
  });

  // Pushes carry no person's name (notify.ts only prefixes the workspace's name), so only the icon is checked.
  it("a push carries its own workspace's icon: A's for A, none for B, then B's own", async () => {
    const k = await keys();
    const e = await testEnv(env, {
      VAPID_PUBLIC_KEY: k.VAPID_PUBLIC_KEY,
      VAPID_PRIVATE_KEY: k.VAPID_PRIVATE_KEY,
      VAPID_SUBJECT: "mailto:owner@example.com",
      NOTIFY_URL: undefined,
    });
    const bodies = new Map<string, Uint8Array>();
    const service: typeof fetch = async (input, init) => {
      bodies.set(String(input), new Uint8Array(init?.body as Uint8Array));
      return new Response(null, { status: 201 });
    };
    const endpoint = (who: string) => `https://fcm.googleapis.com/fcm/send/iso-${who}`;
    for (const who of ["isoa", "isob"])
      await env.DB.prepare(
        "INSERT INTO push_subs (endpoint, p256dh, auth, created_at, user_id) VALUES (?1, ?2, ?3, 0, ?4)",
      )
        .bind(endpoint(who), k.p256dh, k.auth, who)
        .run();
    const note = { group: "published" as const, title: "demo_travel: published", text: "t" };
    const push = async (ws: string, who: string) => {
      bodies.clear();
      await notifier(e, service, 0).send(note, ws);
      return decrypt(bodies.get(endpoint(who))!, k);
    };
    const origin = e.PUBLIC_URL.replace(/\/$/, "");
    expect((await push("default", "isoa")).icon).toBe(`${origin}/icon/${hashA}.png`);
    expect("icon" in (await push("b", "isob"))).toBe(false);
    const hashB = await setIcon(env.DB, "b", png(256, 9), nowS());
    try {
      const fromB = await push("b", "isob");
      expect(fromB.icon).toBe(`${origin}/icon/${hashB}.png`);
      expect(fromB.icon).not.toContain(hashA);
    } finally {
      await removeIcon(env.DB, "b");
    }
  });

  it("the icon URL is public and serves A's bytes; an unknown hash is a 404", async () => {
    const r = await exports.default.fetch(`https://scheduler.test/icon/${hashA}.png`);
    expect(r.status).toBe(200);
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(iconA);
    expect((await exports.default.fetch(`https://scheduler.test/icon/${"0".repeat(64)}.png`)).status).toBe(404);
  });
});
