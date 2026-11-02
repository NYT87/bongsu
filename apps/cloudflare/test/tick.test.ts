import { env } from "cloudflare:workers";
import { serveMedia, signedLink } from "@bongsu/core/media";
import { mediaStoreCases } from "@bongsu/core/media/conformance";
import { clearFolderCache, DriveStore } from "@bongsu/core/media/drive";
import { tick } from "@bongsu/core/tick";
import { beforeEach, describe, expect, it } from "vitest";
import {
  approve,
  approveShort,
  clearPlan,
  copyText,
  igHappyPath,
  MD5,
  planItem,
  postedRows,
  seedReel,
  testEnv,
  World,
} from "./world";

const AT = new Date("2026-10-20T09:32:00Z"); // 18:32 KST
const later = (min: number) => new Date(AT.getTime() + min * 60_000);
const KEY = "reel:20260823_LISBON/short1_x";

interface Job {
  item_key: string;
  kind: string;
  state: string;
  last_error: string | null;
  dry_run: number;
  container_id: string | null;
  attempts: number;
  payload: string;
}
const jobs = async () => (await env.DB.prepare("SELECT * FROM jobs ORDER BY id").all<Job>()).results;
const audits = async (action: string) =>
  (await env.DB.prepare("SELECT * FROM audit WHERE action = ?1").bind(action).all()).results;

let w: World;
beforeEach(async () => {
  await env.DB.batch(["DELETE FROM jobs", "DELETE FROM audit", "DELETE FROM locks"].map((s) => env.DB.prepare(s)));
  await clearPlan();
  w = new World();
});

describe("tick: guards", () => {
  it("does nothing while paused", async () => {
    await seedReel(w);
    await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('paused', '{}')").run();
    expect((await tick(await testEnv(env), { fetch: w.fetch, now: AT })).status).toBe("paused");
    expect(await jobs()).toEqual([]);
  });

  it("skips a tick while another holds the lock", async () => {
    await env.DB.prepare("INSERT INTO locks VALUES ('tick:instagram', 'other', ?1)")
      .bind(Math.floor(AT.getTime() / 1000) + 100)
      .run();
    expect((await tick(await testEnv(env), { fetch: w.fetch, now: AT })).status).toBe("locked");
  });

  it("ignores items not due yet, on hold, or unscheduled", async () => {
    await seedReel(w, { time: "19:00" });
    await planItem({ folder: "vlogs/CONTENT/20260823_LISBON", name: "short2_hold", hold: true });
    await planItem({ folder: "vlogs/CONTENT/20260823_LISBON", name: "short3_nodate", date: null });
    await tick(await testEnv(env), { fetch: w.fetch, now: AT });
    expect(await jobs()).toEqual([]);
  });
});

describe("tick: approval", () => {
  it("refuses a due item that isn't approved, and notifies once", async () => {
    await seedReel(w, { approve: false });
    const e = await testEnv(env);
    await tick(e, { fetch: w.fetch, now: AT });
    await tick(e, { fetch: w.fetch, now: later(5) });
    const [j] = await jobs();
    expect([j.state, j.last_error]).toEqual(["refused", "not approved"]);
    expect(w.notifications.map((n) => n.title)).toEqual([`${KEY}: refused`]);
    expect(w.calls).toEqual([]);
  });

  it("refuses when the caption changed after approval", async () => {
    const { folder, base } = await seedReel(w);
    await copyText(`channels/${folder}/shorts/instagram/${base}.txt`, "An edited caption");
    await tick(await testEnv(env), { fetch: w.fetch, now: AT });
    const [j] = await jobs();
    expect([j.state, j.last_error]).toEqual(["refused", "the caption changed after approval"]);
    expect(w.calls).toEqual([]);
  });

  it("refuses when the Drive file changed after approval", async () => {
    const { driveId } = await seedReel(w);
    w.drive.get(driveId)!.md5 = "ffffffffffffffffffffffffffffffff";
    await tick(await testEnv(env), { fetch: w.fetch, now: AT });
    expect((await jobs())[0].last_error).toBe(`media file ${driveId} changed after approval`);
  });

  it("refuses when the schedule moved after approval, then reopens on a new approval", async () => {
    const { driveId } = await seedReel(w, { time: "18:15", approve: false });
    const media = [{ driveId, md5: MD5 }],
      caption = "A caption\n\nWhere next?\n\n#travel",
      comment = "📍 Somewhere. Have you been?";
    await approve(KEY, { due: "2026-10-20 18:00", caption, comment, media });
    const e = await testEnv(env);
    await tick(e, { fetch: w.fetch, now: AT });
    expect((await jobs())[0].last_error).toBe("the schedule changed after approval: approve again");
    await approve(KEY, { due: "2026-10-20 18:15", caption, comment, media, approvedAt: "2026-10-18T00:00:00Z" });
    igHappyPath(w);
    await tick(e, { fetch: w.fetch, now: later(5) });
    expect((await jobs())[0].state).toBe("container_created");
  });

  it("holds an item missed by more than 6 h instead of posting it late", async () => {
    await seedReel(w, { date: "2026-10-19", time: "08:00" });
    await tick(await testEnv(env), { fetch: w.fetch, now: AT });
    expect((await jobs())[0].state).toBe("held");
  });
});

