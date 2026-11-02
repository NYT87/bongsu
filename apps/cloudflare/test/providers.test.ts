// Instagram providers (Phase 4): the same tick through instagram-graph (Instagram's own API, the account's token)
// as through Composio, Trial Reels without the workbench, comments and results, and the weekly token renewal.
import { env } from "cloudflare:workers";
import { findAccount } from "@bongsu/core/accounts";
import { pollComments, replyToComment } from "@bongsu/core/comments";
import { decryptSecret } from "@bongsu/core/crypto";
import { mailer } from "@bongsu/core/mail";
import { instagramFor } from "@bongsu/core/providers/instagram";
import { RENEW_EVERY_S, refreshConnections } from "@bongsu/core/providers/refresh";
import { postResults } from "@bongsu/core/results";
import { tick } from "@bongsu/core/tick";
import { beforeEach, describe, expect, it } from "vitest";
import { clearPlan, connectGraph, postedRows, seedReel, testEnv, World } from "./world";

const AT = new Date("2026-10-20T09:32:00Z"); // 18:32 in Seoul
const later = (min: number) => new Date(AT.getTime() + min * 60_000);
const jobs = async () =>
  (
    await env.DB.prepare("SELECT item_key, state, container_id, last_error FROM jobs ORDER BY id").all<{
      item_key: string;
      state: string;
      container_id: string | null;
      last_error: string | null;
    }>()
  ).results;
let w: World;

beforeEach(async () => {
  await env.DB.batch(
    [
      "DELETE FROM jobs",
      "DELETE FROM audit",
      "DELETE FROM locks",
      "DELETE FROM trial_posts",
      "DELETE FROM comments",
    ].map((s) => env.DB.prepare(s)),
  );
  await clearPlan();
  w = new World();
});

