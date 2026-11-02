import { env } from "cloudflare:workers";
import { resolveItem } from "@bongsu/api/pwa/approve";
import { pollComments, replyToComment } from "@bongsu/core/comments";
import { postResults } from "@bongsu/core/results";
import { beforeEach, describe, expect, it } from "vitest";
import { clearPlan, MD5, planItem, seedReel, testEnv, World } from "./world";

const NOW = new Date("2026-10-26T03:00:00Z");
const nowS = Math.floor(NOW.getTime() / 1000);

let w: World;
beforeEach(async () => {
  await env.DB.batch(
    [
      "DELETE FROM post_results",
      "DELETE FROM post_metrics",
      "DELETE FROM comments",
      "DELETE FROM comment_polls",
      "DELETE FROM audit",
    ].map((s) => env.DB.prepare(s)),
  );
  await clearPlan();
  w = new World();
});

const posted = (key: string, mediaId: string, agoS: number, account = "demo_travel") =>
  env.DB.prepare(
    "INSERT INTO posted (item_key, account, media_id, source, published_at) VALUES (?1, ?2, ?3, 'scheduler', ?4)",
  )
    .bind(key, account, mediaId, nowS - agoS)
    .run();

describe("24 h results", () => {
  it("fetches a post's insights a day later, compares with the account's median, notifies once", async () => {
    const key = await planItem({ folder: "vlogs/CONTENT/20260823_LISBON", name: "short5_lisbon_food" });
    await posted(key, "m-1", 25 * 3600);
    await posted("reel:X/too_new", "m-2", 3600); // not a day old yet
    for (const [k, v] of [
      ["reel:A/a", 800],
      ["reel:A/b", 1000],
      ["reel:A/c", 1200],
    ] as const) {
      // earlier posts: published 5 days ago, their 24 h sample and result marker
      await posted(k, "x", 5 * 86400);
      await env.DB.prepare(
        "INSERT INTO post_metrics (item_key, account, platform, media_id, taken_at, views) VALUES (?1, 'demo_travel', 'instagram', 'x', ?2, ?3)",
      )
        .bind(k, nowS - 4 * 86400, v)
        .run();
      await env.DB.prepare(
        "INSERT INTO post_results (item_key, account, media_id, median_views, fetched_at) VALUES (?1, 'demo_travel', 'x', NULL, 1)",
      )
        .bind(k)
        .run();
    }
    // another account's earlier result, far off: it must stay out of demo_travel's median
    await posted("reel:R/a", "y", 5 * 86400, "demo_running");
    await env.DB.prepare(
      "INSERT INTO post_metrics (item_key, account, platform, media_id, taken_at, views) VALUES ('reel:R/a', 'demo_running', 'instagram', 'y', ?1, 90000)",
    )
      .bind(nowS - 4 * 86400)
      .run();
    await env.DB.prepare(
      "INSERT INTO post_results (item_key, account, media_id, median_views, fetched_at) VALUES ('reel:R/a', 'demo_running', 'y', NULL, 1)",
    ).run();
    w.composio.INSTAGRAM_GET_IG_MEDIA_INSIGHTS = (a) => ({
      data: [
        ["views", 1500],
        ["reach", 900],
        ["likes", 40],
        ["comments", 3],
        ["saved", 5],
        ["shares", 2],
        ["follows", 12],
        ["profile_visits", 85],
      ].map(([name, value]) => ({ name, values: [{ value }] })),
      _asked: a.ig_media_id,
    });
    expect(await postResults(await testEnv(env), { fetch: w.fetch, now: NOW })).toEqual({ fetched: [key] });
    expect(
      await env.DB.prepare("SELECT account, media_id, median_views FROM post_results WHERE item_key = ?1")
        .bind(key)
        .first(),
    ).toEqual({ account: "demo_travel", media_id: "m-1", median_views: 1000 });
    expect(
      await env.DB.prepare(
        "SELECT views, reach, likes, comments, saves, shares, workspace_id FROM post_metrics WHERE item_key = ?1",
      )
        .bind(key)
        .all(),
    ).toMatchObject({
      results: [{ views: 1500, reach: 900, likes: 40, comments: 3, saves: 5, shares: 2, workspace_id: "default" }],
    });
    expect(w.notifications.at(-1)).toMatchObject({ title: "24 h results" });
    expect(w.notifications.at(-1)!.body).toContain(
      "Lisbon food @demo_travel: 1500 views (1.5× usual), 40 likes, 3 comments, 5 saves · +12 followers · 85 profile visits",
    );
    expect((await postResults(await testEnv(env), { fetch: w.fetch, now: NOW })).fetched).toEqual([]);
  });
});