describe("tick: dry run", () => {
  it("checks everything, publishes nothing, and says what it would have done", async () => {
    await seedReel(w);
    await tick(await testEnv(env, { DRY_RUN: "1" }), { fetch: w.fetch, now: AT });
    const [j] = await jobs();
    expect([j.state, j.dry_run]).toEqual(["done", 1]);
    expect(w.calls).toEqual([]);
    expect(await postedRows()).toEqual([]);
    expect(await audits("would_publish")).toHaveLength(1);
    expect(w.notifications.map((n) => n.title)).toEqual([`dry run: would publish ${KEY}`]);
  });
});

describe("tick: publishing a Reel", () => {
  it("goes container → wait → publish → self-comment → posted (D1), one step per tick, and never commits", async () => {
    const { driveId } = await seedReel(w);
    igHappyPath(w, ["IN_PROGRESS", "FINISHED"]);
    const e = await testEnv(env);

    await tick(e, { fetch: w.fetch, now: AT });
    let [j] = await jobs();
    expect([j.state, j.container_id]).toEqual(["container_created", "container-1"]);
    const create = w.calls[0];
    expect(create.slug).toBe("INSTAGRAM_POST_IG_USER_MEDIA");
    expect(create.account).toBe("instagram_conn-a");
    expect(create.args).toMatchObject({
      ig_user_id: "17841400000000001",
      media_type: "REELS",
      caption: "A caption\n\nWhere next?\n\n#travel",
      share_to_feed: true,
      location_id: "111",
    });
    expect(String(create.args.video_url)).toMatch(
      new RegExp(`^https://scheduler\\.test/m/${driveId}\\.mp4\\?exp=\\d+&sig=[0-9a-f]{64}$`),
    );

    await tick(e, { fetch: w.fetch, now: later(5) }); // IN_PROGRESS
    expect((await jobs())[0]).toMatchObject({ state: "container_created", attempts: 1 });
    await tick(e, { fetch: w.fetch, now: later(10) }); // FINISHED → publish
    expect((await jobs())[0].state).toBe("published");
    await tick(e, { fetch: w.fetch, now: later(15) }); // self-comment + posted
    [j] = await jobs();
    expect(j.state).toBe("done");
    expect(w.calls.find((c) => c.slug === "INSTAGRAM_POST_IG_MEDIA_COMMENTS")?.args).toEqual({
      ig_media_id: "media-1",
      message: "📍 Somewhere. Have you been?",
    });
    expect(await postedRows()).toEqual([
      {
        item_key: KEY,
        account: "demo_travel",
        published_at: Date.UTC(2026, 9, 20, 9, 0, 7) / 1000, // Instagram's own timestamp, not the tick's
        media_id: "media-1",
        permalink: "https://www.instagram.com/reel/media-1/",
        source: "scheduler",
      },
    ]);
    // Instagram's own timestamp, not the tick that finished the job
    expect(await env.DB.prepare("SELECT published_at FROM posted").first("published_at")).toBe(
      Date.UTC(2026, 9, 20, 9, 0, 7) / 1000,
    );
    expect(w.notifications.at(-1)?.title).toBe(`published ${KEY}`);
    expect(w.notifications.at(-1)?.actions).toBe(
      "view, Open post, https://www.instagram.com/reel/media-1/, clear=true; " +
        `view, Open in app, https://scheduler.test/#/item/${encodeURIComponent(KEY)}, clear=true`,
    );
    expect(w.calls.every((c) => c.account === "instagram_conn-a")).toBe(true);
  });

  it("posts without the location when Instagram refuses it", async () => {
    await seedReel(w);
    igHappyPath(w);
    let n = 0;
    w.composio.INSTAGRAM_POST_IG_USER_MEDIA = (a) => {
      if (a.location_id) throw new Error("Invalid location");
      return { id: `container-${++n}` };
    };
    await tick(await testEnv(env), { fetch: w.fetch, now: AT });
    expect(
      w.calls.filter((c) => c.slug === "INSTAGRAM_POST_IG_USER_MEDIA").map((c) => "location_id" in c.args),
    ).toEqual([true, false]);
    expect((await jobs())[0].state).toBe("container_created");
  });

  it("publishes a second Reel the same day on the same account (one per hour is enforced when planning)", async () => {
    await seedReel(w);
    await env.DB.prepare(
      "INSERT INTO posted (item_key, account, published_at, source) VALUES ('reel:X/other', 'demo_travel', unixepoch('2026-10-20 09:00'), 'manual')",
    ).run();
    igHappyPath(w);
    await tick(await testEnv(env), { fetch: w.fetch, now: AT });
    expect((await jobs())[0]).toMatchObject({ state: "container_created" });
  });

  it("refuses a queued job whose item was moved, instead of publishing at the old time", async () => {
    await seedReel(w);
    igHappyPath(w);
    w.composio.INSTAGRAM_POST_IG_USER_MEDIA = () => {
      throw new Error("Instagram busy");
    }; // stays pending
    await tick(await testEnv(env), { fetch: w.fetch, now: AT });
    expect((await jobs())[0]).toMatchObject({ state: "pending" });
    await env.DB.prepare("UPDATE plan_items SET due_at = due_at + 4 * 86400 WHERE item_key = ?1").bind(KEY).run();
    igHappyPath(w);
    await tick(await testEnv(env), { fetch: w.fetch, now: new Date(AT.getTime() + 5 * 60_000) });
    expect((await jobs())[0]).toMatchObject({
      state: "refused",
      last_error: "rescheduled to 2026-10-24 18:00 Asia/Seoul: approve again for the new time",
    });
    expect(w.calls.filter((c) => c.slug === "INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH")).toEqual([]);
  });

  it("never picks up an item already posted (by hand)", async () => {
    await seedReel(w);
    await env.DB.prepare(
      "INSERT INTO posted (item_key, account, published_at, source) VALUES (?1, 'demo_travel', unixepoch('2026-10-19 09:00'), 'manual')",
    )
      .bind(KEY)
      .run();
    await tick(await testEnv(env), { fetch: w.fetch, now: AT });
    expect(await jobs()).toEqual([]);
  });

  it("keeps two Reels with the same base in different projects apart", async () => {
    await seedReel(w); // 20260823_LISBON/short1_x, approved
    const japan = await planItem({ folder: "vlogs/CONTENT/20260923_JAPAN", name: "short1_x" });
    await env.DB.prepare(
      "INSERT INTO posted (item_key, account, published_at, source) VALUES (?1, 'demo_travel', unixepoch('2026-10-19 09:00'), 'manual')",
    )
      .bind(japan)
      .run();
    igHappyPath(w);
    await tick(await testEnv(env), { fetch: w.fetch, now: AT });
    expect((await jobs()).map((j) => [j.item_key, j.state])).toEqual([[KEY, "container_created"]]);
  });
});