describe("instagram-graph", () => {
  it("publishes a Reel with the account's own token: container → publish → comments → posted, no Composio", async () => {
    const e = await testEnv(env);
    await connectGraph();
    const { driveId, key } = await seedReel(w, { account: "demo_cycling", comment2: "Music: a song" });
    w.graphStates = ["IN_PROGRESS", "FINISHED"];
    for (let i = 0; i < 5; i++) await tick(e, { fetch: w.fetch, now: later(i * 5) });

    expect(w.calls).toEqual([]); // nothing through Composio
    const create = w.graph.find((g) => g.path === "/17841400000000003/media")!;
    expect(create.token).toBe("ig-token-1");
    expect(create.params).toMatchObject({
      media_type: "REELS",
      caption: "A caption\n\nWhere next?\n\n#travel",
      share_to_feed: true,
      thumb_offset: 500,
      location_id: "111",
    });
    expect(create.params).not.toHaveProperty("ig_user_id"); // it's in the path
    expect(String(create.params.video_url)).toMatch(new RegExp(`/m/${driveId}\\.mp4\\?exp=\\d+&sig=`));
    expect(w.graph.find((g) => g.path === "/17841400000000003/media_publish")?.params).toEqual({
      creation_id: "gcontainer-1",
    });
    expect(w.graph.filter((g) => g.path === "/gmedia-1/comments").map((g) => g.params.message)).toEqual([
      "📍 Somewhere. Have you been?",
      "Music: a song",
    ]);
    expect((await jobs())[0]).toMatchObject({ item_key: key, state: "done" });
    expect(await postedRows()).toMatchObject([
      { item_key: key, account: "demo_cycling", media_id: "gmedia-1", source: "scheduler" },
    ]);
  });

  it("posts a carousel: one item per media, then the parent with the children as a list", async () => {
    const e = await testEnv(env);
    await connectGraph();
    const { key } = await seedReel(w, { account: "demo_cycling" }); // a Reel, then turned into a two-image post
    await env.DB.prepare("UPDATE plan_items SET format = NULL WHERE item_key = ?1").bind(key).run();
    await env.DB.prepare("UPDATE plan_items SET item_key = 'post:20260823_LISBON/short1_x' WHERE item_key = ?1")
      .bind(key)
      .run();
    w.drive.set("img_aaaaaaaaaa", { md5: "a".repeat(32), mimeType: "image/jpeg" });
    w.drive.set("img_bbbbbbbbbb", { md5: "b".repeat(32), mimeType: "image/jpeg" });
    await env.DB.prepare("UPDATE approvals SET item_key = 'post:20260823_LISBON/short1_x', media = ?1")
      .bind(
        JSON.stringify([
          { store: "drive", id: "img_aaaaaaaaaa", checksum: "a".repeat(32) },
          { store: "drive", id: "img_bbbbbbbbbb", checksum: "b".repeat(32) },
        ]),
      )
      .run();
    await env.DB.prepare(
      "UPDATE plan_items SET caption = 'A caption' WHERE item_key = 'post:20260823_LISBON/short1_x'",
    ).run();
    await env.DB.prepare("UPDATE approvals SET caption_sha = ?1")
      .bind(await (await import("@bongsu/core/formats/approved")).sha256Hex("A caption"))
      .run();
    for (let i = 0; i < 4; i++) await tick(e, { fetch: w.fetch, now: later(i * 5) });
    const creates = w.graph.filter((g) => g.path === "/17841400000000003/media").map((g) => g.params);
    expect(creates.slice(0, 2).every((p) => p.is_carousel_item === true && p.image_url)).toBe(true);
    expect(creates[2]).toMatchObject({ media_type: "CAROUSEL", children: "gcontainer-1,gcontainer-2" });
    expect((await jobs())[0].state).toBe("done");
  });

  it("drops a location Instagram refuses instead of losing the post", async () => {
    const e = await testEnv(env);
    await connectGraph();
    await seedReel(w, { account: "demo_cycling" });
    w.graphRefuse = (_m, path, p) => (path.endsWith("/media") && p.location_id ? "Invalid location" : null);
    await tick(e, { fetch: w.fetch, now: AT });
    const creates = w.graph.filter((g) => g.path === "/17841400000000003/media");
    expect(creates.map((g) => g.params.location_id ?? null)).toEqual(["111", null]);
    expect((await jobs())[0].state).toBe("container_created");
  });

  it("a Trial Reel copy goes out with trial_params in the plain call, for any account (no workbench)", async () => {
    const e = await testEnv(env);
    await connectGraph();
    await env.DB.prepare("UPDATE accounts SET capabilities = '{\"trialReels\":true}' WHERE id = 'demo_cycling'").run();
    await seedReel(w, { account: "demo_cycling" });
    for (let i = 0; i < 8; i++) await tick(e, { fetch: w.fetch, now: later(i * 5) });
    const trial = w.graph.filter((g) => g.path === "/17841400000000003/media" && g.params.trial_params);
    expect(trial).toHaveLength(1);
    expect(trial[0].params).toMatchObject({
      media_type: "REELS",
      trial_params: { graduation_strategy: "SS_PERFORMANCE" },
    });
    expect(w.raw).toEqual([]); // Composio's workbench isn't involved
    expect(await env.DB.prepare("SELECT media_id FROM trial_posts").first("media_id")).toBe("gmedia-1");
  });

  it("an unusable token refuses the post and says what Instagram said", async () => {
    const e = await testEnv(env, { IG_TOKEN_DEMO: "expired-token" });
    await connectGraph();
    await seedReel(w, { account: "demo_cycling" });
    await tick(e, { fetch: w.fetch, now: AT });
    // the call fails, so the job stays pending with the error until it gives up (the usual retries)
    expect(JSON.stringify(await jobs())).toMatch(/Invalid OAuth access token/);
  });

  it("reads new comments, replies and fetches the 24 h results with the token", async () => {
    const e = await testEnv(env);
    await connectGraph();
    await env.DB.prepare(
      "INSERT INTO posted (item_key, account, media_id, source, published_at, at) VALUES ('reel:P/a', 'demo_cycling', 'gmedia-9', 'scheduler', ?1, ?1)",
    )
      .bind(Math.floor(AT.getTime() / 1000) - 25 * 3600)
      .run();
    w.graphComments.set("gmedia-9", [
      { id: "c1", text: "Where is this?", username: "someone", timestamp: "2026-10-20T08:00:00+0000" },
    ]);
    expect(await pollComments(e, { fetch: w.fetch, now: AT })).toMatchObject({ fresh: 1 });
    await replyToComment(e, w.fetch, "ig:c1", "Lisbon!", 1, "default");
    expect(w.graph.find((g) => g.path === "/c1/replies")?.params).toEqual({ message: "Lisbon!" });
    expect((await postResults(e, { fetch: w.fetch, now: AT })).fetched).toEqual(["reel:P/a"]);
    expect(w.graph.find((g) => g.path === "/gmedia-9/insights")?.params.metric).toBe(
      "views,reach,likes,comments,saved,shares,follows,profile_visits",
    );
    expect(
      await env.DB.prepare(
        "SELECT views, reach, likes, comments, saves, shares, platform, workspace_id FROM post_metrics WHERE item_key = 'reel:P/a'",
      ).all(),
    ).toMatchObject({
      results: [
        {
          views: 10,
          reach: 20,
          likes: 30,
          comments: 40,
          saves: 50,
          shares: 60,
          platform: "instagram",
          workspace_id: "default",
        },
      ],
    });
    expect(await env.DB.prepare("SELECT media_id FROM post_results WHERE item_key = 'reel:P/a'").first()).toEqual({
      media_id: "gmedia-9",
    });
  });

  it("verify says who the token posts as", async () => {
    const e = await testEnv(env);
    await connectGraph();
    const a = await findAccount(env.DB, "demo_cycling", "default", "instagram");
    const ig = await instagramFor(e, w.fetch, a!);
    expect(ig?.id).toBe("instagram-graph");
    expect(await ig!.verify()).toEqual({ id: "17841400000000003", username: "demo_cycling", followers: 1200 });
  });
});

