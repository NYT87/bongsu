// The channel page's route (Phase 9): an account's followers over a period, views per day across its posts, and the
// posts and videos ranked by the followers they brought; the Stats tab's accounts and last week's posts (#152).
import { env } from "cloudflare:workers";
import { appRoutes } from "@bongsu/api/pwa/routes";
import { createSession } from "@bongsu/api/pwa/session";
import { upsertAccount, upsertConnection } from "@bongsu/core/accounts";
import { utcIso, zoneDate, zoneToUnix } from "@bongsu/core/formats/time";
import { callerZone } from "@bongsu/core/workspaces";
import { beforeEach, describe, expect, it } from "vitest";
import { testEnv, World } from "./world";

const D = 86400;
const H = 3600;
let w: World;
let e: Awaited<ReturnType<typeof testEnv>>;
let cookie = "";
// noon today on the workspace's clock: the samples sit on known days whatever the hour the suite runs
let now = 0;
beforeEach(async () => {
  await env.DB.batch(
    [
      "DELETE FROM account_metrics",
      "DELETE FROM post_metrics",
      "DELETE FROM snapshots",
      "DELETE FROM settings WHERE key LIKE 'yt_uploads:%'",
    ].map((q) => env.DB.prepare(q)),
  );
  e = await testEnv(env);
  w = new World();
  cookie = `bongsu_session=${await createSession(env.DB, Math.floor(Date.now() / 1000), { app: "pwa", userId: "owner" })}`;
  const tz = await callerZone(env.DB, "default");
  now = zoneToUnix(zoneDate(new Date(), tz), "12:00", tz) as number;
});

const get = async <T = Record<string, unknown>>(path: string) => {
  const r = await appRoutes(w.fetch).request(`https://bongsu.test${path}`, { headers: { Cookie: cookie } }, e);
  return { status: r.status, json: (await r.json()) as T };
};
const followers = (account: string, at: number, n: number | null, platform = "instagram", ws = "default") =>
  env.DB.prepare(
    "INSERT INTO account_metrics (account, platform, taken_at, followers, workspace_id) VALUES (?1, ?2, ?3, ?4, ?5)",
  )
    .bind(account, platform, at, n, ws)
    .run();
const post = (
  key: string,
  account: string,
  at: number,
  views: number | null,
  follows: number | null,
  platform = "instagram",
) =>
  env.DB.prepare(
    "INSERT INTO post_metrics (item_key, account, platform, media_id, taken_at, views, follows) VALUES (?1, ?2, ?3, 'm', ?4, ?5, ?6)",
  )
    .bind(key, account, platform, at, views, follows)
    .run();

type Pt = { at: number; value: number | null };
type Channel = {
  account: { id: string; platform: string; followers: number | null; change: number | null; since: string | null };
  followers: { total: Pt[]; daily: Pt[] };
  views: Pt[];
  brought: { key: string; title: string; follows: number; share: number | null; href: string }[];
  analytics: boolean | null;
};