describe("tick: a failed job and a new approval (#148)", () => {
  const caption = "A caption\n\nWhere next?\n\n#travel",
    comment = "📍 Somewhere. Have you been?";
  const reapprove = (driveId: string, approvedAt: string) =>
    approve(KEY, { due: "2026-10-20 18:00", caption, comment, media: [{ driveId, md5: MD5 }], approvedAt });
  const slugs = (slug: string) => w.calls.filter((c) => c.slug === slug);

  it("reopens on an approval made after the failure, clean, and publishes once", async () => {
    const { driveId } = await seedReel(w);
    igHappyPath(w);
    w.composio.INSTAGRAM_POST_IG_USER_MEDIA = () => {
      throw new Error("Instagram busy");
    };
    const e = await testEnv(env);
    for (const m of [0, 5, 10]) await tick(e, { fetch: w.fetch, now: later(m) }); // three tries: failed at 09:42Z
    expect((await jobs())[0]).toMatchObject({
      state: "failed",
      attempts: 3,
      last_error: expect.stringContaining("Instagram busy"),
    });

    igHappyPath(w);
    w.calls.length = 0;
    await tick(e, { fetch: w.fetch, now: later(15) }); // no new approval: stays failed
    await reapprove(driveId, "2026-10-20T09:40:00Z"); // newer line, but older than the failure
    await tick(e, { fetch: w.fetch, now: later(20) });
    expect((await jobs())[0]).toMatchObject({ state: "failed", attempts: 3 });
    expect(slugs("INSTAGRAM_POST_IG_USER_MEDIA")).toEqual([]);

    await reapprove(driveId, "2026-10-20T09:55:00Z");
    await tick(e, { fetch: w.fetch, now: later(25) });
    expect((await jobs())[0]).toMatchObject({
      state: "container_created",
      attempts: 0,
      container_id: "container-1",
      last_error: null,
    });
    expect(JSON.parse((await jobs())[0].payload).approvedAt).toBe("2026-10-20T09:55:00Z");
    await tick(e, { fetch: w.fetch, now: later(30) }); // publish
    await tick(e, { fetch: w.fetch, now: later(35) }); // comment + posted
    expect((await jobs())[0].state).toBe("done");
    expect(slugs("INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH")).toHaveLength(1);
    expect(await postedRows()).toHaveLength(1);
  });

  it("drops the stale container of a job that never finished processing, and starts a new one", async () => {
    const { driveId } = await seedReel(w);
    igHappyPath(w, Array(30).fill("IN_PROGRESS"));
    const e = await testEnv(env);
    await tick(e, { fetch: w.fetch, now: AT }); // the container
    await env.DB.prepare("UPDATE jobs SET attempts = 24").run(); // 24 polls already (2 h), all IN_PROGRESS
    await tick(e, { fetch: w.fetch, now: later(120) });
    expect((await jobs())[0]).toMatchObject({ state: "failed", container_id: "container-1", attempts: 25 });

    igHappyPath(w);
    w.calls.length = 0;
    await reapprove(driveId, "2026-10-20T12:00:00Z");
    await tick(e, { fetch: w.fetch, now: later(150) });
    const [j] = await jobs();
    expect(j).toMatchObject({ state: "container_created", attempts: 0, container_id: "container-1" });
    expect(slugs("INSTAGRAM_POST_IG_USER_MEDIA")).toHaveLength(1); // a new container (the fake counts from 1 again)
    expect(JSON.parse(j.payload).step.data).not.toHaveProperty("status");
    await tick(e, { fetch: w.fetch, now: later(155) });
    expect((await jobs())[0].state).toBe("published");
  });

  it("never reopens a job whose publishing call was made: the post may be live", async () => {
    const { driveId } = await seedReel(w);
    igHappyPath(w);
    w.composio.INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH = () => {
      throw new Error("timed out");
    };
    const e = await testEnv(env);
    for (const m of [0, 5, 10, 15]) await tick(e, { fetch: w.fetch, now: later(m) }); // container, then 3 publishes
    expect((await jobs())[0]).toMatchObject({ state: "failed", last_error: expect.stringContaining("timed out") });
    expect(JSON.parse((await jobs())[0].payload).publishing).toBe(true);

    igHappyPath(w);
    w.calls.length = 0;
    await reapprove(driveId, "2026-10-20T10:00:00Z");
    await tick(e, { fetch: w.fetch, now: later(30) });
    expect((await jobs())[0].state).toBe("failed");
    expect(w.calls).toEqual([]);
  });
});

