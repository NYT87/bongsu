// Stats for agents (Phase 9): get_metrics, get_account_metrics and list_performance through MCP and REST, and the
// metrics ingest behind its opt-in scope.
import { env, exports } from "cloudflare:workers";
import { sha256Hex } from "@bongsu/core/formats/approved";
import { zoneToUnix } from "@bongsu/core/formats/time";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearPlan, seedAccounts, seedReel, World } from "./world";

const KEY = "bongsu_statsstatsstatsstatsstatsst";
const TZ = "Asia/Seoul"; // the default workspace's
const noon = (date: string) => zoneToUnix(date, "12:00", TZ) as number;
let w: World;
const origFetch = globalThis.fetch;

async function addKey(id: string, key: string, scopes: string[]) {
  await env.DB.prepare("INSERT INTO api_keys (id, name, key_hash, scopes) VALUES (?1, ?2, ?3, ?4)")
    .bind(id, `test ${id}`, await sha256Hex(key), JSON.stringify(scopes))
    .run();
}
const req = (path: string, key: string, init: RequestInit = {}) =>
  exports.default.fetch(`https://scheduler.test${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
const rest = async <T = Record<string, unknown>>(path: string, key = KEY, init: RequestInit = {}) => {
  const r = await req(path, key, init);
  return { status: r.status, json: (await r.json()) as T };
};
const tool = async <T = Record<string, unknown>>(name: string, args: Record<string, unknown>, key = KEY) => {
  const r = (await (
    await req("/mcp", key, {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    })
  ).json()) as { result: { isError: boolean; structuredContent: T; content: { text: string }[] } };
  return r.result;
};
const sample = (
  key: string,
  at: number,
  v: Record<string, number | null>,
  account = "demo_travel",
  platform = "instagram",
) =>
  env.DB.prepare(
    "INSERT INTO post_metrics (item_key, account, platform, media_id, taken_at, views, reach, likes, follows) VALUES (?1, ?2, ?3, 'm', ?4, ?5, ?6, ?7, ?8)",
  )
    .bind(key, account, platform, at, v.views ?? null, v.reach ?? null, v.likes ?? null, v.follows ?? null)
    .run();
const posted = (key: string, published: number, account = "demo_travel") =>
  env.DB.prepare(
    "INSERT INTO posted (item_key, account, media_id, source, published_at) VALUES (?1, ?2, 'm', 'scheduler', ?3)",
  )
    .bind(key, account, published)
    .run();

beforeEach(async () => {
  await seedAccounts();
  await env.DB.batch(
    [
      "DELETE FROM api_keys",
      "DELETE FROM rate_limits",
      "DELETE FROM post_metrics",
      "DELETE FROM account_metrics",
      "DELETE FROM trial_posts",
      "DELETE FROM audit",
    ].map((s) => env.DB.prepare(s)),
  );
  await clearPlan();
  await addKey("k_stats", KEY, ["read"]);
  w = new World();
  globalThis.fetch = w.fetch;
});
afterEach(() => {
  globalThis.fetch = origFetch;
});

type Pt = Record<string, number | null>;

describe("get_metrics", () => {
  it("an item's series with its 24 h numbers, through REST (a key with slashes) and MCP", async () => {
    const { key } = await seedReel(w);
    const pub = noon("2026-10-20");
    await posted(key, pub);
    await sample(key, pub + 600, { views: 10, follows: 0 });
    await sample(key, pub + 86400, { views: 500, follows: 7 });
    await sample(key, pub + 3 * 86400, { views: 900, follows: 9 });
    const r = await rest<{ item: { key: string }; samples: Pt[]; results: Pt }>(`/v1/items/${key}/metrics`);
    expect(r.status).toBe(200);
    expect(r.json.item.key).toBe(key);
    expect(r.json.samples.map((p) => p.views)).toEqual([10, 500, 900]);
    expect(r.json.results).toMatchObject({ views: 500, follows: 7 });
    const m = await tool<{ samples: Pt[] }>("get_metrics", { key, daily: true, metrics: ["views", "follows"] });
    expect(m.isError).toBe(false);
    // daily: growth since the previous sampled day; Oct 22 had no sample
    expect(m.structuredContent.samples.map((p) => p.views)).toEqual([490, null, 400]);
    expect(Object.keys(m.structuredContent.samples[0]).sort()).toEqual(["at", "follows", "views"]);
  });

  it("404 for an item that isn't planned; 400 for an unknown metric", async () => {
    expect((await rest("/v1/items/reel:nope/x/metrics")).status).toBe(404);
    const { key } = await seedReel(w);
    expect((await tool("get_metrics", { key, metrics: ["views", "mood"] })).isError).toBe(true);
  });
});

describe("get_account_metrics", () => {
  it("followers (totals or each day's growth) and the views its posts added per day", async () => {
    for (const [d, n] of [
      ["2026-10-20", 100],
      ["2026-10-21", 104],
      ["2026-10-23", 110],
    ] as const)
      await env.DB.prepare(
        "INSERT INTO account_metrics (account, platform, taken_at, followers) VALUES ('demo_travel', 'instagram', ?1, ?2)",
      )
        .bind(noon(d), n)
        .run();
    await sample("reel:A/a", noon("2026-10-20"), { views: 100 });
    await sample("reel:A/a", noon("2026-10-21"), { views: 160 });
    const total = await rest<{
      account: { id: string };
      followers: { at: number; value: number }[];
      views: { value: number | null }[];
    }>("/v1/accounts/demo_travel/metrics?from=2026-10-20&to=2026-10-23");
    expect(total.status).toBe(200);
    expect(total.json.account).toMatchObject({ id: "demo_travel", platform: "instagram" });
    expect(total.json.followers.map((p) => p.value)).toEqual([100, 104, 110]);
    expect(total.json.views.map((p) => p.value)).toEqual([null, 60, null, null]);
    const daily = await tool<{ followers: { value: number | null }[] }>("get_account_metrics", {
      account: "demo_travel",
      daily: true,
      from: "2026-10-21",
      to: "2026-10-23",
    });
    expect(daily.structuredContent.followers.map((p) => p.value)).toEqual([4, null, 6]);
    expect((await rest("/v1/accounts/nobody/metrics")).status).toBe(404);
  });
});

describe("list_performance", () => {
  type Row = {
    key: string;
    views: number | null;
    follows: number | null;
    views_24h: number | null;
    published_at: string;
  };
  // three posts in October's window, a Trial copy of a, a post of September and one of another account
  const seed = async () => {
    const p = (d: string) => noon(d);
    for (const [key, d, views, follows, account] of [
      ["reel:A/a", "2026-10-10", 900, 12, "demo_travel"],
      ["reel:A/b", "2026-10-12", 1500, null, "demo_travel"],
      ["reel:A/c", "2026-10-14", 300, 2, "demo_travel"],
      ["reel:A/old", "2026-09-10", 9000, 50, "demo_travel"],
      ["reel:R/x", "2026-10-11", 400, 1, "demo_running"],
    ] as const) {
      await posted(key, p(d), account);
      await sample(key, p(d) + 86400, { views: views / 2, follows: follows === null ? null : 0 }, account);
      await sample(key, p(d) + 5 * 86400, { views, follows }, account);
    }
    await env.DB.prepare(
      "INSERT INTO trial_posts (item_key, account, media_id, published_at) VALUES ('reel:A/a', 'demo_travel', 't', ?1)",
    )
      .bind(p("2026-10-10") + 600)
      .run();
    await sample("trial:reel:A/a", p("2026-10-11"), { views: 100, follows: 4 });
  };

  it("one row per post or video published in the window, most viewed first, its Trial copy after its Reel", async () => {
    await seed();
    const r = await rest<{ rows: Row[]; limit: number; sort: string }>("/v1/performance?from=2026-10-01&to=2026-10-31");
    expect(r.status).toBe(200);
    expect(r.json.rows.map((x) => x.key)).toEqual(["reel:A/b", "reel:A/a", "trial:reel:A/a", "reel:R/x", "reel:A/c"]);
    expect(r.json.rows.find((x) => x.key === "reel:A/a")).toMatchObject({ views: 900, follows: 12, views_24h: 450 });
    expect(r.json).toMatchObject({ sort: "views", limit: 50 });
  });

  it("sorts by any count, rows without it last; filters by account; caps the limit at 200", async () => {
    await seed();
    const byFollows = await tool<{ rows: Row[] }>("list_performance", {
      from: "2026-10-01",
      to: "2026-10-31",
      account: "demo_travel",
      sort: "follows",
    });
    expect(byFollows.isError).toBe(false);
    expect(byFollows.structuredContent.rows.map((x) => x.key)).toEqual([
      "reel:A/a",
      "trial:reel:A/a",
      "reel:A/c",
      "reel:A/b",
    ]);
    const two = await rest<{ rows: Row[] }>("/v1/performance?from=2026-10-01&to=2026-10-31&limit=2");
    expect(two.json.rows).toHaveLength(2);
    expect((await rest<{ limit: number }>("/v1/performance?limit=500")).json.limit).toBe(200);
    expect((await rest("/v1/performance?sort=mood")).status).toBe(400);
  });
});

describe("ingest_metrics", () => {
  const KEY_IN = "bongsu_ingestingestingestingestin";
  const iso = (unix: number) => new Date(unix * 1000).toISOString();
  const send = (body: unknown, key = KEY_IN) =>
    rest<Record<string, unknown>>("/v1/metrics", key, { method: "POST", body: JSON.stringify(body) });
  const counts = async () => ({
    posts: (await env.DB.prepare("SELECT COUNT(*) AS n FROM post_metrics").first<{ n: number }>())?.n,
    accounts: (await env.DB.prepare("SELECT COUNT(*) AS n FROM account_metrics").first<{ n: number }>())?.n,
  });
  let key = "";
  beforeEach(async () => {
    await addKey("k_in", KEY_IN, ["read", "metrics"]);
    key = (await seedReel(w)).key;
    await posted(key, noon("2026-10-20"));
  });

  it("needs the opt-in metrics scope", async () => {
    expect(
      (await send({ accounts: [{ account: "demo_travel", at: iso(noon("2026-10-21")), followers: 5 }] }, KEY)).status,
    ).toBe(403);
    const list = (await (
      await req("/mcp", KEY, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) })
    ).json()) as { result: { tools: { name: string }[] } };
    expect(list.result.tools.map((t) => t.name)).not.toContain("ingest_metrics");
  });

  it("adds post and account samples the app and the tools read like sampled ones; a second upload adds nothing", async () => {
    const body = {
      posts: [
        { key, at: iso(noon("2026-10-21")), views: 500, follows: 7 },
        { key, at: "2026-10-22T12:00:00+09:00", views: 800, follows: 9 },
      ],
      accounts: [{ account: "demo_travel", at: iso(noon("2026-10-21")), followers: 120 }],
    };
    const r = await send(body);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ posts: { added: 2, skipped: 0 }, accounts: { added: 1, skipped: 0 } });
    const m = await rest<{ samples: Pt[] }>(`/v1/items/${key}/metrics`);
    expect(m.json.samples.map((p) => [p.views, p.follows])).toEqual([
      [500, 7],
      [800, 9],
    ]);
    const row = await env.DB.prepare("SELECT account, platform, workspace_id FROM post_metrics LIMIT 1").first();
    expect(row).toEqual({ account: "demo_travel", platform: "instagram", workspace_id: "default" });
    expect((await send(body)).json).toEqual({ posts: { added: 0, skipped: 2 }, accounts: { added: 0, skipped: 1 } });
    expect(await env.DB.prepare("SELECT action FROM audit WHERE action = 'ingest_metrics'").first()).toBeTruthy();
  });

  it("checks every row first: one bad row writes nothing and says which", async () => {
    const r = await send({
      posts: [
        { key, at: iso(noon("2026-10-21")), views: 500 },
        { key: "reel:nope/x", at: iso(noon("2026-10-21")), views: 1 },
        { key, at: "2026-10-21 12:00", views: 1 },
        { key, at: iso(Math.floor(Date.now() / 1000) + 3600), views: 1 },
        { key, at: iso(noon("2026-10-21")), views: -3 },
      ],
      accounts: [{ account: "nobody", at: iso(noon("2026-10-21")), followers: 1 }],
    });
    expect(r.status).toBe(400);
    const msg = String(r.json.error);
    for (const bit of ["posts[1]", "posts[2]", "posts[3]", "posts[4]", "accounts[0]"]) expect(msg).toContain(bit);
    expect(msg).not.toContain("posts[0]");
    expect(await counts()).toEqual({ posts: 0, accounts: 0 });
  });

  it("at most 500 rows a call; something to add", async () => {
    const many = Array.from({ length: 501 }, (_, i) => ({
      account: "demo_travel",
      at: iso(noon("2026-10-01") + i * 60),
      followers: i,
    }));
    expect((await send({ accounts: many })).status).toBe(400);
    expect((await send({})).status).toBe(400);
  });
});

describe("stats at scale and the ingest's guards", () => {
  const KEY_IN = "bongsu_guardguardguardguardguardg";
  const iso = (unix: number) => new Date(unix * 1000).toISOString();
  const send = (body: unknown) =>
    rest<Record<string, unknown>>("/v1/metrics", KEY_IN, { method: "POST", body: JSON.stringify(body) });
  // many planned posts that went out, without the slow seeding of a real plan
  const many = async (n: number) => {
    const keys = Array.from({ length: n }, (_, i) => `reel:BULK/p${String(i).padStart(3, "0")}`);
    const stmts = keys.flatMap((k, i) => [
      env.DB.prepare(
        "INSERT INTO plan_items (item_key, account, folder, name, created_at, updated_at) VALUES (?1, 'demo_travel', 'BULK', ?2, 0, 0)",
      ).bind(k, `p${i}`),
      env.DB.prepare(
        "INSERT INTO posted (item_key, account, media_id, source, published_at) VALUES (?1, 'demo_travel', 'm', 'scheduler', ?2)",
      ).bind(k, noon("2026-10-10")),
    ]);
    for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
    return keys;
  };
  beforeEach(async () => {
    await addKey("k_guard", KEY_IN, ["read", "metrics"]);
  });

  it("takes an upload of 150 posts and ranks 150 posts (more values than a statement can bind)", async () => {
    const keys = await many(150);
    const r = await send({ posts: keys.map((key, i) => ({ key, at: iso(noon("2026-10-11")), views: i })) });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ posts: { added: 150, skipped: 0 } });
    expect(
      (await send({ posts: keys.map((key, i) => ({ key, at: iso(noon("2026-10-11")), views: i })) })).json,
    ).toMatchObject({
      posts: { added: 0, skipped: 150 },
    });
    const p = await rest<{ rows: { key: string }[] }>("/v1/performance?from=2026-10-01&to=2026-10-31&limit=200");
    expect(p.status).toBe(200);
    expect(p.json.rows).toHaveLength(150);
  });

  it("refuses samples from the last hour, unknown fields and rows without a number", async () => {
    const [key] = await many(1);
    const r = await send({
      posts: [
        { key, at: iso(Math.floor(Date.now() / 1000) - 600), views: 1 },
        { key, at: iso(noon("2026-10-11")), vews: 1 },
        { key, at: iso(noon("2026-10-11")) },
      ],
      accounts: [{ account: "demo_travel", at: iso(noon("2026-10-11")) }],
    });
    expect(r.status).toBe(400);
    const msg = String(r.json.error);
    expect(msg).toContain("posts[0]: at must be at least an hour ago");
    expect(msg).toContain("posts[1]: unknown field vews");
    expect(msg).toContain("posts[2]: no counts");
    expect(msg).toContain("accounts[0]: followers");
  });

  it("looks a video up with one refresh of each channel per upload, however many ids", async () => {
    w.ytUploads = [
      { id: "vidA00000001", title: "A", privacy: "public", publishedAt: iso(noon("2026-10-10")), duration: "PT30S" },
    ];
    const before = w.ytListCalls;
    const r = await send({
      posts: [
        { key: "video:vidA00000001", at: iso(noon("2026-10-11")), views: 5 },
        ...[1, 2, 3, 4, 5, 6].map((n) => ({ key: `video:vidX0000000${n}`, at: iso(noon("2026-10-11")), views: 1 })),
      ],
    });
    expect(r.status).toBe(400); // the six unknown ones
    expect(w.ytListCalls - before).toBeLessThanOrEqual(4); // main and vlogs: a cached read and one refresh each
    expect(String(r.json.error)).toContain("posts[1]");
  });

  it("a malformed to is a 400", async () => {
    expect((await rest("/v1/performance?to=garbage")).status).toBe(400);
    expect((await rest("/v1/accounts/demo_travel/metrics?to=garbage")).status).toBe(400);
  });
});