describe("the channel route", () => {
  it("followers, the change since a day before, views per day and what brought followers", async () => {
    for (const [at, n] of [
      [now - 10 * D, 100],
      [now - 3 * D, 105],
      [now - D, 110],
      [now - 2 * H, 116], // younger than 20 h before the latest: not what the change counts from
      [now - H, 118],
    ])
      await followers("demo_travel", at, n);
    // a: sampled before the period (its base); b: first sampled inside it; the copy of a: its own followers
    await post("reel:A/a", "demo_travel", now - 10 * D, 50, 2);
    await post("reel:A/a", "demo_travel", now - 2 * D, 100, 10);
    await post("reel:A/a", "demo_travel", now - H, 250, 14);
    await post("reel:A/b", "demo_travel", now - 3 * D, 10, 1);
    await post("reel:A/b", "demo_travel", now - H, 40, 5);
    await post("trial:reel:A/a", "demo_travel", now - 2 * D, 0, 0);
    await post("trial:reel:A/a", "demo_travel", now - H, 0, 3);
    await post("reel:X/other", "demo_running", now - 2 * D, 1, 1); // another account's post
    await post("reel:X/other", "demo_running", now - H, 999, 99);

    const r = await get<Channel>("/app-api/stats/channel?account=demo_travel&days=7");
    expect(r.status).toBe(200);
    expect(r.json.account).toMatchObject({
      id: "demo_travel",
      platform: "instagram",
      followers: 118,
      change: 8,
      since: utcIso(now - D),
    });
    expect(r.json.followers.total.map((p) => p.value)).toEqual([105, 110, 116, 118]);
    expect(r.json.followers.daily.filter((p) => p.value !== null).map((p) => p.value)).toEqual([5, 5, 8]);
    expect(r.json.views.at(-1)?.value).toBe(180); // a's 150 and b's 30 on the last day
    expect(r.json.brought).toEqual([
      {
        key: "reel:A/a",
        title: "reel:A/a",
        platform: "instagram",
        follows: 12,
        share: 12 / 18,
        href: "#/item/reel%3AA%2Fa/results",
      },
      {
        key: "reel:A/b",
        title: "reel:A/b",
        platform: "instagram",
        follows: 4,
        share: 4 / 18,
        href: "#/item/reel%3AA%2Fb/results",
      },
      {
        key: "trial:reel:A/a",
        title: "reel:A/a · Trial Reel",
        platform: "instagram",
        follows: 3,
        share: 3 / 18,
        href: "#/item/reel%3AA%2Fa/results",
      },
    ]);
    expect(r.json.analytics).toBeNull();
  });

  it("views per day count a post's publishing day when it was sampled from its first hours", async () => {
    // posted yesterday at 10:00, first sample 10 minutes later; an older post first sampled long after publishing
    await env.DB.prepare(
      "INSERT INTO posted (item_key, account, media_id, source, published_at) VALUES ('reel:A/new', 'demo_travel', 'm', 'scheduler', ?1), ('reel:A/old', 'demo_travel', 'm', 'scheduler', ?2)",
    )
      .bind(now - D - 2 * H, now - 60 * D)
      .run();
    await post("reel:A/new", "demo_travel", now - D - 2 * H + 600, 5, 0);
    await post("reel:A/new", "demo_travel", now - D + 6 * H, 300, 4);
    await post("reel:A/new", "demo_travel", now - H, 400, 6);
    await post("reel:A/old", "demo_travel", now - D, 7000, 0); // lifetime views when first seen: a base, not growth
    await post("reel:A/old", "demo_travel", now - H, 7010, 0);
    const r = await get<Channel>("/app-api/stats/channel?account=demo_travel&days=7");
    expect(r.json.views.slice(-2).map((p) => p.value)).toEqual([300, 110]);
  });

  it("a share above the account's net change isn't shown", async () => {
    await followers("demo_travel", now - 10 * D, 100);
    await followers("demo_travel", now - H, 102);
    await post("reel:A/a", "demo_travel", now - 10 * D, 0, 0);
    await post("reel:A/a", "demo_travel", now - H, 0, 5);
    const r = await get<Channel>("/app-api/stats/channel?account=demo_travel&days=7");
    expect(r.json.brought).toMatchObject([{ key: "reel:A/a", follows: 5, share: null }]);
  });

  it("an account with one sample: no change, no daily points", async () => {
    await followers("demo_travel", now - H, 50);
    const r = await get<Channel>("/app-api/stats/channel?account=demo_travel");
    expect(r.json.account).toMatchObject({ followers: 50, change: null, since: null });
    expect(r.json.followers.daily).toEqual([]);
    expect(r.json.brought).toEqual([]);
  });

  it("days is 7, 30 or 90; an account of another workspace or none is 404", async () => {
    expect((await get("/app-api/stats/channel?account=demo_travel&days=5")).status).toBe(400);
    await env.DB.prepare(
      "INSERT INTO workspaces (id, name, created_at) VALUES ('b', 'Workspace B', 0) ON CONFLICT (id) DO NOTHING",
    ).run();
    await upsertConnection(
      env.DB,
      { id: "c_b_x", workspaceId: "b", provider: "composio", kind: "composio", externalRef: "x" },
      0,
    );
    await upsertAccount(
      env.DB,
      { id: "b_x", workspaceId: "b", platform: "instagram", handle: "b_x", connectionId: "c_b_x" },
      0,
    );
    expect((await get("/app-api/stats/channel?account=b_x")).status).toBe(404);
    expect((await get("/app-api/stats/channel?account=nobody_here")).status).toBe(404);
  });

  it("a YouTube channel: its videos by the subscribers they brought, and whether it has the analytics scope", async () => {
    const tz = await callerZone(env.DB, "default");
    await env.DB.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('yt_uploads:main', ?1, ?2)")
      .bind(
        JSON.stringify([
          { id: "vidA00000001", title: "A video", privacy: "public", when: utcIso(now - 2 * D), short: false },
        ]),
        now,
      )
      .run();
    await post("video:vidA00000001", "main", now - 2 * D, 10, 0, "youtube");
    await post("video:vidA00000001", "main", now - H, 90, 6, "youtube");
    const r = await get<Channel>("/app-api/stats/channel?account=main");
    expect(r.json.analytics).toBe(true);
    expect(r.json.brought).toEqual([
      {
        key: "video:vidA00000001",
        title: "A video",
        platform: "youtube",
        follows: 6,
        share: null, // no follower samples to compare with
        source: "elsewhere",
        href: `#/video/main/vidA00000001?d=${zoneDate(new Date((now - 2 * D) * 1000), tz)}`,
      },
    ]);
  });
});