describe("tick: a carousel", () => {
  it("creates the items (alt text on images), then the parent once they're done, then publishes", async () => {
    const folder = "main/CONTENT/20260101_TRIP",
      dir = "posts/carousel2_bridges";
    const key = await planItem({ kind: "post", folder, name: dir, time: "18:30", location: "555" });
    const caption = "Bridges",
      alt = "01\tFirst bridge\n02\tSecond bridge";
    await copyText(`channels/${folder}/${dir}/caption.txt`, caption);
    await copyText(`channels/${folder}/${dir}/alt.txt`, alt + "\n");
    w.drive.set("img_aaaaaaaaaa", { md5: MD5, mimeType: "image/jpeg" });
    w.drive.set("vid_bbbbbbbbbb", { md5: MD5, mimeType: "video/mp4" });
    w.drive.set("img_cccccccccc", { md5: MD5, mimeType: "image/jpeg" });
    await approve(key, {
      due: "2026-10-20 18:30",
      caption,
      comment: null,
      alt,
      media: ["img_aaaaaaaaaa", "vid_bbbbbbbbbb", "img_cccccccccc"].map((driveId) => ({ driveId, md5: MD5 })),
    });
    igHappyPath(w);
    const e = await testEnv(env);
    await tick(e, { fetch: w.fetch, now: AT });
    const items = w.calls.filter((c) => c.slug === "INSTAGRAM_POST_IG_USER_MEDIA");
    expect(items.map((c) => [c.args.is_carousel_item, "video_url" in c.args, c.args.alt_text])).toEqual([
      [true, false, "First bridge"],
      [true, true, undefined],
      [true, false, "Second bridge"],
    ]);
    expect((await jobs())[0]).toMatchObject({ kind: "carousel", state: "container_created", container_id: null });
    await tick(e, { fetch: w.fetch, now: later(5) });
    expect(w.calls.filter((c) => c.slug === "INSTAGRAM_POST_IG_USER_MEDIA").at(-1)!.args).toMatchObject({
      media_type: "CAROUSEL",
      children: ["container-1", "container-2", "container-3"],
      caption,
      location_id: "555",
    });
    await tick(e, { fetch: w.fetch, now: later(10) });
    await tick(e, { fetch: w.fetch, now: later(15) });
    expect((await postedRows()).map((r) => r.item_key)).toEqual([key]);
    expect(w.calls.some((c) => c.slug === "INSTAGRAM_POST_IG_MEDIA_COMMENTS")).toBe(false);
  });
});