describe("the comments inbox", () => {
  it("polls Instagram posts and YouTube Shorts, keeps ours quiet, notifies others' once; replies go out", async () => {
    const key = await planItem({ folder: "vlogs/CONTENT/20260823_LISBON", name: "short5_lisbon_food" });
    await posted(key, "m-1", 2 * 86400);
    await posted("reel:OLD/x", "m-old", 20 * 86400); // past the 14 days: not polled
    await env.DB.prepare(
      "INSERT INTO shorts_commented (video_id, channel, date_pt, source, at) VALUES ('vid1', 'vlogs', '2026-10-24', 'scheduler', ?1)",
    )
      .bind(nowS - 86400)
      .run();
    w.composio.INSTAGRAM_GET_IG_MEDIA_COMMENTS = () => ({
      data: [
        { id: "c1", text: "📍 our self-comment", username: "demo_travel", timestamp: "2026-10-24T09:10:00+0000" },
        {
          id: "c2",
          text: "Looks delicious! Where is this?",
          username: "foodie",
          timestamp: "2026-10-25T01:00:00+0000",
        },
      ],
    });
    w.ytThreads.set("vid1", [
      { id: "y1", author: "Demo Vlogs", channel: "UCours", text: "ours", at: "2026-10-25T00:00:00Z" },
      { id: "y2", author: "Viewer", channel: "UCother", text: "Great video", at: "2026-10-25T02:00:00Z" },
    ]);
    const e = await testEnv(env);
    expect(await pollComments(e, { fetch: w.fetch, now: NOW })).toEqual({ checked: 2, fresh: 2 });
    expect(w.notifications.at(-1)).toMatchObject({ title: "2 new comments" });
    const rows = (await env.DB.prepare("SELECT id, own, seen, item_key FROM comments ORDER BY id").all()).results;
    expect(rows).toEqual([
      { id: "ig:c1", own: 1, seen: 1, item_key: key },
      { id: "ig:c2", own: 0, seen: 0, item_key: key },
      { id: "yt:y1", own: 1, seen: 1, item_key: "comment:vid1" },
      { id: "yt:y2", own: 0, seen: 0, item_key: "comment:vid1" },
    ]);
    const n = w.notifications.length;
    expect((await pollComments(e, { fetch: w.fetch, now: new Date(NOW.getTime() + 900_000) })).fresh).toBe(0); // nothing new
    expect(w.notifications.length).toBe(n);

    w.composio.INSTAGRAM_POST_IG_COMMENT_REPLIES = () => ({ id: "reply-1" });
    await replyToComment(e, w.fetch, "ig:c2", "In Lisbon, near Jungmun!", nowS, "default");
    expect(w.calls.find((c) => c.slug === "INSTAGRAM_POST_IG_COMMENT_REPLIES")).toMatchObject({
      args: { ig_comment_id: "c2", message: "In Lisbon, near Jungmun!" },
      account: "instagram_conn-a",
    });
    await replyToComment(e, w.fetch, "yt:y2", "Thanks!", nowS, "default");
    expect(w.ytReplies).toEqual([{ parent: "y2", text: "Thanks!" }]);
    expect(await env.DB.prepare("SELECT reply_text, seen FROM comments WHERE id = 'ig:c2'").first()).toEqual({
      reply_text: "In Lisbon, near Jungmun!",
      seen: 1,
    });
  });
});

describe("the caption check in the app", () => {
  it("blocks approval on a lint FAIL and lists the warnings", async () => {
    const { key, folder, base } = await seedReel(w, {
      approve: false,
      caption: "A day on Lisbon\n\n#a #b #c #d #e #f",
    });
    w.drivePut(`UPLOADS/${folder}/exports/shorts/instagram/${base}.mp4`, { md5: MD5, mimeType: "video/mp4" });
    const r = (await resolveItem(await testEnv(env), w.fetch, key, "Asia/Seoul", "default"))!;
    expect(r.problems).toContain("caption hashtags: 6 tags, over Instagram's cap of 5");
    expect(r.lint.map((c) => c.check)).toContain("ONE ASK");
  });
});
