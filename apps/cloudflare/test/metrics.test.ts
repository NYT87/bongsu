// The metrics sampler (Phase 9): which posts it samples when, one videos.list per channel, the 24 h result reusing a
// fresh sample, rows tagged with the workspace, and the per-run cap.
import { env } from "cloudflare:workers";
import { appRoutes } from "@bongsu/api/pwa/routes";
import { createSession } from "@bongsu/api/pwa/session";
import { upsertAccount, upsertConnection } from "@bongsu/core/accounts";
import { METRICS_ATTEMPTS_PER_RUN, METRICS_DENSE_S, METRICS_PER_RUN } from "@bongsu/core/constants";
import { utcIso } from "@bongsu/core/formats/time";
import { sampleMetrics } from "@bongsu/core/metrics";
import { postResults } from "@bongsu/core/results";
import { beforeEach, describe, expect, it } from "vitest";
import { clearPlan, seedReel, testEnv, World } from "./world";

const T0 = new Date("2026-10-26T03:00:00Z");
const at = (h: number) => new Date(T0.getTime() + h * 3600_000);
const s = (d: Date) => Math.floor(d.getTime() / 1000);

let w: World;
let e: Awaited<ReturnType<typeof testEnv>>;
beforeEach(async () => {
  await env.DB.batch(
    [
      "DELETE FROM post_metrics",
      "DELETE FROM post_results",
      "DELETE FROM trial_posts",
      "DELETE FROM settings WHERE key LIKE 'metrics_failed:%' OR key LIKE 'metrics_nofollows:%' OR key LIKE 'yt_uploads:%'",
    ].map((q) => env.DB.prepare(q)),
  );
  await clearPlan();
  e = await testEnv(env);
  w = new World();
  // every call reads the media's lifetime views one step higher
  const reads = new Map<string, number>();
  w.composio.INSTAGRAM_GET_IG_MEDIA_INSIGHTS = (a) => {
    const n = (reads.get(String(a.ig_media_id)) ?? 0) + 1;
    reads.set(String(a.ig_media_id), n);
    return {
      data: [
        ["views", 100 * n],
        ["reach", 60 * n],
        ["likes", 10 * n],
        ["comments", n],
        ["saved", 2 * n],
        ["shares", n],
        // the follow metrics only when asked for, as the Graph API answers
        ...(String(a.metric).includes("follows")
          ? [
              ["follows", 7 * n],
              ["profile_visits", 8 * n],
            ]
          : []),
      ].map(([name, value]) => ({ name, values: [{ value }] })),
    };
  };
});

const posted = (key: string, mediaId: string, published: Date, account = "demo_travel") =>
  env.DB.prepare(
    "INSERT INTO posted (item_key, account, media_id, source, published_at) VALUES (?1, ?2, ?3, 'scheduler', ?4)",
  )
    .bind(key, account, mediaId, s(published))
    .run();
const rows = (key?: string) =>
  env.DB.prepare(
    "SELECT item_key, account, platform, media_id, taken_at, views, reach, likes, comments, saves, shares, follows, profile_visits, workspace_id FROM post_metrics WHERE ?1 IS NULL OR item_key = ?1 ORDER BY taken_at, item_key",
  )
    .bind(key ?? null)
    .all<{
      views: number | null;
      follows: number | null;
      profile_visits: number | null;
      taken_at: number;
      item_key: string;
      account: string;
      platform: string;
      workspace_id: string;
    }>()
    .then((r) => r.results);
const sample = (now: Date) => sampleMetrics(e, { fetch: w.fetch, now });