describe("tick: a single-media post", () => {
  const folder = "vlogs/CONTENT/20260823_LISBON";
  const one = async (dir: string, driveId: string, mimeType: string) => {
    const key = await planItem({ kind: "post", folder, name: dir, time: "18:30" });
    await copyText(`channels/${folder}/${dir}/caption.txt`, "Green Lisbon");
    w.drive.set(driveId, { md5: MD5, mimeType });
    await approve(key, {
      due: "2026-10-20 18:30",
      caption: "Green Lisbon",
      comment: null,
      media: [{ driveId, md5: MD5 }],
    });
    igHappyPath(w);
    await tick(await testEnv(env), { fetch: w.fetch, now: AT });
    return w.calls.find((c) => c.slug === "INSTAGRAM_POST_IG_USER_MEDIA")!.args;
  };

  it("posts a video as a Reel (the slideshow Reels)", async () => {
    const args = await one("posts/reel3_green", "vid_reel3green", "video/mp4");
    expect(args).toMatchObject({ media_type: "REELS", share_to_feed: true, caption: "Green Lisbon" });
    expect(String(args.video_url)).toMatch(/\/m\/vid_reel3green\.mp4\?/);
    expect("image_url" in args).toBe(false);
    expect((await jobs())[0]).toMatchObject({ kind: "image", state: "container_created" }); // planned as an image; its file makes it a video
  });

  it("still posts an image as a photo", async () => {
    const args = await one("posts/photo1", "img_photo1xx", "image/jpeg");
    expect("media_type" in args).toBe(false);
    expect(String(args.image_url)).toMatch(/\/m\/img_photo1xx\.jpg\?/);
  });
});

