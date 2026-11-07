// A YouTube video Bongsu uploaded is counted once, under its plan item (D6): in the sampler, channel stats, the
// performance list, the calendar and the video page; a video uploaded elsewhere keeps its video: page and series.
import { env } from "cloudflare:workers";
import { appRoutes } from "@bongsu/api/pwa/routes";
import { createSession } from "@bongsu/api/pwa/session";
import { upsertAccount } from "@bongsu/core/accounts";
import { calendar, channelUploads } from "@bongsu/core/calendar";
import { addApproval, latestApprovals } from "@bongsu/core/data";
import type { Db, DbStatement } from "@bongsu/core/db";
import type { Env } from "@bongsu/core/env";
import { sha256Hex, youtubeSha } from "@bongsu/core/formats/approved";
import { captionText } from "@bongsu/core/formats/texts";
import { zoneDate } from "@bongsu/core/formats/time";
import { parseTexts } from "@bongsu/core/formats/youtube-texts";
import { sampleMetrics } from "@bongsu/core/metrics";
import { moveRelease, releaseStatus } from "@bongsu/core/release";
import { tick } from "@bongsu/core/tick";
import { bongsuVideos } from "@bongsu/core/youtube-videos";
import { beforeEach, describe, expect, it } from "vitest";
import { clearPlan, serveLinks, testEnv, World } from "./world";

const KEY = "post:20261020_DEMO/clip";
const MANUAL = "man-1";
const TEXTS = { title: "Demo" };
const LEAD = 21600;
const HOUR = 3600;
/** The item's due time: yesterday's noon UTC, so it is inside the stats' windows whenever the suite runs. */
const DUE = Math.floor(Date.now() / 86400e3) * 86400 - 86400 + 12 * HOUR;
const T = new Date(DUE * 1000);
const at = (s: number) => new Date(T.getTime() + s * 1000);

let w: World;
let e: Env;
let now = T;
let clip = "";
let cookie = "";

const run = (d: Date) => {
  now = d;
  return tick(e, { fetch: w.fetch, now: d });
};
const sample = (d: Date) => sampleMetrics(e, { fetch: w.fetch, now: d });
const get = async <R = Record<string, any>>(path: string) => {
  const r = await appRoutes(w.fetch).request(`https://bongsu.test${path}`, { headers: { Cookie: cookie } }, e);
  return { status: r.status, json: (await r.json()) as R };
};
const seriesOf = (key: string) =>
  env.DB.prepare("SELECT taken_at FROM post_metrics WHERE item_key = ?1 ORDER BY taken_at")
    .bind(key)
    .all()
    .then((r) => r.results.length);

/** A one-file video item due at DUE on `main`, approved. */
async function seedApproved(key = KEY) {
  clip = w.drivePut("UPLOADS/_uploads/clip.mp4", { md5: "a".repeat(32), mimeType: "video/mp4", bytes: "0123456789" });
  await env.DB.prepare(
    "INSERT INTO plan_items (item_key, format, account, folder, name, due_at, options, hold, sort, created_at, updated_at, workspace_id, content, media, caption, comment, texts) VALUES (?1, 'video', 'main', '20261020_DEMO', 'clip', ?2, '{}', 0, 1, 0, 0, 'default', 'db', ?3, 'A demo video', NULL, ?4)",
  )
    .bind(key, DUE, JSON.stringify([{ store: "drive", id: clip }]), JSON.stringify(TEXTS))
    .run();
  await approve(key, DUE);
}
async function approve(key: string, dueAt: number) {
  await addApproval(env.DB, {
    key,
    account: "main",
    dueAt,
    captionSha256: await sha256Hex(captionText("A demo video")),
    commentSha256: null,
    altSha256: null,
    textsSha256: await youtubeSha(parseTexts(JSON.stringify(TEXTS)), [`video:${clip}`]),
    media: [{ store: "drive", id: clip, checksum: "a".repeat(32) }],
    approvedAt: new Date((DUE - 3 * 86400) * 1000).toISOString(),
    approvedBy: "owner@test",
  });
}