/** Only the Instagram connection's outcome (the YouTube channels are checked in the same runs). */
const ig = (r: { renewed: string[]; failed: string[] }) => ({
  renewed: r.renewed.filter((id) => id.startsWith("g_")),
  failed: r.failed.filter((id) => id.startsWith("g_")),
});

describe("renewing Instagram tokens", () => {
  const conn = () =>
    env.DB.prepare(
      "SELECT credentials, expires_at, status, last_error, last_checked_at FROM connections WHERE id = 'g_demo_cycling'",
    ).first<{
      credentials: string | null;
      expires_at: number | null;
      status: string;
      last_error: string | null;
      last_checked_at: number | null;
    }>();

  it("renews weekly, stores the new token encrypted, and the next post uses it", async () => {
    const e = await testEnv(env);
    await connectGraph();
    const now = Math.floor(AT.getTime() / 1000);
    expect(ig(await refreshConnections(e, { fetch: w.fetch, now: AT }))).toEqual({
      renewed: ["g_demo_cycling"],
      failed: [],
    });
    const c = await conn();
    expect(c).toMatchObject({ status: "ok", expires_at: now + 5184000, last_checked_at: now });
    expect(c!.credentials).toMatch(/^v1:/); // never stored in the clear
    expect(JSON.parse(await decryptSecret(e.ENCRYPTION_KEY, c!.credentials!))).toEqual({
      access_token: "ig-token-2",
      expires_at: now + 5184000,
    });
    // not again within the week
    expect(ig(await refreshConnections(e, { fetch: w.fetch, now: later(60) })).renewed).toEqual([]);
    expect(
      ig(await refreshConnections(e, { fetch: w.fetch, now: new Date(AT.getTime() + (RENEW_EVERY_S + 60) * 1000) }))
        .renewed,
    ).toEqual(["g_demo_cycling"]);
    // the post goes out with the newest token, though the secret still holds the first one
    const a = await findAccount(env.DB, "demo_cycling", "default", "instagram");
    await (await instagramFor(e, w.fetch, a!))!.verify();
    expect(w.graph.at(-1)?.token).toBe("ig-token-3");
  });

  it("a refused renewal marks the connection expiring and notifies once; past its expiry, broken", async () => {
    const e = await testEnv(env);
    await connectGraph();
    w.graphTokens.delete("ig-token-1");
    await refreshConnections(e, { fetch: w.fetch, now: AT });
    expect(await conn()).toMatchObject({ status: "expiring", last_error: expect.stringMatching(/Invalid OAuth/) });
    expect(w.notifications.map((n) => n.title)).toEqual(["A connection needs attention"]);
    await refreshConnections(e, { fetch: w.fetch, now: new Date(AT.getTime() + (RENEW_EVERY_S + 60) * 1000) });
    expect(w.notifications).toHaveLength(1); // still expiring: no second notice
    await env.DB.prepare("UPDATE connections SET expires_at = 1 WHERE id = 'g_demo_cycling'").run();
    await refreshConnections(e, { fetch: w.fetch, now: new Date(AT.getTime() + 2 * (RENEW_EVERY_S + 60) * 1000) });
    expect((await conn())?.status).toBe("broken");
    expect(w.notifications).toHaveLength(2);
    // a broken connection posts nothing
    const a = await findAccount(env.DB, "demo_cycling", "default", "instagram");
    expect(await instagramFor(e, w.fetch, a!)).toBeNull();
  });

  it("with a Mailer set, the alert is also emailed to the workspace's owners and admins", async () => {
    const e = await testEnv(env, {
      MAILER: "resend",
      MAIL_FROM: "Bongsu <bongsu@example.com>",
      RESEND_API_KEY: "re_test",
    });
    await env.DB.prepare("UPDATE users SET email = 'owner@example.com' WHERE id = 'owner'").run();
    await connectGraph();
    w.graphTokens.delete("ig-token-1");
    await refreshConnections(e, { fetch: w.fetch, now: AT });
    expect(w.notifications).toHaveLength(1); // the usual notice still goes
    expect(w.mails).toEqual([
      expect.objectContaining({
        from: "Bongsu <bongsu@example.com>",
        to: ["owner@example.com"],
        subject: "Bongsu: a connection needs attention",
        text: expect.stringMatching(/Invalid OAuth[\s\S]*\/dashboard\/connections$/),
      }),
    ]);
    await env.DB.prepare("UPDATE users SET email = NULL WHERE id = 'owner'").run();
  });

  it("the Mailer: none unless MAILER is set; a misconfigured one says what's missing", async () => {
    expect(mailer({}, w.fetch).id).toBe("none");
    await mailer({}, w.fetch).send({ to: ["x@example.com"], subject: "s", text: "t" }); // a no-op
    expect(w.mails).toEqual([]);
    expect(() => mailer({ MAILER: "smtp" }, w.fetch)).toThrow(/unknown MAILER smtp/);
    expect(() => mailer({ MAILER: "resend" }, w.fetch)).toThrow(/MAIL_FROM and RESEND_API_KEY/);
    await expect(
      mailer({ MAILER: "resend", MAIL_FROM: "a@example.com", RESEND_API_KEY: "wrong" }, w.fetch).send({
        to: ["x@example.com"],
        subject: "s",
        text: "t",
      }),
    ).rejects.toThrow(/resend: 401/);
  });

  it("without ENCRYPTION_KEY it can't keep a renewed token, so it doesn't renew and says why", async () => {
    const e = await testEnv(env, { ENCRYPTION_KEY: undefined });
    await connectGraph();
    expect(ig(await refreshConnections(e, { fetch: w.fetch, now: AT })).failed).toEqual(["g_demo_cycling"]);
    expect((await conn())?.last_error).toMatch(/ENCRYPTION_KEY/);
    expect(w.graph).toEqual([]); // the token wasn't spent
  });
});

