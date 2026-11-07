// A YouTube video is uploaded private 6 h ahead of its time, waits unseen, and goes public at its due time; the tick
// advances the other jobs first, so an upload never delays an Instagram post.
import { env } from "cloudflare:workers";
import { planRemove } from "@bongsu/api/agent/ops";
import { addApproval, latestApprovals } from "@bongsu/core/data";
import type { Env } from "@bongsu/core/env";
import { sha256Hex, youtubeSha } from "@bongsu/core/formats/approved";
import { captionText } from "@bongsu/core/formats/texts";
import { nextPacificMidnight } from "@bongsu/core/formats/time";
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
const TEXTS = {
  title: "Demo",
  language: "en",
  translations: { es: { title: "Demostración", description: "Un vídeo de prueba" } },
};
/** The item's due time: 2026-10-20 18:00 in Seoul (the tests' zone). */
const T = new Date("2026-10-20T09:00:00Z");
const LEAD = 21600;
/** The channel's settings as the approval covers them (the built-in defaults: the test channels set none). */
const SETTINGS = { madeForKids: false, privacy: "public" } as const;
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
async function seedVideo(o: { key?: string; time?: string } = {}) {
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
      o.key ?? KEY,
      await localToUnix("2026-10-20", o.time ?? "18:00"),
      JSON.stringify(Object.values(ids).map((id) => ({ store: "drive", id }))),
      CAPTION,
      COMMENT,
      JSON.stringify(TEXTS),
    )
    .run();
}

