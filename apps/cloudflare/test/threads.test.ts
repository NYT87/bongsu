// Threads (issue #25): the approval page's limits, the provider through the tick (text, image, video, carousel,
// replies as comments), its replies and results, and keeping its token alive. The OAuth flow is in connect.test.ts.
import { env } from "cloudflare:workers";
import { resolveItem } from "@bongsu/api/pwa/approve";
import { connectionSecret, listAccounts } from "@bongsu/core/accounts";
import { pasteConnect } from "@bongsu/core/connections";
import type { Env } from "@bongsu/core/env";
import { providerFor } from "@bongsu/core/providers/index";
import { refreshConnections } from "@bongsu/core/providers/refresh";
import { tick } from "@bongsu/core/tick";
import { beforeEach, describe, expect, it } from "vitest";
import { approve, clearPlan, localToUnix, serveLinks, testEnv, World } from "./world";

const KEY = "post:20261020_DEMO/thread";
const DUE = new Date("2026-10-20T09:00:00Z"); // 18:00 in Seoul
const later = (min: number) => new Date(DUE.getTime() + min * 60_000);
let w: World;
let e: Env;
let account = "";

type Media = { name: string; video?: boolean; size?: number };

async function plan(o: { caption: string; comment?: string; comment2?: string; alt?: string; media?: Media[] }) {
  const media = (o.media ?? []).map((m, i) => ({
    driveId: w.drivePut(`UPLOADS/_uploads/${m.name}`, {
      md5: String(i + 1).repeat(32),
      mimeType: m.video ? "video/mp4" : "image/jpeg",
      ...(m.size ? { size: m.size } : { bytes: m.name }),
    }),
    md5: String(i + 1).repeat(32),
  }));
  const format = !media.length ? "text" : media.length > 1 ? "carousel" : o.media?.[0].video ? "video" : "image";
  await env.DB.prepare(
    "INSERT INTO plan_items (item_key, format, account, folder, name, due_at, options, hold, sort, created_at, updated_at, workspace_id, content, media, caption, comment, comment2, alt) VALUES (?1, ?2, ?3, '20261020_DEMO', 'thread', ?4, '{}', 0, 1, 0, 0, 'default', 'db', ?5, ?6, ?7, ?8, ?9)",
  )
    .bind(
      KEY,
      format,
      account,
      await localToUnix("2026-10-20", "18:00"),
      JSON.stringify(media.map((m) => ({ store: "drive", id: m.driveId }))),
      o.caption,
      o.comment ?? null,
      o.comment2 ?? null,
      o.alt ?? null,
    )
    .run();
  return media;
}

async function publish(o: Parameters<typeof plan>[0]) {
  const media = await plan(o);
  await approve(KEY, {
    due: "2026-10-20 18:00",
    caption: o.caption,
    comment: o.comment ?? null,
    comment2: o.comment2 ?? null,
    alt: o.alt ?? null,
    media,
    account,
  });
}
const run = async (...mins: number[]) => {
  for (const m of mins) await tick(e, { fetch: w.fetch, now: later(m) });
};
const job = () =>
  env.DB.prepare("SELECT state, last_error, media_id, permalink FROM jobs WHERE item_key = ?1")
    .bind(KEY)
    .first<{ state: string; last_error: string | null; media_id: string | null; permalink: string | null }>();
const params = (id: string) => w.threadsContainers.get(id)?.params;
const threadsAccount = async () => (await listAccounts(env.DB, { all: true })).find((a) => a.id === account)!;

beforeEach(async () => {
  await clearPlan();
  await env.DB.batch(
    [
      "DELETE FROM jobs",
      "DELETE FROM locks",
      "DELETE FROM accounts WHERE platform = 'threads'",
      "DELETE FROM connections WHERE provider = 'threads'",
    ].map((q) => env.DB.prepare(q)),
  );
  w = new World();
  e = await testEnv(env, { ENCRYPTION_KEY: "an-encryption-key-for-tests" } as Partial<Env>);
  serveLinks(w, e, () => DUE);
  const r = await pasteConnect(e, w.fetch, "threads", "th-token", 0, "default");
  account = r.accounts[0].id;
});