describe("tick: Shorts comments", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO shorts_comments (video_id, channel, file, label, sort) VALUES ('vidPUBLIC01', 'main', 'channels/main/c1.comment.txt', 'short1', 1)",
      ),
      env.DB.prepare(
        "INSERT INTO shorts_comments (video_id, channel, file, label, sort) VALUES ('vidPRIVATE2', 'main', 'channels/main/c2.comment.txt', 'short2', 2)",
      ),
    ]);
    await copyText("channels/main/c1.comment.txt", "Full video: https://youtu.be/x\n");
    await copyText("channels/main/c2.comment.txt", "Later\n");
    await approveShort("vidPUBLIC01", "Full video: https://youtu.be/x");
    await approveShort("vidPRIVATE2", "Later");
    w.ytPrivacy.set("vidPUBLIC01", "public").set("vidPRIVATE2", "private");
  });

  it("comments on public Shorts only, records it in D1, and never twice", async () => {
    const e = await testEnv(env);
    await tick(e, { fetch: w.fetch, now: AT }, "shorts");
    await tick(e, { fetch: w.fetch, now: later(30) }, "shorts");
    await tick(e, { fetch: w.fetch, now: later(35) }); // the Instagram part never comments
    expect(w.ytComments).toEqual([{ video: "vidPUBLIC01", text: "Full video: https://youtu.be/x" }]);
    expect(
      (await env.DB.prepare("SELECT video_id, channel, date_pt, thread_id, label, source FROM shorts_commented").all())
        .results,
    ).toEqual([
      {
        video_id: "vidPUBLIC01",
        channel: "main",
        date_pt: "2026-10-20",
        thread_id: "thread-1",
        label: "short1",
        source: "scheduler",
      },
    ]);
  });

  it("only says what it would do in dry run", async () => {
    await tick(await testEnv(env, { DRY_RUN: "1" }), { fetch: w.fetch, now: AT }, "shorts");
    expect(w.ytComments).toEqual([]);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM shorts_commented").first<{ n: number }>())?.n).toBe(0);
    expect(w.notifications.map((n) => n.title)).toEqual(["dry run: would comment on Short short1"]);
  });
});

describe("signed media links", () => {
  it("stream a Drive file only with a valid, unexpired signature", async () => {
    w.drive.set("abcdefghij12", { md5: MD5, mimeType: "video/mp4", bytes: "VIDEO" });
    const drive = new DriveStore({ saJson: (await testEnv(env)).DRIVE_SA_JSON, fetch: w.fetch });
    const now = 1_800_000_000;
    const good = await signedLink("https://s.test", "k", "abcdefghij12", "mp4", now + 60);
    const r = await serveMedia(new Request(good), "k", drive, now);
    expect([r.status, r.headers.get("Content-Type"), await r.text()]).toEqual([200, "video/mp4", "VIDEO"]);
    expect((await serveMedia(new Request(good), "k", drive, now + 61)).status).toBe(403);
    expect((await serveMedia(new Request(good.replace(/sig=./, "sig=0")), "k", drive, now)).status).toBe(403);
    expect((await serveMedia(new Request(good), "other-key", drive, now)).status).toBe(403);
  });
});