/** The owner's approval of exactly the seeded item (what the app's approval stores). */
async function approveVideo(
  o: { approvedAt?: string; key?: string; time?: string; texts?: typeof TEXTS; clipMd5?: string } = {},
) {
  await addApproval(env.DB, {
    key: o.key ?? KEY,
    account: "main",
    dueAt: await localToUnix("2026-10-20", o.time ?? "18:00"),
    captionSha256: await sha256Hex(captionText(CAPTION)),
    commentSha256: await sha256Hex(COMMENT),
    altSha256: null,
    textsSha256: await youtubeSha(
      parseTexts(JSON.stringify(o.texts ?? TEXTS)),
      [`video:${ids.clip}`, `subtitle:es:${ids.es}`, `thumbnail:${ids.thumb}`],
      SETTINGS,
    ),
    media: [
      { store: "drive", id: ids.clip, checksum: o.clipMd5 ?? MD5S.clip },
      { store: "drive", id: ids.es, checksum: MD5S.es },
      { store: "drive", id: ids.thumb, checksum: MD5S.thumb },
    ],
    approvedAt: o.approvedAt ?? "2026-10-17T01:00:00Z",
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
const processed = (id = "vid-1") => {
  w.ytVideos.get(id)!.processing = "succeeded";
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
    await approveVideo({ approvedAt: "2026-10-20T07:00:00Z" }); // 2 h before it's due
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

  it("a video waiting for its time doesn't hold up an upload due sooner", async () => {
    // A, due at T + 5 h, is uploaded and waits; B, due at T + 1 h, is planned and approved meanwhile
    const B = "post:20261020_DEMO/clip_b";
    await seedVideo({ time: "23:00" });
    await approveVideo({ time: "23:00" });
    await run(at(-3600));
    await run(at(-3300));
    await run(at(-3000));
    processed();
    await run(at(-2700));
    expect(await job()).toMatchObject({ state: "container_created", phase: "waiting" });
    await seedVideo({ key: B, time: "19:00" });
    await approveVideo({ key: B, time: "19:00" });
    await run(at(-2400));
    expect(await job(B)).toMatchObject({ state: "container_created", phase: "uploading" });
    await setup({ JOBS_PER_TICK: "1" });
    await run(at(-2100));
    expect(await job(B)).toMatchObject({ phase: "extras" }); // the file went up
  });

  it("a new approval during the lead revises the uploaded video before its time", async () => {
    await uploadAhead();
    const changed = { ...TEXTS, title: "Changed and approved again" };
    await env.DB.prepare("UPDATE plan_items SET texts = ?1 WHERE item_key = ?2")
      .bind(JSON.stringify(changed), KEY)
      .run();
    await approveVideo({ approvedAt: "2026-10-20T08:00:00Z", texts: changed });
    await run(at(-3600));
    // reopened and revised: the same video, its title updated, no new upload
    expect(await job()).toMatchObject({ state: "container_created", phase: "extras", videoId: "vid-1" });
    expect(w.ytSessions.size).toBe(1);
    expect(w.ytVideos.get("vid-1")?.meta.title).toBe("Changed and approved again");
    await run(at(-3300));
    await run(at(-3000));
    expect(await job()).toMatchObject({ state: "container_created", phase: "waiting" });
    await run(T);
    expect(await job()).toMatchObject({ state: "published", last_error: null });
    expect(privacy()).toBe("public");
    expect(w.notifications.filter((n) => /refused|changed after approval/.test(`${n.title} ${n.body}`))).toEqual([]);
  });

  it("many subtitles land over several runs within the subrequest budget, each once, without counting polls", async () => {
    const langs = ["es", "fr", "de", "it", "pt"];
    const clip = w.drivePut("UPLOADS/_uploads/clip.mp4", {
      md5: MD5S.clip,
      mimeType: "video/mp4",
      bytes: "0123456789",
    });
    const subs = langs.map((lang, i) => ({
      lang,
      id: w.drivePut(`UPLOADS/_uploads/${lang}.srt`, {
        md5: String(i).repeat(32),
        mimeType: "application/x-subrip",
        bytes: "1\n00:00:00,000 --> 00:00:01,000\nHola\n",
      }),
      md5: String(i).repeat(32),
    }));
    const thumb = w.drivePut("UPLOADS/_uploads/thumbnail.jpg", {
      md5: MD5S.thumb,
      mimeType: "image/jpeg",
      bytes: "jpeg",
    });
    const media = [{ id: clip, md5: MD5S.clip }, ...subs, { id: thumb, md5: MD5S.thumb }];
    const dueAt = await localToUnix("2026-10-20", "18:00");
    await env.DB.prepare(
      "INSERT INTO plan_items (item_key, format, account, folder, name, due_at, options, hold, sort, created_at, updated_at, workspace_id, content, media, caption, comment, texts) VALUES (?1, 'video', 'main', '20261020_DEMO', 'clip', ?2, '{}', 0, 1, 0, 0, 'default', 'db', ?3, ?4, NULL, ?5)",
    )
      .bind(
        KEY,
        dueAt,
        JSON.stringify(media.map((m) => ({ store: "drive", id: m.id }))),
        CAPTION,
        JSON.stringify(TEXTS),
      )
      .run();
    await addApproval(env.DB, {
      key: KEY,
      account: "main",
      dueAt,
      captionSha256: await sha256Hex(captionText(CAPTION)),
      commentSha256: null,
      altSha256: null,
      textsSha256: await youtubeSha(
        parseTexts(JSON.stringify(TEXTS)),
        [`video:${clip}`, ...subs.map((s) => `subtitle:${s.lang}:${s.id}`), `thumbnail:${thumb}`],
        SETTINGS,
      ),
      media: media.map((m) => ({ store: "drive", id: m.id, checksum: m.md5 })),
      approvedAt: "2026-10-17T01:00:00Z",
      approvedBy: "owner@test",
    });
    await run(at(-LEAD));
    await run(at(-LEAD + 300)); // the file
    expect(await job()).toMatchObject({ phase: "extras", attempts: 0 });
    await run(at(-LEAD + 600)); // three of six: a part, and progress
    expect(await job()).toMatchObject({ phase: "extras", attempts: 0 });
    expect(w.ytCaptionInserts).toHaveLength(3);
    await run(at(-LEAD + 900)); // the other two and the thumbnail
    expect(await job()).toMatchObject({ phase: "processing", attempts: 0 });
    expect(w.ytCaptionInserts.map((c) => c.lang)).toEqual(langs);
    expect(w.ytVideos.get("vid-1")?.thumbnail?.bytes).toBe(4);
  });

  it("one deadline covers every upload of a run: a later upload waits for the next run", async () => {
    const B = "post:20261020_DEMO/clip_b";
    await seedVideo();
    await approveVideo();
    await seedVideo({ key: B, time: "18:30" });
    await approveVideo({ key: B, time: "18:30" });
    await run(at(-LEAD + 1800)); // both start
    expect(await job()).toMatchObject({ phase: "uploading" });
    expect(await job(B)).toMatchObject({ phase: "uploading" });
    // the first upload uses up the run's time: YouTube keeps 4 bytes when it is cut off
    const deadline = new AbortController();
    w.ytUploadCut = 4;
    const real = w.fetch;
    w.fetch = async (input, init) => {
      const req = new Request(input, init);
      if (
        req.method === "PUT" &&
        new URL(req.url).searchParams.has("upload_id") &&
        /^bytes \d/.test(req.headers.get("Content-Range") ?? "")
      )
        deadline.abort(new DOMException("The operation timed out", "TimeoutError"));
      return real(input, init);
    };
    now = at(-LEAD + 2100);
    const r = await tick(e, { fetch: w.fetch, now, signal: deadline.signal });
    w.fetch = real;
    expect(r.detail).toMatchObject({ advanced: 1 }); // B, skipped for the budget, isn't counted
    expect(await job()).toMatchObject({ phase: "uploading", attempts: 0 });
    expect((await step()).step?.data.offset).toBe(4);
    // B waits, untouched and with no attempt counted
    expect(await job(B)).toMatchObject({ phase: "uploading", attempts: 0, last_error: null });
    expect(w.ytVideos.get("vid-2")?.received).toBe(0);
  });

  it("videos waiting for their time don't keep the sweep from a run", async () => {
    await uploadAhead();
    await setup({ JOBS_PER_TICK: "1" });
    // a refused job's private video whose item is gone
    await env.DB.prepare(
      "INSERT INTO jobs (item_key, kind, account, due_at, state, dry_run, payload, created_at, updated_at, workspace_id) VALUES ('post:gone/clip', 'video', 'main', 0, 'refused', 0, ?1, 0, 0, 'default')",
    )
      .bind(JSON.stringify({ username: "main", account: "main", step: { state: "ready", data: { videoId: "vid-9" } } }))
      .run();
    // still private on YouTube: the sweep deletes it
    w.ytVideos.set("vid-9", {
      size: 10,
      received: 10,
      meta: {},
      status: { privacyStatus: "private", uploadStatus: "processed" },
      processing: "succeeded",
      captions: new Map(),
    });
    const deletes = countDeletes();
    await run(at(-3600)); // the one job advanced is a video waiting for its time: no subrequests spent
    expect(await job()).toMatchObject({ state: "container_created", phase: "waiting" });
    expect(deletes.n).toBe(1);
  });

  it("a job without a lead isn't advanced before its time", async () => {
    await env.DB.prepare(
      "INSERT INTO jobs (item_key, kind, account, due_at, state, dry_run, payload, created_at, updated_at, workspace_id) VALUES ('reel:early', 'video', 'instagram_conn-a', ?1, 'pending', 0, ?2, 0, 0, 'default')",
    )
      .bind(
        Math.floor(T.getTime() / 1000) + 3600,
        JSON.stringify({ username: "demo_travel", account: "instagram_conn-a" }),
      )
      .run();
    await run(T);
    expect(await job("reel:early")).toMatchObject({ state: "pending", attempts: 0, last_error: null });
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

const LOCKED =
  "YouTube keeps this video private until your Google project passes YouTube's audit (see the YouTube guide)";
const QUOTA = "YouTube's daily quota is used up: uploads continue after midnight Pacific time";
const step = async (key = KEY) =>
  JSON.parse(
    (await env.DB.prepare("SELECT payload FROM jobs WHERE item_key = ?1").bind(key).first<{ payload: string }>())!
      .payload,
  ) as { step?: { data: Record<string, unknown> }; notBefore?: number };
const LIVE_KEPT = "It may already be public on YouTube: it was kept, so check it there.";
const notes = (re: RegExp) => w.notifications.filter((n) => re.test(`${n.title}\n${n.body}`));
const s = (d: Date) => Math.floor(d.getTime() / 1000);

/** plan_remove, as an agent does it. */
const removeItem = () =>
  planRemove(
    {
      env: e,
      fetch: w.fetch,
      now,
      caller: { id: "agent", name: "agent", workspaceId: "default", scopes: ["plan" as const] },
    } as never,
    KEY,
  );
const deletedRows = async () =>
  (
    await env.DB.prepare("SELECT target, detail FROM audit WHERE action = 'youtube_video_deleted'").all<{
      target: string;
      detail: string;
    }>()
  ).results.map((r) => ({ target: r.target, detail: JSON.parse(r.detail) }));
const keptRows = async () =>
  (
    await env.DB.prepare("SELECT target, detail FROM audit WHERE action = 'youtube_video_kept'").all<{
      target: string;
      detail: string;
    }>()
  ).results.map((r) => ({ target: r.target, detail: JSON.parse(r.detail) }));
const KEPT_PUBLIC =
  "its video was published or scheduled by hand on YouTube, so it was kept: delete it there if it should go";
const REPLACE_KEPT =
  "the video uploaded earlier was published or scheduled by hand on YouTube, so it was kept and nothing was uploaded";
/** Counts YouTube's videos.list calls (a video's state) from here on. */
function countVideoReads() {
  const calls = { n: 0 };
  const real = w.fetch;
  w.fetch = async (input, init) => {
    const req = new Request(input, init);
    const u = new URL(req.url);
    if (req.method === "GET" && u.hostname === "www.googleapis.com" && u.pathname === "/youtube/v3/videos") calls.n++;
    return real(input, init);
  };
  return calls;
}
/** Counts YouTube's videos.delete calls from here on. */
function countDeletes() {
  const calls = { n: 0 };
  const real = w.fetch;
  w.fetch = async (input, init) => {
    const req = new Request(input, init);
    const u = new URL(req.url);
    if (req.method === "DELETE" && u.hostname === "www.googleapis.com" && u.pathname === "/youtube/v3/videos")
      calls.n++;
    return real(input, init);
  };
  return calls;
}

/** Goes public at T, but the read after the update fails: the job keeps `publishing`, the video is public. */
async function publishedUnread() {
  await uploadAhead();
  const real = w.fetch;
  let updated = false;
  w.fetch = async (input, init) => {
    const req = new Request(input, init);
    const u = new URL(req.url);
    if (u.hostname === "www.googleapis.com" && u.pathname === "/youtube/v3/videos") {
      if (req.method === "PUT") updated = true;
      else if (req.method === "GET" && updated)
        return Response.json({ error: { code: 500, message: "backendError" } }, { status: 500 });
    }
    return real(input, init);
  };
  await run(T);
  w.fetch = real;
  expect(await job()).toMatchObject({ state: "container_created", attempts: 1 });
  expect((await step()) as { publishing?: boolean }).toMatchObject({ publishing: true });
  expect(privacy()).toBe("public");
}

describe("YouTube uploads: changes, removal, quota and errors", () => {
  it("a video that may be live is never deleted when its item is removed", async () => {
    await publishedUnread();
    await removeItem();
    const deletes = countDeletes();
    await run(at(300));
    await run(at(600)); // nor by the sweep
    expect(await job()).toMatchObject({ state: "refused", last_error: "removed from the plan", videoId: "vid-1" });
    expect(w.ytVideos.has("vid-1")).toBe(true);
    expect(privacy()).toBe("public");
    expect(deletes.n).toBe(0);
    expect(await deletedRows()).toEqual([]);
    expect(notes(/refused/).map((n) => n.body)).toEqual([`removed from the plan\n${LIVE_KEPT}`]);
  });

  it("a video that may be live and is put on hold is kept, and the note sends the owner to the channel", async () => {
    await publishedUnread();
    await env.DB.prepare("UPDATE plan_items SET hold = 1 WHERE item_key = ?1").bind(KEY).run();
    await run(at(300));
    expect(await job()).toMatchObject({ state: "held", videoId: "vid-1" });
    expect(privacy()).toBe("public");
    expect(notes(/held/).map((n) => n.body)).toEqual([`on hold: it goes out once released\n${LIVE_KEPT}`]);
  });

  it("a video that may be live and fails its fingerprint check at the retry is kept, with the note", async () => {
    await publishedUnread();
    await env.DB.prepare("UPDATE plan_items SET texts = ?1 WHERE item_key = ?2")
      .bind(JSON.stringify({ ...TEXTS, title: "Changed" }), KEY)
      .run();
    await run(at(300));
    expect(await job()).toMatchObject({ state: "refused", videoId: "vid-1" });
    expect(privacy()).toBe("public");
    expect(notes(/refused/).map((n) => n.body.endsWith(`\n${LIVE_KEPT}`))).toEqual([true]);
  });

  it("a video that may be live and misses the catch-up window is held, with the note", async () => {
    await publishedUnread();
    await run(at(7 * 3600));
    expect(await job()).toMatchObject({ state: "held", videoId: "vid-1" });
    expect(privacy()).toBe("public");
    expect(notes(/held/).map((n) => n.body.endsWith(`\n${LIVE_KEPT}`))).toEqual([true]);
  });

  it("a publish whose answer was lost completes on the retry: Bongsu's own call, not the owner's hand", async () => {
    await publishedUnread();
    await run(at(300));
    expect(await job()).toMatchObject({ state: "published", permalink: expect.stringContaining("vid-1") });
    expect(privacy()).toBe("public");
    expect(notes(/refused/)).toEqual([]);
  });

  it("on that retry, a video the owner made private and scheduled by hand keeps the owner's time", async () => {
    await publishedUnread();
    const v = w.ytVideos.get("vid-1")!;
    v.status.privacyStatus = "private";
    v.status.publishAt = "2026-10-21T09:00:00Z";
    await run(at(300));
    expect(await job()).toMatchObject({ state: "refused", videoId: "vid-1" });
    expect(privacy()).toBe("private");
    expect(v.status.publishAt).toBe("2026-10-21T09:00:00Z");
    expect((await step()) as { publishing?: boolean }).toMatchObject({ publishing: true });
  });

  it("a video scheduled by hand in Studio while it waits is left as it is at the due time", async () => {
    await uploadAhead();
    w.ytVideos.get("vid-1")!.status.publishAt = "2026-10-21T09:00:00Z"; // the owner's own time, a day later
    await run(T);
    expect(await job()).toMatchObject({ state: "refused", videoId: "vid-1" });
    expect(privacy()).toBe("private");
    expect(w.ytVideos.get("vid-1")?.status.publishAt).toBe("2026-10-21T09:00:00Z");
    expect(notes(/refused/).map((n) => n.body)).toEqual([expect.stringContaining("scheduled by hand")]);
  });

  it("a private video refused for a removed item gets no such note", async () => {
    await uploadAhead();
    await removeItem();
    await run(at(-3600));
    expect(notes(/refused/).map((n) => n.body)).toEqual(["removed from the plan"]);
  });

  it("a refused job that may be live is never reopened by a new approval", async () => {
    await publishedUnread();
    await env.DB.prepare("UPDATE plan_items SET due_at = ?1 WHERE item_key = ?2")
      .bind(await localToUnix("2026-10-20", "19:00"), KEY)
      .run();
    await run(at(300));
    expect(await job()).toMatchObject({ state: "refused", videoId: "vid-1" });
    await approveVideo({ approvedAt: "2026-10-20T09:10:00Z", time: "19:00" });
    await run(at(900));
    expect(await job()).toMatchObject({ state: "refused", videoId: "vid-1" });
    expect((await step()) as { publishing?: boolean }).toMatchObject({ publishing: true });
    expect(privacy()).toBe("public"); // not made private again by a revision
    expect(w.ytSessions.size).toBe(1);
  });

  it("a texts-only edit after the upload updates the video", async () => {
    await uploadAhead();
    const changed = { ...TEXTS, title: "A better title" };
    await env.DB.prepare("UPDATE plan_items SET texts = ?1 WHERE item_key = ?2")
      .bind(JSON.stringify(changed), KEY)
      .run();
    await approveVideo({ approvedAt: "2026-10-20T08:00:00Z", texts: changed });
    await run(at(-3600));
    expect(await job()).toMatchObject({ state: "container_created", phase: "extras", videoId: "vid-1" });
    expect(w.ytVideos.get("vid-1")?.meta.title).toBe("A better title"); // videos.update
    expect(w.ytVideos.get("vid-1")?.status.privacyStatus).toBe("private");
    expect(w.ytSessions.size).toBe(1); // no second upload
  });

  it("a new video file uploads again", async () => {
    await uploadAhead();
    w.drive.get(ids.clip)!.md5 = "d".repeat(32);
    await approveVideo({ approvedAt: "2026-10-20T08:00:00Z", clipMd5: "d".repeat(32) });
    await run(at(-3600));
    expect(w.ytVideos.has("vid-1")).toBe(false); // the old one deleted
    expect(w.ytSessions.size).toBe(2); // a new session
    expect(await job()).toMatchObject({ state: "container_created", phase: "uploading" });
    expect((await job())?.videoId).toBeUndefined();
  });

  it("removing the item deletes the private video", async () => {
    await uploadAhead();
    await removeItem();
    await run(at(-3600));
    expect(await job()).toMatchObject({ state: "refused", last_error: "removed from the plan" });
    expect(w.ytVideos.has("vid-1")).toBe(false);
    const rows = await env.DB.prepare("SELECT target, detail FROM audit WHERE action = 'youtube_video_deleted'").all<{
      target: string;
      detail: string;
    }>();
    expect(rows.results.map((r) => ({ target: r.target, detail: JSON.parse(r.detail) }))).toEqual([
      { target: KEY, detail: { videoId: "vid-1" } },
    ]);
  });

  it("a reschedule keeps the private video for the next approval", async () => {
    await uploadAhead();
    await env.DB.prepare("UPDATE plan_items SET due_at = ?1 WHERE item_key = ?2")
      .bind(await localToUnix("2026-10-20", "19:00"), KEY)
      .run();
    await run(at(-3600));
    expect(await job()).toMatchObject({ state: "refused", videoId: "vid-1" });
    expect(w.ytVideos.get("vid-1")?.status.privacyStatus).toBe("private");
    await approveVideo({ approvedAt: "2026-10-20T08:00:00Z", time: "19:00" });
    await run(at(-3300));
    // revised, not uploaded again
    expect(await job()).toMatchObject({ state: "container_created", phase: "extras", videoId: "vid-1" });
    expect(w.ytSessions.size).toBe(1);
  });

  it("quota waits until midnight Pacific without counting attempts", async () => {
    await setup({ JOBS_PER_TICK: "1" });
    await seedVideo();
    await approveVideo();
    await run(at(-LEAD));
    await run(at(-LEAD + 300));
    expect(await job()).toMatchObject({ phase: "extras" });
    w.ytQuota = true;
    await run(at(-LEAD + 600));
    const midnight = nextPacificMidnight(s(at(-LEAD + 600)));
    expect((await step()).step?.data.notBefore).toBe(midnight);
    expect(await job()).toMatchObject({ state: "container_created", phase: "extras", attempts: 0 });
    // the waiting job takes no slot: another video, due later, is started (and meets the quota at its start)
    const B = "post:20261020_DEMO/clip_b";
    await seedVideo({ key: B, time: "18:30" });
    await approveVideo({ key: B, time: "18:30" });
    await run(at(-19200));
    expect(await job(B)).toMatchObject({ state: "pending", attempts: 0 });
    expect((await step(B)).notBefore).toBe(nextPacificMidnight(s(at(-19200))));
    expect(await job()).toMatchObject({ phase: "extras", attempts: 0 });
    expect(notes(/quota/)).toHaveLength(1);
    expect(notes(/quota/)[0].body).toContain(QUOTA);
    // after midnight Pacific it goes on
    w.ytQuota = false;
    expect(midnight).toBeLessThanOrEqual(s(at(-7200)));
    await run(at(-7200));
    expect(await job()).toMatchObject({ phase: "processing", attempts: 0 });
  });

  it("a gone session starts again from start", async () => {
    await seedVideo();
    await approveVideo();
    await run(at(-LEAD));
    w.ytSessions.delete("up-1"); // YouTube forgot it
    await run(at(-LEAD + 300));
    expect(await job()).toMatchObject({ state: "pending", attempts: 0, videoId: undefined });
    await run(at(-LEAD + 600));
    const j = await job();
    expect(j).toMatchObject({ state: "container_created", phase: "uploading", attempts: 0, last_error: null });
    expect(w.ytSessions.has(String((await step()).step?.data.session).split("upload_id=")[1])).toBe(true);
    expect(j?.videoId).toBeUndefined();
  });

  it("the audit lock fails the job with its note, and a new approval publishes it once unlocked", async () => {
    await uploadAhead();
    w.ytKeepPrivate = true;
    await run(T);
    expect(await job()).toMatchObject({ state: "failed", last_error: LOCKED, videoId: "vid-1" });
    expect(privacy()).toBe("private");
    expect(notes(/audit/).map((n) => n.body)).toEqual([expect.stringContaining(LOCKED)]);
    // the project passes the audit; the owner approves again
    w.ytKeepPrivate = false;
    await approveVideo({ approvedAt: "2026-10-20T09:05:00Z" });
    for (const t of [600, 900, 1200, 1500]) if ((await job())?.state !== "published") await run(at(t));
    expect(await job()).toMatchObject({ state: "published", videoId: "vid-1" });
    expect(privacy()).toBe("public");
    expect(w.ytSessions.size).toBe(1);
  });

  it("a job that fails for good keeps its private video", async () => {
    await seedVideo();
    await approveVideo();
    await run(at(-LEAD));
    await run(at(-LEAD + 300));
    await run(at(-LEAD + 600));
    expect(await job()).toMatchObject({ phase: "processing" });
    const real = w.fetch;
    w.fetch = async (input, init) => {
      const req = new Request(input, init);
      const u = new URL(req.url);
      if (req.method === "GET" && u.hostname === "www.googleapis.com" && u.pathname === "/youtube/v3/videos")
        return Response.json({ error: { code: 500, message: "backendError" } }, { status: 500 });
      return real(input, init);
    };
    for (const t of [900, 1200, 1500]) await run(at(-LEAD + t));
    expect(await job()).toMatchObject({ state: "failed", attempts: 3, videoId: "vid-1" });
    expect(w.ytVideos.has("vid-1")).toBe(true); // not deleted
    const failed = notes(/failed/);
    expect(failed).toHaveLength(1);
    expect(failed[0].body).toContain("private");
  });

  it("a refused thumbnail is noted once", async () => {
    w.ytThumbnailRefused = true;
    await uploadAhead();
    await run(at(-3600));
    expect(notes(/thumbnail/).map((n) => n.body)).toEqual([
      expect.stringContaining(
        "YouTube refused the thumbnail: the channel needs YouTube's verified features (the video still goes out)",
      ),
    ]);
  });

  it("a refused job's video is deleted once its item is removed, and only once", async () => {
    await uploadAhead();
    await env.DB.prepare("UPDATE plan_items SET due_at = ?1 WHERE item_key = ?2")
      .bind(await localToUnix("2026-10-20", "19:00"), KEY)
      .run();
    await run(at(-3600));
    expect(await job()).toMatchObject({ state: "refused", videoId: "vid-1" }); // kept for the next approval
    await removeItem();
    const deletes = countDeletes();
    await run(at(-3300));
    expect(w.ytVideos.has("vid-1")).toBe(false);
    expect(await deletedRows()).toEqual([{ target: KEY, detail: { videoId: "vid-1" } }]);
    expect((await job())?.videoId).toBeUndefined();
    await run(at(-3000));
    expect(deletes.n).toBe(1);
    expect(await deletedRows()).toHaveLength(1);
  });

  it("a run that advanced its full share of jobs leaves the sweep for a later one", async () => {
    await uploadAhead();
    await env.DB.prepare("UPDATE plan_items SET due_at = ?1 WHERE item_key = ?2")
      .bind(await localToUnix("2026-10-20", "19:00"), KEY)
      .run();
    await run(at(-3600));
    expect(await job()).toMatchObject({ state: "refused", videoId: "vid-1" });
    await removeItem();
    await setup({ JOBS_PER_TICK: "1" });
    const { key: reel } = await seedReel(w, { time: "18:05" });
    igHappyPath(w);
    const deletes = countDeletes();
    await run(at(360)); // the Reel takes the run's one job
    expect((await job(reel))?.state).toBe("container_created");
    expect(deletes.n).toBe(0);
    await setup();
    await run(at(660));
    expect(deletes.n).toBe(1);
    expect(w.ytVideos.has("vid-1")).toBe(false);
  });

  it("a failed job's video is deleted once its item is removed", async () => {
    await uploadAhead();
    w.ytKeepPrivate = true;
    await run(T);
    expect(await job()).toMatchObject({ state: "failed", videoId: "vid-1" });
    await removeItem();
    await run(at(300));
    expect(w.ytVideos.has("vid-1")).toBe(false);
    expect(await deletedRows()).toEqual([{ target: KEY, detail: { videoId: "vid-1" } }]);
  });

  it("a failed job's video published by hand is kept when its item is removed, noted once, not retried", async () => {
    await uploadAhead();
    w.ytKeepPrivate = true;
    await run(T);
    expect(await job()).toMatchObject({ state: "failed", videoId: "vid-1" });
    w.ytVideos.get("vid-1")!.status.privacyStatus = "public"; // the owner publishes it in YouTube Studio
    await removeItem();
    const deletes = countDeletes();
    const reads = countVideoReads();
    await run(at(300));
    await run(at(600));
    await run(at(900));
    expect(w.ytVideos.has("vid-1")).toBe(true);
    expect(privacy()).toBe("public");
    expect(deletes.n).toBe(0);
    expect(reads.n).toBe(1); // read once, then left alone
    expect(await deletedRows()).toEqual([]);
    expect(await keptRows()).toEqual([{ target: KEY, detail: { videoId: "vid-1" } }]);
    expect(await job()).toMatchObject({ state: "failed", videoId: undefined });
    expect(notes(/kept/).map((n) => n.body)).toEqual([`removed from the plan; ${KEPT_PUBLIC}`]);
  });

  it("a waiting video published by hand is kept when its item is removed, with one refusal note", async () => {
    await uploadAhead();
    w.ytVideos.get("vid-1")!.status.privacyStatus = "unlisted";
    await removeItem();
    const deletes = countDeletes();
    await run(at(-3600)); // the active job settles
    await run(at(-3300)); // and the sweep passes it by
    expect(w.ytVideos.has("vid-1")).toBe(true);
    expect(deletes.n).toBe(0);
    expect(await deletedRows()).toEqual([]);
    expect(await keptRows()).toEqual([{ target: KEY, detail: { videoId: "vid-1" } }]);
    expect(await job()).toMatchObject({ state: "refused", videoId: undefined });
    expect(notes(/refused|kept/).map((n) => n.body)).toEqual([`removed from the plan; ${KEPT_PUBLIC}`]);
  });

  it.each([
    ["the same file", false],
    ["a new file", true],
  ])("a new approval with %s never revises nor replaces a video published by hand", async (_, newFile) => {
    await uploadAhead();
    await env.DB.prepare("UPDATE plan_items SET due_at = ?1 WHERE item_key = ?2")
      .bind(await localToUnix("2026-10-20", "19:00"), KEY)
      .run();
    await run(at(-3600));
    expect(await job()).toMatchObject({ state: "refused", videoId: "vid-1" });
    w.ytVideos.get("vid-1")!.status.privacyStatus = "public";
    if (newFile) w.drive.get(ids.clip)!.md5 = "d".repeat(32);
    const deletes = countDeletes();
    await approveVideo({
      approvedAt: "2026-10-20T08:00:00Z",
      time: "19:00",
      ...(newFile ? { clipMd5: "d".repeat(32) } : {}),
    });
    await run(at(-3300));
    expect(await job()).toMatchObject({ state: "failed", videoId: undefined });
    expect(privacy()).toBe("public"); // not made private again
    expect(w.ytVideos.get("vid-1")?.meta.title).toBe("Demo");
    expect(deletes.n).toBe(0);
    expect(w.ytSessions.size).toBe(1); // nothing uploaded again
    expect(notes(/failed/).map((n) => n.body)).toEqual([expect.stringContaining(REPLACE_KEPT)]);
  });

  it("dry run never deletes a removed item's video", async () => {
    await uploadAhead();
    await setup({ DRY_RUN: "1" });
    await removeItem();
    const deletes = countDeletes();
    await run(at(-3600)); // the active job settles
    await run(at(-3300)); // and the sweep passes it by
    expect(await job()).toMatchObject({ state: "refused", last_error: "removed from the plan", videoId: "vid-1" });
    expect(w.ytVideos.has("vid-1")).toBe(true);
    expect(deletes.n).toBe(0);
    expect(await deletedRows()).toEqual([]);
    const would = await env.DB.prepare("SELECT target, detail FROM audit WHERE action = 'would_delete'").all<{
      target: string;
      detail: string;
    }>();
    expect(would.results.map((r) => ({ target: r.target, detail: JSON.parse(r.detail) }))).toEqual([
      { target: KEY, detail: { videoId: "vid-1" } },
    ]);
  });
});