type Overview = {
  days: number;
  accounts: { id: string; followers: number | null; change: number | null; since: string | null }[];
  recent: { key: string; title: string; views: number | null; published_at: string | null; href: string }[];
};

describe("the Stats tab", () => {
  it("reads the accounts' followers from the account series, with the time of the sample it compares with", async () => {
    await followers("demo_travel", now - D - H, 90);
    await followers("demo_travel", now - H, 97);
    const r = await get<Overview>("/app-api/stats");
    expect(r.status).toBe(200);
    expect(r.json.accounts.find((a) => a.id === "demo_travel")).toMatchObject({
      followers: 97,
      change: 7,
      since: utcIso(now - D - H),
    });
    // an account without samples is listed with nothing to show yet
    expect(r.json.accounts.find((a) => a.id === "demo_running")).toMatchObject({ followers: null, change: null });
  });

  it("lists the last 7 days' posts most viewed first, each opening its Results; older ones stay out", async () => {
    await post("reel:20261001_X/short1_a", "demo_travel", now - 2 * D, 300, null);
    await post("reel:20261001_X/short2_b", "demo_travel", now - D, 900, null);
    await post("reel:20261001_X/short0_old", "demo_travel", now - 10 * D, 5000, null);
    const r = await get<Overview>("/app-api/stats");
    expect(r.json.days).toBe(7);
    expect(r.json.recent.map((x) => [x.key, x.views, x.href])).toEqual([
      ["reel:20261001_X/short2_b", 900, `#/item/${encodeURIComponent("reel:20261001_X/short2_b")}/results`],
      ["reel:20261001_X/short1_a", 300, `#/item/${encodeURIComponent("reel:20261001_X/short1_a")}/results`],
    ]);
  });

  it("shows nothing of another workspace", async () => {
    await env.DB.prepare(
      "INSERT INTO workspaces (id, name, created_at) VALUES ('b', 'Workspace B', 0) ON CONFLICT (id) DO NOTHING",
    ).run();
    await followers("b_x", now - H, 3, "instagram", "b");
    await env.DB.prepare(
      "INSERT INTO post_metrics (item_key, account, platform, media_id, taken_at, views, workspace_id) VALUES ('reel:B/x', 'b_x', 'instagram', 'm', ?1, 50, 'b')",
    )
      .bind(now - D)
      .run();
    const r = await get<Overview>("/app-api/stats");
    expect(r.json.accounts.map((a) => a.id)).not.toContain("b_x");
    expect(r.json.recent).toEqual([]);
  });

  it("the old snapshot and review routes are gone", async () => {
    for (const path of ["/app-api/performance", "/app-api/report?name=x"]) {
      const r = await appRoutes(w.fetch).request(`https://bongsu.test${path}`, { headers: { Cookie: cookie } }, e);
      expect(r.status).toBe(404);
    }
  });
});