/** Uploaded ahead and waiting private (the video id is in the job's step only). */
async function uploadAhead() {
  await seedApproved();
  for (const s of [-LEAD, -LEAD + 300, -LEAD + 600]) await run(at(s));
  w.ytVideos.get("vid-1")!.processing = "succeeded";
  await run(at(-LEAD + 900));
}
/** Published at DUE: the video is public and listed in the channel's uploads. */
async function publish() {
  await uploadAhead();
  await run(T);
  expect(await env.DB.prepare("SELECT state FROM jobs WHERE item_key = ?1").bind(KEY).first("state")).toBe("published");
  await run(at(300)); // no comment to post: done, and recorded as posted
  w.ytUploads.push({
    id: "vid-1",
    title: "Demo",
    privacy: "public",
    publishedAt: T.toISOString(),
    duration: "PT30S",
  });
}
/** Another video on the channel, uploaded by hand, public. */
const manualUpload = () =>
  w.ytUploads.push({
    id: MANUAL,
    title: "By hand",
    privacy: "public",
    publishedAt: at(-HOUR).toISOString(),
    duration: "PT10M",
  });

beforeEach(async () => {
  await env.DB.batch(
    ["audit", "drafts", "jobs", "post_metrics", "account_metrics", "snapshots"].map((t) =>
      env.DB.prepare(`DELETE FROM ${t}`),
    ),
  );
  await env.DB.prepare("DELETE FROM settings WHERE key LIKE 'yt_uploads:%' OR key LIKE 'metrics_%'").run();
  await clearPlan();
  w = new World();
  now = T;
  e = await testEnv(env);
  await env.DB.prepare("UPDATE accounts SET external_id = 'UCdemo000000000000000000' WHERE id = 'main'").run();
  serveLinks(w, e, () => now);
  cookie = `bongsu_session=${await createSession(env.DB, Math.floor(Date.now() / 1000), { app: "pwa", userId: "owner" })}`;
});