describe("threads approval", () => {
  const problems = async () => (await resolveItem(e, w.fetch, KEY, "Asia/Seoul", "default"))!.problems;

  it("takes an image of 8 MB and refuses a bigger one", async () => {
    await plan({ caption: "A photo", media: [{ name: "big.jpg", size: 8_000_001 }] });
    expect(await problems()).toContain("big.jpg is 8.01 MB; Threads takes images up to 8 MB");
    await clearPlan();
    await plan({ caption: "A photo", media: [{ name: "ok.jpg", size: 8_000_000 }] });
    expect((await problems()).filter((p) => /takes images/.test(p))).toEqual([]);
  });

  it("fails the caption check past 500 characters, counted as readers see them", async () => {
    const { threads } = await import("@bongsu/core/platforms/threads");
    expect(threads.lint("👨‍👩‍👧".repeat(500))).toEqual([{ check: "LENGTH", status: "PASS", detail: "500/500" }]);
    expect(threads.lint("x".repeat(501))[0]).toMatchObject({ status: "FAIL", detail: "501/500" });
  });
});

describe("threads publishing", () => {
  it("posts text: a TEXT container, published once Threads has processed it", async () => {
    await publish({ caption: "Hello from demo_travel" });
    await run(0, 5);
    expect(params("th_c1")).toMatchObject({ media_type: "TEXT", text: "Hello from demo_travel" });
    expect(w.threadsPosts.map((p) => p.container)).toEqual(["th_c1"]);
    expect(await job()).toMatchObject({
      state: "published",
      media_id: "th_p1",
      permalink: "https://www.threads.net/@demo_travel/post/th_p1",
    });
  });

  it("posts an image with its alt text, and a video", async () => {
    await publish({ caption: "A photo", alt: "a beach at dawn", media: [{ name: "beach.jpg" }] });
    await run(0, 5);
    expect(params("th_c1")).toMatchObject({ media_type: "IMAGE", text: "A photo", alt_text: "a beach at dawn" });
    expect(params("th_c1")?.image_url).toMatch(/^https:\/\//);

    await clearPlan();
    await env.DB.prepare("DELETE FROM jobs").run();
    await publish({ caption: "A clip", media: [{ name: "clip.mp4", video: true }] });
    await run(0, 5);
    expect(params("th_c2")).toMatchObject({ media_type: "VIDEO", text: "A clip" });
    expect(params("th_c2")?.alt_text).toBeUndefined();
  });

  it("posts a carousel: the items, then their parent once they're processed, alt texts on the images in order", async () => {
    await publish({
      caption: "Three",
      alt: "first alt\nsecond alt",
      media: [{ name: "one.jpg" }, { name: "clip.mp4", video: true }, { name: "two.jpg" }],
    });
    await run(0, 5, 10);
    expect([1, 2, 3].map((i) => params(`th_c${i}`))).toMatchObject([
      { media_type: "IMAGE", is_carousel_item: "true", alt_text: "first alt" },
      { media_type: "VIDEO", is_carousel_item: "true" },
      { media_type: "IMAGE", is_carousel_item: "true", alt_text: "second alt" },
    ]);
    expect(params("th_c4")).toMatchObject({ media_type: "CAROUSEL", children: "th_c1,th_c2,th_c3", text: "Three" });
    expect(w.threadsPosts.map((p) => p.container)).toEqual(["th_c4"]);
    expect(await job()).toMatchObject({ state: "published" });
  });

  it("waits while the container is in progress", async () => {
    await publish({ caption: "Slow" });
    w.threadsProcessing = 2;
    await run(0, 5, 10);
    expect(w.threadsPosts).toHaveLength(0);
    await run(15);
    expect(w.threadsPosts).toHaveLength(1);
  });

  it("answers the first and second comment as replies to the post", async () => {
    await publish({ caption: "Post", comment: "first", comment2: "second" });
    await run(0, 5, 10, 15, 20);
    expect(w.threadsPosts.map((p) => [p.params.text, p.params.reply_to_id ?? null])).toEqual([
      ["Post", null],
      ["first", "th_p1"],
      ["second", "th_p1"],
    ]);
  });

  it("fails the job with Threads' message when the container errors, publishing nothing", async () => {
    await publish({ caption: "Refused" });
    w.threadsError = "The image format is not supported";
    await run(0, 5);
    expect(w.threadsPosts).toHaveLength(0);
    expect(await job()).toMatchObject({ state: "failed" });
    expect((await job())?.last_error).toMatch(/The image format is not supported/);
  });

  it("posts once when threads_publish's answer is lost", async () => {
    await publish({ caption: "Answer lost" });
    w.threadsLoseAnswer = true;
    await run(0, 5, 10, 15);
    expect(w.threadsPosts).toHaveLength(1);
  });
});

describe("threads replies, results and the connection", () => {
  it("reads the post's replies and answers one", async () => {
    w.threadsPosts.push({ id: "th_p1", container: "th_c0", params: { text: "Post" } });
    w.threadsOthersReplies.set("th_p1", [
      { id: "th_r9", text: "Lovely!", username: "demo_running", timestamp: "2026-10-20T09:10:00+0000" },
    ]);
    const pr = (await providerFor(e, w.fetch, await threadsAccount()))!;
    expect(await pr.comments!("th_p1")).toEqual([
      { id: "th_r9", text: "Lovely!", author: "demo_running", at: "2026-10-20T09:10:00+0000" },
    ]);
    await pr.reply!("th_r9", "Thank you");
    expect(w.threadsPosts.at(-1)?.params).toMatchObject({
      media_type: "TEXT",
      text: "Thank you",
      reply_to_id: "th_r9",
    });
  });

  it("gives the results it has under the metrics' names, null for the rest", async () => {
    w.threadsPosts.push({ id: "th_p1", container: "th_c0", params: { text: "Post" } });
    const pr = (await providerFor(e, w.fetch, await threadsAccount()))!;
    expect(await pr.results!("th_p1", ["views", "reach", "likes", "comments", "saved", "shares", "follows"])).toEqual({
      views: 120,
      reach: null,
      likes: 9,
      comments: 2,
      saved: null,
      shares: 3,
      follows: null,
    });
  });

  it("renews the token weekly and keeps the new one encrypted", async () => {
    const r = await refreshConnections(e, { fetch: w.fetch, now: new Date(DUE.getTime() + 30 * 86400_000) });
    expect(r.failed).toEqual([]);
    const a = await threadsAccount();
    expect(JSON.parse((await connectionSecret(e, a.connection))!).access_token).toBe("th-token-2");
  });

  it("marks the connection broken when the token was revoked", async () => {
    w.threadsRevoked = true;
    await refreshConnections(e, { fetch: w.fetch, now: new Date(DUE.getTime() + 30 * 86400_000) });
    expect(await env.DB.prepare("SELECT status FROM connections WHERE provider = 'threads'").first("status")).toBe(
      "broken",
    );
  });

  it("pasting the token again updates the same profile, and the profile stays inside its workspace", async () => {
    const again = await pasteConnect(e, w.fetch, "threads", JSON.stringify({ access_token: "th-token" }), 1, "default");
    expect(again.accounts).toMatchObject([{ id: account, created: false }]);
    await expect(pasteConnect(e, w.fetch, "threads", "not-a-token", 1, "default")).rejects.toThrow(
      /Invalid OAuth access token/,
    );
    expect(await listAccounts(env.DB, { workspaceId: "other-workspace", all: true })).toEqual([]);
  });
});