describe("Composio stays as it was", () => {
  it("demo_travel (Composio) and demo_cycling (graph) post in the same run, each its own way", async () => {
    const e = await testEnv(env);
    await connectGraph();
    const { igHappyPath } = await import("./world");
    igHappyPath(w);
    await seedReel(w, { account: "demo_cycling", base: "short1_g" });
    await seedReel(w, { account: "demo_travel", base: "short2_c", date: "2026-10-20", time: "18:00" });
    await tick(e, { fetch: w.fetch, now: AT });
    expect(w.calls.filter((c) => c.slug === "INSTAGRAM_POST_IG_USER_MEDIA")).toHaveLength(1);
    expect(w.calls[0].account).toBe("instagram_conn-a");
    expect(w.graph.filter((g) => g.path.endsWith("/media"))).toHaveLength(1);
  });
});

describe("jobs queued before the provider interface", () => {
  it("a container queued by the old tick (no saved step) is checked and published as before", async () => {
    const e = await testEnv(env);
    const { igHappyPath } = await import("./world");
    igHappyPath(w);
    const { key } = await seedReel(w); // demo_travel, through Composio
    await tick(e, { fetch: w.fetch, now: AT });
    // what the old tick left behind: the container id on the job, no payload.step
    await env.DB.prepare("UPDATE jobs SET payload = json_remove(payload, '$.step') WHERE item_key = ?1")
      .bind(key)
      .run();
    await tick(e, { fetch: w.fetch, now: later(5) });
    await tick(e, { fetch: w.fetch, now: later(10) });
    expect((await jobs())[0]).toMatchObject({ item_key: key, state: "done" });
    expect(w.calls.filter((c) => c.slug === "INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH")).toHaveLength(1);
  });
});

describe("checking YouTube grants", () => {
  const ytConn = () =>
    env.DB.prepare("SELECT status, last_error, last_checked_at FROM connections WHERE id = 'c_main'").first<{
      status: string;
      last_error: string | null;
      last_checked_at: number | null;
    }>();

  it("a working refresh token keeps the channel ok; a revoked one turns it broken, notified once", async () => {
    const e = await testEnv(env);
    await env.DB.prepare(
      "UPDATE connections SET status = 'ok', last_checked_at = NULL, last_error = NULL WHERE provider = 'youtube'",
    ).run();
    expect((await refreshConnections(e, { fetch: w.fetch, now: AT })).renewed).toEqual(
      expect.arrayContaining(["c_main", "c_vlogs"]),
    );
    expect(await ytConn()).toMatchObject({ status: "ok", last_checked_at: Math.floor(AT.getTime() / 1000) });

    w.googleRefuse = true; // the owner revoked the app's access, or a testing-mode token expired
    const week = new Date(AT.getTime() + (RENEW_EVERY_S + 60) * 1000);
    expect((await refreshConnections(e, { fetch: w.fetch, now: week })).failed).toEqual(
      expect.arrayContaining(["c_main", "c_vlogs"]),
    );
    expect(await ytConn()).toMatchObject({ status: "broken", last_error: expect.stringMatching(/invalid_grant/) });
    expect(w.notifications.map((n) => n.title)).toEqual(["A connection needs attention"]);
    // a broken connection is left alone (and comments nothing) until it's reconnected
    expect(
      (await refreshConnections(e, { fetch: w.fetch, now: new Date(week.getTime() + RENEW_EVERY_S * 1000) })).failed,
    ).toEqual([]);
  });
});