describe("the global fetch", () => {
  it("reaches the clients unbound from the cron Worker's handler (the runtime throws 'Illegal invocation' otherwise)", async () => {
    const worker = (await import("../src/cron")).default;
    const strict = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
      if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
      return w.fetch(input, init);
    };
    const orig = globalThis.fetch;
    globalThis.fetch = strict as typeof fetch;
    try {
      await seedReel(w);
      await worker.scheduled(
        { scheduledTime: AT.getTime(), cron: "*/5 * * * *", noRetry() {} } as ScheduledController,
        await testEnv(env, { DRY_RUN: "1" }),
        {} as ExecutionContext,
      );
      expect((await jobs())[0]?.state).toBe("done");
    } finally {
      globalThis.fetch = orig;
    }
  });
});

describe("Drive folder ids are remembered", () => {
  it("walks a path once, then starts below the remembered folder; a moved folder is walked again", async () => {
    await testEnv(env); // clears the caches
    const id = w.drivePut("UPLOADS/vlogs/CONTENT/20260823_LISBON/exports/shorts/instagram/short1_a.mp4", {
      md5: MD5,
      mimeType: "video/mp4",
    });
    const drive = new DriveStore({ saJson: (await testEnv(env)).DRIVE_SA_JSON, fetch: w.fetch });
    const queries = () => w.driveQueries;
    expect(
      (await drive.resolve("UPLOADS/vlogs/CONTENT/20260823_LISBON/exports/shorts/instagram/short1_a.mp4"))?.id,
    ).toBe(id);
    const first = queries();
    expect(
      (await drive.resolve("UPLOADS/vlogs/CONTENT/20260823_LISBON/exports/shorts/instagram/short1_a.mp4"))?.id,
    ).toBe(id);
    expect(queries() - first).toBe(1); // only the file's own level
    // the file moved away (as the cleanup does): below the remembered folder nothing is found, and a walk from the
    // top confirms it's gone from this path
    const postedDir = w.drive.get(w.drivePut("UPLOADS/_posted/keep.txt", { md5: "k", mimeType: "text/plain" }))!.parent;
    w.drive.get(id)!.parent = postedDir;
    const before = queries();
    expect(
      await drive.resolve("UPLOADS/vlogs/CONTENT/20260823_LISBON/exports/shorts/instagram/short1_a.mp4"),
    ).toBeNull();
    expect(queries() - before).toBe(1 + 8); // remembered try, then the full walk
  });
});

describe("a second comment", () => {
  it("is posted right after the self-comment, and a change after approval stops the post", async () => {
    await seedReel(w, { comment2: "🎵 Music: Autumn Sky" });
    igHappyPath(w);
    for (const m of [0, 5, 10, 15])
      await tick(await testEnv(env), { fetch: w.fetch, now: new Date(AT.getTime() + m * 60_000) });
    expect(w.calls.filter((c) => c.slug === "INSTAGRAM_POST_IG_MEDIA_COMMENTS").map((c) => c.args.message)).toEqual([
      "📍 Somewhere. Have you been?",
      "🎵 Music: Autumn Sky",
    ]);
    expect((await jobs())[0]).toMatchObject({ state: "done" });
  });

  it("refuses the post when the second comment changed after approval", async () => {
    const { folder, base } = await seedReel(w, { comment2: "first version" });
    await copyText(`channels/${folder}/shorts/instagram/${base}.comment2.txt`, "edited later\n");
    igHappyPath(w);
    await tick(await testEnv(env), { fetch: w.fetch, now: AT });
    expect((await jobs())[0]).toMatchObject({
      state: "refused",
      last_error: "the second comment changed after approval",
    });
  });
});

describe("media store conformance: drive (the fake Drive)", () => {
  for (const c of mediaStoreCases(async (files) => {
    const w2 = new World();
    clearFolderCache();
    const ids: Record<string, string> = {};
    for (const [path, f] of Object.entries(files))
      ids[path] = w2.drivePut(path, { md5: `md5-${f.bytes}`, mimeType: f.mime, bytes: f.bytes });
    return { store: new DriveStore({ saJson: (await testEnv(env)).DRIVE_SA_JSON, fetch: w2.fetch }), ids };
  }))
    it(c.name, c.run);
});