describe("one video, one place", () => {
  it("maps a video to its item from the step while uploading and from media_id once published", async () => {
    await uploadAhead();
    expect([...(await bongsuVideos(env.DB, ["main"], "default"))]).toEqual([["vid-1", KEY]]);
    await run(T);
    expect([...(await bongsuVideos(env.DB, ["main"], "default"))]).toEqual([["vid-1", KEY]]);
    expect((await bongsuVideos(env.DB, ["vlogs"], "default")).size).toBe(0);
    expect((await bongsuVideos(env.DB, ["main"], "b")).size).toBe(0);
  });

  it("reads only the channels' jobs: a published Instagram Reel of the workspace isn't read or mapped", async () => {
    await publish();
    await env.DB.prepare(
      "INSERT INTO jobs (item_key, kind, account, due_at, state, media_id, dry_run, payload, created_at, updated_at, workspace_id) VALUES ('reel:20261020_DEMO/reel', 'video', 'instagram_conn-a', 1, 'done', 'ig-media-1', 0, '{\"username\":\"demo_travel\"}', 0, 0, 'default')",
    ).run();
    // counts the job rows the query hands back: the Reel must not be among them (bounded work per request)
    let read = 0;
    const counting: Db = {
      prepare: (sql) => {
        const wrap = (s: DbStatement): DbStatement => ({
          bind: (...v) => wrap(s.bind(...v)),
          first: () => s.first(),
          run: () => s.run(),
          all: async <T>() => {
            const r = await s.all<T>();
            if (/FROM jobs/.test(sql)) read += r.results.length;
            return r;
          },
        });
        return wrap(env.DB.prepare(sql));
      },
      batch: (s) => env.DB.batch(s as never),
    };
    expect([...(await bongsuVideos(counting, ["main"], "default"))]).toEqual([["vid-1", KEY]]);
    expect(read).toBe(1);
    // the same Reel claiming the channel in its payload still isn't the channel's job (its connection is Instagram's)
    await env.DB.prepare(
      "UPDATE jobs SET payload = '{\"username\":\"main\"}' WHERE item_key = 'reel:20261020_DEMO/reel'",
    ).run();
    expect([...(await bongsuVideos(env.DB, ["main"], "default"))]).toEqual([["vid-1", KEY]]);
  });

  it("the sampler doesn't start a video: series for a Bongsu upload", async () => {
    await publish();
    manualUpload();
    const first = await sample(at(600));
    expect(first.sampled.sort()).toEqual([KEY, `video:${MANUAL}`].sort());
    expect(await seriesOf("video:vid-1")).toBe(0);
    expect(await seriesOf(KEY)).toBe(1);
    // the item's series grows
    await sample(at(600 + 7 * HOUR));
    expect(await seriesOf(KEY)).toBe(2);
    expect(await seriesOf("video:vid-1")).toBe(0);
    const row = await env.DB.prepare(
      "SELECT account, platform, media_id, workspace_id FROM post_metrics WHERE item_key = ?1",
    )
      .bind(KEY)
      .first();
    expect(row).toEqual({ account: "main", platform: "youtube", media_id: "vid-1", workspace_id: "default" });
  });

  it("channel stats and the performance list show it once, marked Bongsu", async () => {
    await publish();
    manualUpload();
    await sample(at(600));
    await sample(at(600 + 7 * HOUR));
    // a series an older version started for the same video must not show it twice
    await env.DB.prepare(
      "INSERT INTO post_metrics (item_key, account, platform, media_id, taken_at, views, follows, workspace_id) VALUES ('video:vid-1', 'main', 'youtube', 'vid-1', ?1, 9, 1, 'default')",
    )
      .bind(DUE + 60)
      .run();
    const overview = await get<{ recent: { key: string; source?: string; href: string }[] }>("/app-api/stats");
    expect(overview.status).toBe(200);
    const keys = overview.json.recent.map((r) => r.key);
    expect(keys).toContain(KEY);
    expect(keys).not.toContain("video:vid-1");
    expect(overview.json.recent.find((r) => r.key === KEY)).toMatchObject({
      source: "bongsu",
      href: `#/item/${encodeURIComponent(KEY)}/results`,
    });
    expect(overview.json.recent.find((r) => r.key === `video:${MANUAL}`)?.source).toBe("elsewhere");
    const ch = await get<{ brought: { key: string; source?: string; href: string }[] }>(
      "/app-api/stats/channel?account=main&days=7",
    );
    expect(ch.status).toBe(200);
    expect(ch.json.brought.map((b) => b.key)).not.toContain("video:vid-1");
    expect(ch.json.brought.find((b) => b.key === KEY)).toMatchObject({
      source: "bongsu",
      href: `#/item/${encodeURIComponent(KEY)}/results`,
    });
  });

  it("the calendar shows the item, not a second entry", async () => {
    await publish();
    manualUpload();
    const day = zoneDate(T, "Asia/Seoul");
    const from = zoneDate(at(-2 * 86400), "Asia/Seoul");
    const cal = await calendar(e, w.fetch, { id: "default", tz: "Asia/Seoul" }, from, day, true);
    expect(cal.warnings).toEqual([]);
    const mine = cal.events.filter((x) => x.key === KEY || x.url?.endsWith("/vid-1"));
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ key: KEY, status: "posted" });
    expect(cal.events.some((x) => x.url?.endsWith(`/${MANUAL}`))).toBe(true);
  });

  it("a manual upload keeps its video: page and series; a Bongsu upload's page points to the item", async () => {
    await publish();
    manualUpload();
    await sample(at(600));
    await channelUploads(e, w.fetch, { id: "main" } as never, true).catch(() => {});
    const manual = await get(`/app-api/video/metrics?video=${MANUAL}`);
    expect(manual.status).toBe(200);
    expect(manual.json.item).toMatchObject({ key: `video:${MANUAL}`, platform: "youtube", account: "main" });
    expect(manual.json.samples).toHaveLength(1);
    const mapped = await get("/app-api/video/metrics?video=vid-1");
    expect(mapped).toEqual({ status: 200, json: { item_key: KEY } });
  });

  it("moving a Bongsu upload's release date moves the item and never calls YouTube", async () => {
    await uploadAhead();
    const asked = Math.floor(Date.now() / 1000) + 10 * 86400;
    expect((await latestApprovals(env.DB, [KEY])).get(KEY)?.dueAt).toBe(DUE);
    const r = await moveRelease(e, w.fetch, {
      workspaceId: "default",
      videoId: "vid-1",
      at: asked,
      nowS: Math.floor(Date.now() / 1000),
      tz: "Asia/Seoul",
      actor: { kind: "owner", userId: null },
    });
    expect(r).toMatchObject({
      video: "vid-1",
      account: "main",
      due_at: new Date(asked * 1000).toISOString().replace(".000", ""),
    });
    expect(await env.DB.prepare("SELECT due_at FROM plan_items WHERE item_key = ?1").bind(KEY).first("due_at")).toBe(
      asked,
    );
    // the approval was for the old time: it needs approving again
    const approved = (await latestApprovals(env.DB, [KEY])).get(KEY);
    expect(approved?.dueAt).toBe(DUE);
    expect(approved?.dueAt).not.toBe(asked);
    expect(w.ytUpdates).toEqual([]);
  });

  it("a release move into an hour another item of the channel holds is a 409 and changes nothing", async () => {
    await uploadAhead();
    const asked = Math.floor(Date.now() / 1000) + 10 * 86400;
    await env.DB.prepare(
      "INSERT INTO plan_items (item_key, format, account, folder, name, due_at, options, hold, sort, created_at, updated_at, workspace_id) VALUES ('reel:OTHER/x', 'video', 'main', 'OTHER', 'x', ?1, '{}', 0, 2, 0, 0, 'default')",
    )
      .bind(asked + 600)
      .run();
    const err = await moveRelease(e, w.fetch, {
      workspaceId: "default",
      videoId: "vid-1",
      at: asked,
      nowS: Math.floor(Date.now() / 1000),
      tz: "Asia/Seoul",
      actor: { kind: "owner", userId: null },
    }).catch((x) => x);
    expect(err).toMatchObject({ reason: "conflict" });
    expect(releaseStatus(err)).toBe(409);
    expect(err.message).toContain("reel:OTHER/x");
    expect(await env.DB.prepare("SELECT due_at FROM plan_items WHERE item_key = ?1").bind(KEY).first("due_at")).toBe(
      DUE,
    );
    expect(w.ytUpdates).toEqual([]);
  });

  it("a release move of a published Bongsu upload is refused, and of an unknown video is missing", async () => {
    await publish();
    const base = {
      workspaceId: "default",
      at: Math.floor(Date.now() / 1000) + 10 * 86400,
      nowS: Math.floor(Date.now() / 1000),
      tz: "Asia/Seoul",
      actor: { kind: "owner", userId: null } as const,
    };
    await expect(moveRelease(e, w.fetch, { ...base, videoId: "vid-1" })).rejects.toMatchObject({
      reason: "not_scheduled",
    });
    await expect(moveRelease(e, w.fetch, { ...base, videoId: "nope" })).rejects.toMatchObject({ reason: "missing" });
    expect(w.ytUpdates).toEqual([]);
  });
});