describe("the metrics sampler", () => {
  it("samples a fresh post, not again 5 h later, again 6 h later", async () => {
    await posted("reel:A/a", "m-1", T0);
    expect((await sample(T0)).sampled).toEqual(["reel:A/a"]);
    expect((await sample(at(5))).sampled).toEqual([]);
    expect((await sample(at(6))).sampled).toEqual(["reel:A/a"]);
    const r = await rows("reel:A/a");
    expect(r.map((x) => x.taken_at)).toEqual([s(T0), s(at(6))]);
    expect(r.map((x) => x.views)).toEqual([100, 200]);
    expect(r[0]).toMatchObject({ platform: "instagram", reach: 60, likes: 10, comments: 1, saves: 2, shares: 1 });
  });

  it("an Instagram sample records the followers and profile visits the post brought", async () => {
    await posted("reel:A/f", "m-f", at(-1));
    await sample(T0);
    expect(await rows("reel:A/f")).toMatchObject([{ views: 100, follows: 7, profile_visits: 8 }]);
  });

  it("a media whose type has no follow metrics keeps the other counts, after one retry without them", async () => {
    w.composio.INSTAGRAM_GET_IG_MEDIA_INSIGHTS = ((ok) => (a: Record<string, unknown>, account: string) => {
      if (a.ig_media_id === "m-nf" && String(a.metric).includes("follows"))
        throw new Error(
          "(#100) metric[6] must be one of the following values: views, reach, likes, comments, saved, shares",
        );
      return ok(a, account);
    })(w.composio.INSTAGRAM_GET_IG_MEDIA_INSIGHTS);
    await posted("reel:A/nf", "m-nf", at(-1));
    await sample(T0);
    expect(w.calls.filter((c) => c.args.ig_media_id === "m-nf")).toHaveLength(2);
    expect(await rows("reel:A/nf")).toMatchObject([{ views: 100, follows: null, profile_visits: null }]);
    // the refusal is remembered: the next sample asks once, without the follow metrics
    await sample(at(6));
    expect(w.calls.filter((c) => c.args.ig_media_id === "m-nf")).toHaveLength(3);
    expect(String(w.calls.filter((c) => c.args.ig_media_id === "m-nf").at(-1)?.args.metric)).not.toContain("follows");
  });

  it("the 24 h line has no followers part when the sample has none", async () => {
    w.composio.INSTAGRAM_GET_IG_MEDIA_INSIGHTS = () => ({
      data: [
        ["views", 50],
        ["likes", 1],
      ].map(([name, value]) => ({ name, values: [{ value }] })),
    });
    await posted("reel:A/plain", "m-plain", at(-25));
    await postResults(e, { fetch: w.fetch, now: T0 });
    expect(w.notifications.at(-1)?.body).toContain("50 views");
    expect(w.notifications.at(-1)?.body).not.toContain("followers");
  });

  it("samples daily after 3 days", async () => {
    await posted("reel:A/a", "m-1", at(-4 * 24));
    const put = (when: Date) =>
      env.DB.prepare(
        "INSERT INTO post_metrics (item_key, account, platform, media_id, taken_at, views) VALUES ('reel:A/a', 'demo_travel', 'instagram', 'm-1', ?1, 1)",
      )
        .bind(s(when))
        .run();
    await put(at(-23)); // 23 h ago: a day's wait isn't over
    expect((await sample(T0)).sampled).toEqual([]);
    await put(at(-25));
    await env.DB.prepare("DELETE FROM post_metrics WHERE taken_at = ?1")
      .bind(s(at(-23)))
      .run();
    expect((await sample(T0)).sampled).toEqual(["reel:A/a"]);
  });

  it("samples a channel's public uploads with one videos.list, once even when two accounts share the channel", async () => {
    w.ytUploads = [
      { id: "vidA00000001", title: "A", privacy: "public", publishedAt: at(-2).toISOString(), duration: "PT10M" },
      { id: "vidB00000002", title: "B", privacy: "public", publishedAt: at(-3).toISOString(), duration: "PT30S" },
      { id: "vidC00000003", title: "C", privacy: "private", publishedAt: at(-3).toISOString(), duration: "PT30S" },
    ];
    // main and vlogs both read the fake's one channel: each video is still one candidate
    expect((await sample(T0)).sampled.sort()).toEqual(["video:vidA00000001", "video:vidB00000002"]);
    expect(w.ytStatCalls).toHaveLength(1);
    const r = await rows();
    expect(r.map((x) => [x.item_key, x.platform])).toEqual([
      ["video:vidA00000001", "youtube"],
      ["video:vidB00000002", "youtube"],
    ]);
    expect(r[0]).toMatchObject({ views: 100, likes: 10, comments: 1, reach: null, saves: null, shares: null });
  });

  it("a YouTube sample records the subscribers the video gained, one Analytics query per channel", async () => {
    w.ytUploads = [
      { id: "vidA00000001", title: "A", privacy: "public", publishedAt: at(-2).toISOString(), duration: "PT10M" },
      { id: "vidB00000002", title: "B", privacy: "public", publishedAt: at(-3).toISOString(), duration: "PT30S" },
    ];
    w.ytAnalyticsGained.set("vidA00000001", 5).set("vidB00000002", 9);
    await sample(T0);
    expect(w.ytAnalyticsCalls.map((ids) => [...ids].sort())).toEqual([["vidA00000001", "vidB00000002"]]);
    expect((await rows()).map((x) => [x.item_key, x.follows, x.profile_visits])).toEqual([
      ["video:vidA00000001", 5, null],
      ["video:vidB00000002", 9, null],
    ]);
    // the top-videos report's shape; Analytics days are Pacific Time, so the query starts the UTC day before
    const q = w.ytAnalyticsQueries[0];
    expect(q.get("sort")).toBe("-subscribersGained");
    expect(q.get("maxResults")).toBe("50");
    expect(q.get("startDate")).toBe("2026-10-25"); // B went out 2026-10-26T00:00Z
  });

  it("a young video the Analytics report has no row for yet: subscribers unknown, not 0", async () => {
    w.ytUploads = [
      { id: "vidA00000001", title: "A", privacy: "public", publishedAt: at(-2).toISOString(), duration: "PT10M" },
      { id: "vidD00000004", title: "D", privacy: "public", publishedAt: at(-80).toISOString(), duration: "PT10M" },
    ];
    w.ytAnalyticsNoRow.add("vidA00000001").add("vidD00000004");
    await sample(T0);
    expect((await rows()).map((x) => [x.item_key, x.follows])).toEqual([
      ["video:vidA00000001", null], // 2 h old: Analytics publishes a day or more late
      ["video:vidD00000004", 0], // past 72 h: no row means none gained
    ]);
  });

  it("a channel connected without the analytics scope: no Analytics query, subscribers unknown", async () => {
    const old = {
      client_id: "c",
      client_secret: "s",
      refresh_token: "r-main",
      token_uri: "https://oauth2.googleapis.com/token",
    };
    (e as unknown as Record<string, unknown>).YT_MAIN_OAUTH = JSON.stringify(old);
    (e as unknown as Record<string, unknown>).YT_VLOGS_OAUTH = JSON.stringify({ ...old, refresh_token: "r-vlogs" });
    w.ytUploads = [
      { id: "vidA00000001", title: "A", privacy: "public", publishedAt: at(-2).toISOString(), duration: "PT10M" },
    ];
    await sample(T0);
    expect(w.ytAnalyticsCalls).toEqual([]);
    expect(await rows()).toMatchObject([{ item_key: "video:vidA00000001", views: 100, follows: null }]);
  });

  it("a refused Analytics query keeps the statistics sample", async () => {
    w.ytAnalyticsScope = false;
    w.ytUploads = [
      { id: "vidA00000001", title: "A", privacy: "public", publishedAt: at(-2).toISOString(), duration: "PT10M" },
    ];
    await sample(T0);
    expect(w.ytAnalyticsCalls).toHaveLength(1);
    expect(await rows()).toMatchObject([{ item_key: "video:vidA00000001", views: 100, follows: null }]);
  });

  it("an empty or missing count is null, not 0", async () => {
    w.ytUploads = [
      { id: "vidA00000001", title: "A", privacy: "public", publishedAt: at(-2).toISOString(), duration: "PT10M" },
    ];
    w.ytStatOverride.set("vidA00000001", { viewCount: "", likeCount: "7" });
    await sample(T0);
    expect(await rows()).toMatchObject([{ views: null, likes: 7, comments: null }]);
  });

  it("a failing channel costs one attempt, not one per video", async () => {
    w.ytStatFail = true;
    w.ytUploads = Array.from({ length: 20 }, (_, i) => ({
      id: `vid${String(i).padStart(9, "0")}`,
      title: `V${i}`,
      privacy: "public",
      publishedAt: at(-30 - i).toISOString(), // older than the posts: first in the due order
      duration: "PT10M",
    }));
    for (let i = 0; i < METRICS_PER_RUN; i++) await posted(`reel:A/${i}`, `m-${i}`, at(-i - 1));
    expect((await sample(T0)).sampled).toHaveLength(METRICS_PER_RUN);
    expect(w.ytStatCalls).toHaveLength(1);
    expect((await rows()).every((r) => r.platform === "instagram")).toBe(true);
  });

  it("a failing post doesn't use a slot of the run, waits an interval, and loses its stamp on success", async () => {
    let broken = true;
    w.composio.INSTAGRAM_GET_IG_MEDIA_INSIGHTS = ((ok) => (a: Record<string, unknown>, account: string) => {
      if (a.ig_media_id === "m-bad" && broken) throw new Error("media deleted");
      return ok(a, account);
    })(w.composio.INSTAGRAM_GET_IG_MEDIA_INSIGHTS);
    await posted("reel:A/bad", "m-bad", at(-10)); // the oldest: first in the due order
    for (let i = 0; i < METRICS_PER_RUN; i++) await posted(`reel:C/${i}`, `m-${i}`, at(-i - 1), "demo_cycling");
    const asked = () => w.calls.filter((c) => c.args.ig_media_id === "m-bad").length;
    const stamp = () =>
      env.DB.prepare("SELECT value FROM settings WHERE key = 'metrics_failed:reel:A/bad'").first<{ value: string }>();
    expect((await sample(T0)).sampled).toHaveLength(METRICS_PER_RUN);
    expect(await rows("reel:A/bad")).toHaveLength(0);
    expect(asked()).toBe(1);
    expect(Number((await stamp())?.value)).toBe(s(T0));
    expect((await sample(at(1))).sampled).toEqual([]); // the failed one waits an interval; the others aren't due
    expect(asked()).toBe(1);
    broken = false;
    expect((await sample(new Date(T0.getTime() + METRICS_DENSE_S * 1000))).sampled).toContain("reel:A/bad");
    expect(asked()).toBe(2);
    expect(await stamp()).toBeNull();
  });

  it("drops a failure stamp older than the sampling window", async () => {
    await env.DB.prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES ('metrics_failed:reel:A/old', '1', 1), ('metrics_failed:reel:A/new', ?1, ?1)",
    )
      .bind(s(at(-1)))
      .run();
    await sample(T0);
    const keys = await env.DB.prepare("SELECT key FROM settings WHERE key LIKE 'metrics_failed:%'").all<{
      key: string;
    }>();
    expect(keys.results.map((r) => r.key)).toEqual(["metrics_failed:reel:A/new"]);
  });

  it("a broken account doesn't starve the others: one attempt a run, then the failed posts wait", async () => {
    w.composio.INSTAGRAM_GET_IG_MEDIA_INSIGHTS = ((ok) => (a: Record<string, unknown>, account: string) => {
      if (String(a.ig_media_id).startsWith("m-bad")) throw new Error("token revoked");
      return ok(a, account);
    })(w.composio.INSTAGRAM_GET_IG_MEDIA_INSIGHTS);
    const n = 2 * METRICS_ATTEMPTS_PER_RUN;
    for (let i = 0; i < n; i++) await posted(`reel:A/bad${i}`, `m-bad${i}`, at(-20 - i)); // all due before the healthy
    await posted("reel:C/ok", "m-ok", at(-1), "demo_cycling");
    const asked = () =>
      w.calls.filter((c) => String(c.args.ig_media_id).startsWith("m-bad")).map((c) => c.args.ig_media_id);
    expect((await sample(T0)).sampled).toEqual(["reel:C/ok"]);
    expect(asked()).toHaveLength(1); // the account's first failure ends its turn this run
    const first = asked()[0];
    await sample(at(1));
    expect(asked().filter((id) => id === first)).toHaveLength(1); // the failed one isn't tried again within the interval
    expect(asked()).toHaveLength(2);
    // after an interval the account gets its one attempt again; the never-tried posts rank before the failed ones
    await sample(new Date(T0.getTime() + METRICS_DENSE_S * 1000));
    expect(asked()).toHaveLength(3);
    expect(new Set(asked()).size).toBe(3);
  });

  it("the 24 h result reuses a sample taken within the hour and writes the marker", async () => {
    await posted("reel:A/a", "m-1", at(-25));
    await sample(T0);
    expect(await postResults(e, { fetch: w.fetch, now: at(0.5) })).toEqual({ fetched: ["reel:A/a"] });
    expect(w.calls.filter((c) => c.slug === "INSTAGRAM_GET_IG_MEDIA_INSIGHTS")).toHaveLength(1);
    expect(await rows("reel:A/a")).toHaveLength(1);
    expect(
      await env.DB.prepare("SELECT account, media_id, median_views, fetched_at FROM post_results").first(),
    ).toEqual({ account: "demo_travel", media_id: "m-1", median_views: null, fetched_at: s(at(0.5)) });
    expect(w.notifications.at(-1)!.body).toContain("100 views");
    // a sample from before that hour isn't reused: a new one is taken
    await posted("reel:A/b", "m-2", at(-25));
    await sample(at(-2));
    await postResults(e, { fetch: w.fetch, now: T0 });
    expect(await rows("reel:A/b")).toHaveLength(2);
  });

  it("tags rows with the item's workspace", async () => {
    await env.DB.prepare(
      "INSERT INTO workspaces (id, name, created_at) VALUES ('b', 'Workspace B', 0) ON CONFLICT (id) DO NOTHING",
    ).run();
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
    await posted("reel:A/a", "m-1", T0);
    await posted("reel:B/b", "m-b", T0, "b_shop");
    await sample(T0);
    expect((await rows()).map((x) => [x.item_key, x.workspace_id])).toEqual([
      ["reel:A/a", "default"],
      ["reel:B/b", "b"],
    ]);
  });

  it("tags a channel's uploads with its account's workspace", async () => {
    await env.DB.prepare(
      "INSERT INTO workspaces (id, name, created_at) VALUES ('b', 'Workspace B', 0) ON CONFLICT (id) DO NOTHING",
    ).run();
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
    const up = (id: string) => ({ id, title: id, privacy: "public", when: at(-2).toISOString(), short: true });
    w.ytUploads = ["vidA00000001", "vidB00000002"].map((id) => ({
      id,
      title: id,
      privacy: "public",
      publishedAt: at(-2).toISOString(),
      duration: "PT30S",
    }));
    // each channel's own cached list
    for (const [account, list] of [
      ["main", [up("vidA00000001")]],
      ["vlogs", []],
      ["b_tube", [up("vidB00000002")]],
    ] as const)
      await env.DB.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)")
        .bind(`yt_uploads:${account}`, JSON.stringify(list), s(T0))
        .run();
    const env2 = { ...e, YT_B_OAUTH: (e as unknown as Record<string, string>).YT_MAIN_OAUTH } as typeof e;
    await sampleMetrics(env2, { fetch: w.fetch, now: T0 });
    expect((await rows()).map((x) => [x.item_key, x.account, x.workspace_id])).toEqual([
      ["video:vidA00000001", "main", "default"],
      ["video:vidB00000002", "b_tube", "b"],
    ]);
    expect(w.ytListCalls).toBe(0); // fresh caches: no list refresh
  });

  it("refreshes at most METRICS_REFRESH_PER_RUN stale upload lists a run, the oldest first", async () => {
    await env.DB.prepare(
      "INSERT INTO workspaces (id, name, created_at) VALUES ('b', 'Workspace B', 0) ON CONFLICT (id) DO NOTHING",
    ).run();
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
    // three stale lists: vlogs the oldest, then main, then b_tube
    for (const [account, updated] of [
      ["main", 200],
      ["vlogs", 100],
      ["b_tube", 300],
    ] as const)
      await env.DB.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?1, '[]', ?2)")
        .bind(`yt_uploads:${account}`, updated)
        .run();
    const env2 = { ...e, YT_B_OAUTH: (e as unknown as Record<string, string>).YT_MAIN_OAUTH } as typeof e;
    const updatedAt = async () =>
      Object.fromEntries(
        (
          await env.DB.prepare("SELECT key, updated_at FROM settings WHERE key LIKE 'yt_uploads:%' ORDER BY key").all<{
            key: string;
            updated_at: number;
          }>()
        ).results.map((r) => [r.key.slice("yt_uploads:".length), r.updated_at]),
      );
    await sampleMetrics(env2, { fetch: w.fetch, now: T0 });
    expect(w.ytListCalls).toBe(2);
    expect(await updatedAt()).toEqual({ b_tube: 300, main: s(T0), vlogs: s(T0) });
    await sampleMetrics(env2, { fetch: w.fetch, now: at(0.25) });
    expect(w.ytListCalls).toBe(3);
    expect(await updatedAt()).toEqual({ b_tube: s(at(0.25)), main: s(T0), vlogs: s(T0) });
  });

  it("a video's series continues whichever account lists it first", async () => {
    w.ytUploads = [
      { id: "vidA00000001", title: "A", privacy: "public", publishedAt: at(-2).toISOString(), duration: "PT10M" },
    ];
    // the last sample was taken for vlogs (the account order has changed since): not due again for 6 h
    await env.DB.prepare(
      "INSERT INTO post_metrics (item_key, account, platform, media_id, taken_at, views) VALUES ('video:vidA00000001', 'vlogs', 'youtube', 'vidA00000001', ?1, 1)",
    )
      .bind(s(at(-1)))
      .run();
    expect((await sample(T0)).sampled).toEqual([]);
  });

  it("takes at most METRICS_PER_RUN per run, oldest due first", async () => {
    const n = METRICS_PER_RUN + 2;
    for (let i = 0; i < n; i++) await posted(`reel:A/${i}`, `m-${i}`, at(-i - 1)); // 0 is the newest
    const first = (await sample(T0)).sampled;
    expect(first).toEqual(Array.from({ length: METRICS_PER_RUN }, (_, i) => `reel:A/${n - 1 - i}`));
    const second = (await sample(T0)).sampled;
    expect(second).toEqual([`reel:A/1`, `reel:A/0`]);
  });
});

