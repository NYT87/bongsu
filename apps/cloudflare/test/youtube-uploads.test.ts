// A YouTube video is uploaded private 6 h ahead of its time, waits unseen, and goes public at its due time; the tick
// advances the other jobs first, so an upload never delays an Instagram post.
import { env } from "cloudflare:workers";
import { addApproval, latestApprovals } from "@bongsu/core/data";
import type { Env } from "@bongsu/core/env";
import { sha256Hex, youtubeSha } from "@bongsu/core/formats/approved";
import { captionText } from "@bongsu/core/formats/texts";
import { parseTexts } from "@bongsu/core/formats/youtube-texts";
import { tick } from "@bongsu/core/tick";
import { beforeEach, describe, expect, it } from "vitest";
import { clearPlan, igHappyPath, localToUnix, postedRows, seedReel, serveLinks, testEnv, World } from "./world";

describe("YouTube uploads: data", () => {
  it("an approval keeps its texts fingerprint", async () => {
    const base = {
      account: "demo_channel",
      dueAt: 1000,
      captionSha256: "a".repeat(64),
      commentSha256: null,
      altSha256: null,
      media: [],
      approvedAt: "2026-10-20T00:00:00Z",
      approvedBy: "owner@app",
    };
    await addApproval(env.DB, { ...base, key: "yt-with", textsSha256: "f".repeat(64) });
    await addApproval(env.DB, { ...base, key: "yt-without" });
    const got = await latestApprovals(env.DB, ["yt-with", "yt-without"]);
    expect(got.get("yt-with")?.textsSha256).toBe("f".repeat(64));
    expect(got.get("yt-without")?.textsSha256).toBeNull();
  });
});

const KEY = "post:20261020_DEMO/clip";
const CAPTION = "A demo video";
const COMMENT = "Which part did you like?";
const TEXTS = { title: "Demo", translations: { es: { title: "Demostración", description: "Un vídeo de prueba" } } };
/** The item's due time: 2026-10-20 18:00 in Seoul (the tests' zone). */
const T = new Date("2026-10-20T09:00:00Z");
const LEAD = 21600;
const at = (s: number) => new Date(T.getTime() + s * 1000);

let w: World;
let e: Env;
let now = T;
let ids: Record<string, string>;
const MD5S = { clip: "a".repeat(32), es: "b".repeat(32), thumb: "c".repeat(32) };

/** The tests' environment, with the channel connected and its file links served at the tick's clock. */
async function setup(overrides: Partial<Env> = {}) {
  e = await testEnv(env, overrides);
  await env.DB.prepare("UPDATE accounts SET external_id = 'UCdemo000000000000000000' WHERE id = 'main'").run();
  serveLinks(w, e, () => now);
}
const run = (d: Date) => {
  now = d;
  return tick(e, { fetch: w.fetch, now: d });
};

/** A draft-made YouTube item (content 'db'): the video, Spanish subtitles and a thumbnail in the Drive store. */
async function seedVideo() {
  ids = {
    clip: w.drivePut("UPLOADS/_uploads/clip.mp4", { md5: MD5S.clip, mimeType: "video/mp4", bytes: "0123456789" }),
    es: w.drivePut("UPLOADS/_uploads/es.srt", {
      md5: MD5S.es,
      mimeType: "application/x-subrip",
      bytes: "1\n00:00:00,000 --> 00:00:01,000\nHola\n",
    }),
    thumb: w.drivePut("UPLOADS/_uploads/thumbnail.jpg", { md5: MD5S.thumb, mimeType: "image/jpeg", bytes: "jpeg" }),
  };
  await env.DB.prepare(
    "INSERT INTO plan_items (item_key, format, account, folder, name, due_at, options, hold, sort, created_at, updated_at, workspace_id, content, media, caption, comment, texts) VALUES (?1, 'video', 'main', '20261020_DEMO', 'clip', ?2, '{}', 0, 1, 0, 0, 'default', 'db', ?3, ?4, ?5, ?6)",
  )
    .bind(
      KEY,
      await localToUnix("2026-10-20", "18:00"),
      JSON.stringify(Object.values(ids).map((id) => ({ store: "drive", id }))),
      CAPTION,
      COMMENT,
      JSON.stringify(TEXTS),
    )
    .run();
}

/** The owner's approval of exactly the seeded item (what the app's approval stores). */
async function approveVideo(approvedAt = "2026-10-17T01:00:00Z") {
  await addApproval(env.DB, {
    key: KEY,
    account: "main",
    dueAt: await localToUnix("2026-10-20", "18:00"),
    captionSha256: await sha256Hex(captionText(CAPTION)),
    commentSha256: await sha256Hex(COMMENT),
    altSha256: null,
    textsSha256: await youtubeSha(parseTexts(JSON.stringify(TEXTS)), [
      `video:${ids.clip}`,
      `subtitle:es:${ids.es}`,
      `thumbnail:${ids.thumb}`,
    ]),
    media: [
      { store: "drive", id: ids.clip, checksum: MD5S.clip },
      { store: "drive", id: ids.es, checksum: MD5S.es },
      { store: "drive", id: ids.thumb, checksum: MD5S.thumb },
    ],
    approvedAt,
    approvedBy: "owner@test",
  });
}

const job = async (key = KEY) => {
  const r = await env.DB.prepare(
    "SELECT state, attempts, last_error, dry_run, permalink, payload FROM jobs WHERE item_key = ?1",
  )
    .bind(key)
    .first<{
      state: string;
      attempts: number;
      last_error: string | null;
      dry_run: number;
      permalink: string | null;
      payload: string;
    }>();
  if (!r) return null;
  const p = JSON.parse(r.payload) as { step?: { state: string; data: Record<string, unknown> } };
  return { ...r, phase: p.step?.data.phase, videoId: p.step?.data.videoId };
};
const privacy = () => w.ytVideos.get("vid-1")?.status.privacyStatus;
const processed = () => {
  w.ytVideos.get("vid-1")!.processing = "succeeded";
};