describe("workspaces", () => {
  it("another workspace's own video job on a channel of the same id doesn't enter this workspace's map", async () => {
    await publish();
    await env.DB.prepare(
      "INSERT INTO workspaces (id, name, created_at) VALUES ('b', 'Workspace B', 0) ON CONFLICT (id) DO NOTHING",
    ).run();
    await env.DB.prepare(
      "INSERT INTO jobs (item_key, kind, account, due_at, state, media_id, dry_run, payload, created_at, updated_at, workspace_id) VALUES ('reel:B/theirs', 'video', 'c_main', 1, 'done', 'vidB-theirs', 0, '{\"username\":\"main\"}', 0, 0, 'b')",
    ).run();
    expect([...(await bongsuVideos(env.DB, ["main"], "default")).keys()]).toEqual(["vid-1"]);
    expect([...(await bongsuVideos(env.DB, ["main"], "b")).entries()]).toEqual([["vidB-theirs", "reel:B/theirs"]]);
  });

  it("another workspace's channel uploads don't map to this workspace's items", async () => {
    await publish();
    await env.DB.prepare(
      "INSERT INTO workspaces (id, name, created_at) VALUES ('b', 'Workspace B', 0) ON CONFLICT (id) DO NOTHING",
    ).run();
    await upsertAccount(
      env.DB,
      { id: "b_tube", workspaceId: "b", platform: "youtube", handle: "b_tube", connectionId: null },
      0,
    );
    // workspace B's channel lists a video with the same id: it isn't the default workspace's upload
    expect((await bongsuVideos(env.DB, ["b_tube"], "b")).size).toBe(0);
    expect((await bongsuVideos(env.DB, ["main", "b_tube"], "b")).size).toBe(0);
  });
});