describe("the metrics routes", () => {
  let cookie = "";
  beforeEach(async () => {
    cookie = `bongsu_session=${await createSession(env.DB, Math.floor(Date.now() / 1000), { app: "pwa", userId: "owner" })}`;
  });
  const get = async <T = Record<string, unknown>>(path: string) => {
    const r = await appRoutes(w.fetch).request(`https://bongsu.test${path}`, { headers: { Cookie: cookie } }, e);
    return { status: r.status, json: (await r.json()) as T };
  };
  type Point = { at: number; views: number | null; likes: number | null };
  type Metrics = { item: Record<string, unknown>; samples: Point[]; trial?: { samples: Point[] }; analytics?: boolean };
  const put = (key: string, when: Date, views: number | null, ws = "default") =>
    env.DB.prepare(
      "INSERT INTO post_metrics (item_key, account, platform, media_id, taken_at, views, likes, workspace_id) VALUES (?1, 'demo_travel', 'instagram', 'm-1', ?2, ?3, ?4, ?5)",
    )
      .bind(key, s(when), views, views === null ? null : views / 10, ws)
      .run();
  const metricsOf = (key: string, q = "") => get<Metrics>(`/app-api/item/metrics?key=${encodeURIComponent(key)}${q}`);
  // T0 is 12:00 on Oct 26 in Seoul, the default workspace's zone
  const days = async (key: string) => {
    await put(key, at(24), 300); // Oct 27 12:00
    await put(key, at(6), 150); // Oct 26 18:00
    await put(key, T0, 100); // Oct 26 12:00
    await put(key, at(48), 450); // Oct 28 12:00
  };

  it("an item's samples by time, with the item", async () => {
    const { key } = await seedReel(w);
    await posted(key, "m-1", T0);
    await days(key);
    const r = await metricsOf(key);
    expect(r.status).toBe(200);
    expect(r.json.item).toMatchObject({
      key,
      platform: "instagram",
      account: "demo_travel",
      published_at: utcIso(s(T0)),
      due: "2026-10-20 18:00 Asia/Seoul",
      due_at: "2026-10-20T09:00:00Z",
    });
    expect(typeof r.json.item.label).toBe("string");
    expect(r.json.samples.map((p) => [p.at, p.views, p.likes])).toEqual([
      [s(T0), 100, 10],
      [s(at(6)), 150, 15],
      [s(at(24)), 300, 30],
      [s(at(48)), 450, 45],
    ]);
    expect(r.json.trial).toBeUndefined();
  });

  it("daily: what each day added, on the caller's clock", async () => {
    const { key } = await seedReel(w);
    await posted(key, "m-1", T0);
    await days(key);
    const r = await metricsOf(key, "&daily=1");
    expect(r.json.samples.map((p) => [p.at, p.views])).toEqual([
      [s(at(24)), 150],
      [s(at(48)), 150],
    ]);
  });

  it("from and to are dates on the caller's clock, inclusive; a daily point still reads the day before", async () => {
    const { key } = await seedReel(w);
    await posted(key, "m-1", T0);
    await days(key);
    await put(key, at(-12.5), 1); // Oct 25 23:30 in Seoul (14:30 UTC): outside, though the same UTC day as T0
    expect((await metricsOf(key, "&from=2026-10-26&to=2026-10-26")).json.samples.map((p) => p.views)).toEqual([
      100, 150,
    ]);
    expect((await metricsOf(key, "&from=2026-10-27")).json.samples.map((p) => p.views)).toEqual([300, 450]);
    expect((await metricsOf(key, "&daily=1&from=2026-10-27&to=2026-10-27")).json.samples.map((p) => p.views)).toEqual([
      150,
    ]);
    expect((await metricsOf(key, "&from=26-10-2026")).status).toBe(400);
  });

  it("daily: a point after a gap is the growth since the previous sampled day, even before from", async () => {
    const { key } = await seedReel(w);
    await posted(key, "m-1", T0);
    await put(key, T0, 100); // Oct 26
    await put(key, at(7 * 24), 800); // Nov 2, a week later
    const daily = await metricsOf(key, "&daily=1");
    expect(daily.json.samples.map((p) => p.views)).toEqual([...Array(6).fill(null), 700]);
    expect((await metricsOf(key, "&daily=1&from=2026-11-02")).json.samples.map((p) => [p.at, p.views])).toEqual([
      [s(at(7 * 24)), 700],
    ]);
  });

  it("keeps the newest 400 points", async () => {
    const { key } = await seedReel(w);
    await posted(key, "m-1", T0);
    await env.DB.batch(
      Array.from({ length: 450 }, (_, i) =>
        env.DB.prepare(
          "INSERT INTO post_metrics (item_key, account, platform, media_id, taken_at, views) VALUES (?1, 'demo_travel', 'instagram', 'm-1', ?2, ?3)",
        ).bind(key, s(T0) + i * 3600, i),
      ),
    );
    const r = (await metricsOf(key)).json.samples;
    expect(r).toHaveLength(400);
    expect([r[0].views, r[399].views]).toEqual([50, 449]);
  });

  it("daily keeps the newest 400 days", async () => {
    const { key } = await seedReel(w);
    await posted(key, "m-1", T0);
    await env.DB.batch(
      Array.from({ length: 450 }, (_, i) =>
        env.DB.prepare(
          "INSERT INTO post_metrics (item_key, account, platform, media_id, taken_at, views) VALUES (?1, 'demo_travel', 'instagram', 'm-1', ?2, ?3)",
        ).bind(key, s(T0) + i * 86400, i * i),
      ),
    );
    const r = (await metricsOf(key, "&daily=true")).json.samples;
    expect(r).toHaveLength(400); // 449 days of differences
    expect([r[0].at, r[0].views]).toEqual([s(T0) + 50 * 86400, 50 * 50 - 49 * 49]);
    expect([r[399].at, r[399].views]).toEqual([s(T0) + 449 * 86400, 449 * 449 - 448 * 448]);
  });

  it("404 for an item that isn't planned", async () => {
    expect((await metricsOf("reel:Nope/nothing")).status).toBe(404);
  });

  it("the item's 24 h results and samples carry the followers the post brought", async () => {
    const { key } = await seedReel(w);
    await posted(key, "m-1", T0);
    await env.DB.prepare(
      "INSERT INTO post_metrics (item_key, account, platform, media_id, taken_at, views, follows, profile_visits) VALUES (?1, 'demo_travel', 'instagram', 'm-1', ?2, 230, 12, 85)",
    )
      .bind(key, s(at(24)))
      .run();
    const item = await get<{ results: Record<string, unknown> }>(`/app-api/item?key=${encodeURIComponent(key)}`);
    expect(item.json.results).toMatchObject({ views: 230, follows: 12, profile_visits: 85 });
    const m = await get<Metrics>(`/app-api/item/metrics?key=${encodeURIComponent(key)}`);
    expect(m.json.samples).toMatchObject([{ views: 230, follows: 12, profile_visits: 85 }]);
  });

  it("the item's 24 h results read the sample nearest 24 h, with the marker's median", async () => {
    const { key } = await seedReel(w);
    await posted(key, "m-1", T0);
    type Results = Record<string, unknown> | null;
    const results = async () => (await get<{ results: Results }>(`/app-api/item?key=${encodeURIComponent(key)}`)).json;
    expect((await results()).results).toBeNull();
    await put(key, at(6), 150);
    await put(key, at(23), 230);
    await put(key, at(31), 310);
    expect((await results()).results).toEqual({
      views: 230,
      reach: null,
      likes: 23,
      comments: null,
      saves: null,
      shares: null,
      follows: null,
      profile_visits: null,
      median_views: null,
      fetched_at: s(at(23)),
    });
    await env.DB.prepare(
      "INSERT INTO post_results (item_key, account, media_id, median_views, fetched_at) VALUES (?1, 'demo_travel', 'm-1', 200, ?2)",
    )
      .bind(key, s(at(24)))
      .run();
    expect((await results()).results).toMatchObject({ views: 230, median_views: 200, fetched_at: s(at(23)) });
    // a marker without a sample still answers, with its own time
    await env.DB.prepare("DELETE FROM post_metrics").run();
    expect((await results()).results).toMatchObject({ views: null, median_views: 200, fetched_at: s(at(24)) });
  });

  it("24 h means 24 h: a first sample minutes after publishing isn't a result; a late one is with the marker", async () => {
    const { key } = await seedReel(w);
    await posted(key, "m-1", T0);
    const results = async (k = key) =>
      (await get<{ results: Record<string, unknown> | null }>(`/app-api/item?key=${encodeURIComponent(k)}`)).json
        .results;
    await put(key, at(1), 10);
    expect(await results()).toBeNull();
    await put(key, at(25), 250);
    expect(await results()).toMatchObject({ views: 250, fetched_at: s(at(25)) });
    // the 24 h notification went out (marker) but only a late sample exists: that one stands
    const { key: other } = await seedReel(w, { base: "short2_other" });
    await posted(other, "m-2", T0);
    await put(other, at(1), 10);
    await put(other, at(40), 400);
    expect(await results(other)).toBeNull();
    await env.DB.prepare(
      "INSERT INTO post_results (item_key, account, media_id, median_views, fetched_at) VALUES (?1, 'demo_travel', 'm-2', NULL, ?2)",
    )
      .bind(other, s(at(40)))
      .run();
    expect(await results(other)).toMatchObject({ views: 400, fetched_at: s(at(40)) });
  });

  it("the account's median counts only 24 h samples", async () => {
    // two earlier posts with a result: one sampled at 24 h, one only minutes after publishing
    for (const [k, m, v, h] of [
      ["reel:A/one", "m-o1", 100, 24],
      ["reel:A/two", "m-o2", 10, 1],
    ] as const) {
      await posted(k, m, at(-30 * 24));
      await env.DB.prepare(
        "INSERT INTO post_metrics (item_key, account, platform, media_id, taken_at, views) VALUES (?1, 'demo_travel', 'instagram', ?2, ?3, ?4)",
      )
        .bind(k, m, s(at(-30 * 24 + h)), v)
        .run();
      await env.DB.prepare(
        "INSERT INTO post_results (item_key, account, media_id, fetched_at) VALUES (?1, 'demo_travel', ?2, ?3)",
      )
        .bind(k, m, s(at(-30 * 24 + 25)))
        .run();
    }
    await posted("reel:A/new", "m-new", at(-25));
    await postResults(e, { fetch: w.fetch, now: T0 });
    expect(
      await env.DB.prepare("SELECT median_views FROM post_results WHERE item_key = 'reel:A/new'").first("median_views"),
    ).toBe(100);
  });

  it("a Trial copy without samples: no trial samples, no trial results", async () => {
    const { key } = await seedReel(w, { account: "demo_running" });
    await posted(key, "m-1", T0, "demo_running");
    await env.DB.prepare(
      "INSERT INTO trial_posts (item_key, account, media_id, published_at) VALUES (?1, 'demo_running', 'm-t', ?2)",
    )
      .bind(key, s(at(1)))
      .run();
    expect((await metricsOf(key)).json.trial?.samples).toEqual([]);
    const item = await get<{ trial: { results: unknown } }>(`/app-api/item?key=${encodeURIComponent(key)}`);
    expect(item.status).toBe(200);
    expect(item.json.trial.results).toBeNull();
  });

  it("a Trial Reel's copy: its own samples, and its own 24 h results", async () => {
    const { key } = await seedReel(w, { account: "demo_running" });
    await posted(key, "m-1", T0, "demo_running");
    await env.DB.prepare(
      "INSERT INTO trial_posts (item_key, account, media_id, published_at) VALUES (?1, 'demo_running', 'm-t', ?2)",
    )
      .bind(key, s(at(1)))
      .run();
    await put(key, at(24), 300);
    await put(`trial:${key}`, at(25), 90);
    const r = await metricsOf(key);
    expect(r.json.samples.map((p) => p.views)).toEqual([300]);
    expect(r.json.trial?.samples.map((p) => [p.at, p.views])).toEqual([[s(at(25)), 90]]);
    const item = (
      await get<{ results: { views: number }; trial: { results: { views: number; fetched_at: number } } }>(
        `/app-api/item?key=${encodeURIComponent(key)}`,
      )
    ).json;
    expect(item.results.views).toBe(300);
    expect(item.trial.results).toMatchObject({ views: 90, fetched_at: s(at(25)) });
  });

  it("the 24 h notification opens the Reel's Results, the Trial Reel's too", async () => {
    const { key } = await seedReel(w, { account: "demo_running" });
    await posted(key, "m-1", at(-25), "demo_running");
    const url = `/#/item/${encodeURIComponent(key)}/results`;
    expect((await postResults(e, { fetch: w.fetch, now: T0 })).fetched).toEqual([key]);
    expect(w.notifications.at(-1)!.actions).toContain(`Open results, https://scheduler.test${url}`);
    await env.DB.prepare(
      "INSERT INTO trial_posts (item_key, account, media_id, published_at) VALUES (?1, 'demo_running', 'm-t', ?2)",
    )
      .bind(key, s(at(-25)))
      .run();
    expect((await postResults(e, { fetch: w.fetch, now: T0 })).fetched).toEqual([`trial:${key}`]);
    expect(w.notifications.at(-1)!.title).toBe("24 h results");
    expect(w.notifications.at(-1)!.actions).toContain(`Open results, https://scheduler.test${url}`);
  });

  it("a YouTube upload's samples, 404 for a video no channel of the workspace has", async () => {
    w.ytUploads = [
      { id: "vidA00000001", title: "A", privacy: "public", publishedAt: at(-2).toISOString(), duration: "PT30S" },
    ];
    await env.DB.prepare(
      "INSERT INTO post_metrics (item_key, account, platform, media_id, taken_at, views, likes) VALUES ('video:vidA00000001', 'main', 'youtube', 'vidA00000001', ?1, 40, 4)",
    )
      .bind(s(T0))
      .run();
    const r = await get<Metrics>("/app-api/video/metrics?video=vidA00000001");
    expect(r.status).toBe(200);
    expect(r.json.item).toMatchObject({
      key: "video:vidA00000001",
      platform: "youtube",
      account: "main",
      label: "Short",
      published_at: utcIso(s(at(-2))),
    });
    expect(r.json.samples.map((p) => [p.at, p.views, p.likes])).toEqual([[s(T0), 40, 4]]);
    expect(r.json.analytics).toBe(true);
    expect((await get("/app-api/video/metrics?video=vidZ00000009")).status).toBe(404);
    // a channel connected before the analytics scope was asked for: the app says why subscribers are missing
    const old = {
      client_id: "c",
      client_secret: "s",
      refresh_token: "r",
      token_uri: "https://oauth2.googleapis.com/token",
    };
    for (const k of ["YT_MAIN_OAUTH", "YT_VLOGS_OAUTH"])
      (e as unknown as Record<string, unknown>)[k] = JSON.stringify(old);
    expect((await get<Metrics>("/app-api/video/metrics?video=vidA00000001")).json.analytics).toBe(false);
  });
});