/** Seeded, approved, and run from 6 h ahead until the video is processed and waits for its time. */
async function uploadAhead() {
  await seedVideo();
  await approveVideo();
  await run(at(-LEAD)); // start: a private upload session
  await run(at(-LEAD + 300)); // the file
  await run(at(-LEAD + 600)); // subtitles and thumbnail
  processed();
  await run(at(-LEAD + 900)); // processed: waiting
  expect(await job()).toMatchObject({ state: "container_created", phase: "waiting", attempts: 0 });
}

beforeEach(async () => {
  await env.DB.batch(["audit", "drafts", "jobs"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await clearPlan();
  w = new World();
  now = T;
  await setup();
});

describe("YouTube uploads: the tick", () => {
  it("the upload starts 6 h ahead", async () => {
    await seedVideo();
    await approveVideo();
    await run(at(-LEAD - 1));
    expect(await job()).toBeNull();
    await run(at(-LEAD));
    expect(await job()).toMatchObject({ state: "container_created", phase: "uploading" });
    expect(w.ytSessions.size).toBe(1);
  });

  it("the waiting is unseen until the due time", async () => {
    await seedVideo();
    await approveVideo();
    await run(at(-LEAD));
    await run(at(-LEAD + 300));
    await run(at(-LEAD + 600));
    await run(at(-LEAD + 900)); // still processing: a poll
    expect(await job()).toMatchObject({ phase: "processing", attempts: 1 });
    processed();
    await run(at(-LEAD + 1200));
    expect(await job()).toMatchObject({ state: "container_created", phase: "waiting", attempts: 0 });
    for (const s of [-3600, -600, -1]) {
      await run(at(s));
      expect(await job()).toMatchObject({ state: "container_created", phase: "waiting", attempts: 0 });
    }
    expect(privacy()).toBe("private");
    expect(await postedRows()).toEqual([]);
  });

  it("at the due time it goes public and the first comment follows", async () => {
    await uploadAhead();
    await run(T);
    expect(await job()).toMatchObject({ state: "published", permalink: "https://youtube.com/watch?v=vid-1" });
    expect(privacy()).toBe("public");
    await run(at(300));
    expect(await job()).toMatchObject({ state: "done" });
    expect(w.ytComments).toEqual([{ video: "vid-1", text: COMMENT }]);
    expect(await postedRows()).toMatchObject([
      { item_key: KEY, account: "main", media_id: "vid-1", permalink: "https://youtube.com/watch?v=vid-1" },
    ]);
  });

  it("approved inside the lead uploads at once and publishes when processed", async () => {
    await seedVideo();
    await run(at(-LEAD));
    expect(await job()).toMatchObject({ state: "refused", last_error: "not approved" });
    await approveVideo("2026-10-20T07:00:00Z"); // 2 h before it's due
    await run(at(-7200));
    expect(await job()).toMatchObject({ state: "container_created", phase: "uploading" });
    await run(at(-6900));
    await run(at(-6600));
    await run(T); // due, but YouTube is still processing it
    expect(await job()).toMatchObject({ state: "container_created", phase: "processing" });
    expect(privacy()).toBe("private");
    processed();
    await run(at(300));
    expect(await job()).toMatchObject({ state: "published" });
    expect(privacy()).toBe("public");
  });

  it("a title changed after the upload is refused at the due time and stays private", async () => {
    await uploadAhead();
    await env.DB.prepare("UPDATE plan_items SET texts = ?1 WHERE item_key = ?2")
      .bind(JSON.stringify({ ...TEXTS, title: "Changed after the upload" }), KEY)
      .run();
    await run(at(-60));
    expect(await job()).toMatchObject({ state: "container_created", phase: "waiting" });
    await run(T);
    expect(await job()).toMatchObject({
      state: "refused",
      last_error: "the title or translations changed after approval",
      videoId: "vid-1", // kept: a new approval revises this video
    });
    expect(privacy()).toBe("private");
  });

  it("a paused workspace's ready video stays private and goes out after resume", async () => {
    await uploadAhead();
    await env.DB.prepare("UPDATE workspace_settings SET paused = '{}' WHERE workspace_id = 'default'").run();
    await run(T);
    await run(at(600));
    expect(await job()).toMatchObject({ state: "container_created", phase: "waiting" });
    expect(privacy()).toBe("private");
    await env.DB.prepare("UPDATE workspace_settings SET paused = NULL WHERE workspace_id = 'default'").run();
    await run(at(1800));
    expect(await job()).toMatchObject({ state: "published" });
    expect(privacy()).toBe("public");
  });

  it("an Instagram post isn't delayed by an upload", async () => {
    await setup({ JOBS_PER_TICK: "1" });
    await seedVideo();
    await approveVideo();
    await run(at(-LEAD)); // the upload is under way, due before the Reel
    const { key: reel } = await seedReel(w, { time: "18:05" });
    igHappyPath(w);
    await run(at(360));
    expect((await job(reel))?.state).toBe("container_created");
    expect(await job()).toMatchObject({ state: "container_created", phase: "uploading" });
    expect(w.ytPuts).toEqual([]);
  });

  it("dry run uploads nothing", async () => {
    await setup({ DRY_RUN: "1" });
    await seedVideo();
    await approveVideo();
    await run(at(-LEAD));
    expect(await job()).toMatchObject({ state: "done", dry_run: 1, last_error: "dry run: nothing published" });
    expect(w.notifications.some((n) => n.title.includes(`would publish ${KEY}`))).toBe(true);
    expect(w.ytSessions.size).toBe(0);
  });
});
