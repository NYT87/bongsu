// A synthetic week (fixtures/week.json) through the real tick: Reels through Composio, a carousel, a Story and a photo
// through instagram-graph, a Shorts comment through YouTube, and the ways a post is held back (not approved, changed
// after approval, on hold). It replaces the golden fixtures with real data removed before the first commit: everything
// here is made up, and the fixture says what should happen to each post.
import { env } from "cloudflare:workers";
import { keyClass, makeKey } from "@bongsu/core/data";
import { commentText } from "@bongsu/core/formats/texts";
import { tick } from "@bongsu/core/tick";
import { beforeEach, describe, expect, it } from "vitest";
import week from "./fixtures/week.json";
import { approve, approveShort, clearPlan, connectGraph, igHappyPath, localToUnix, testEnv, World } from "./world";

interface FixtureItem {
  name: string;
  account: string;
  format?: string;
  date: string;
  time: string;
  caption?: string;
  comment?: string;
  alt?: string;
  options?: Record<string, unknown>;
  media: { id: string; mime: string }[];
  approve: boolean;
  hold?: boolean;
  editAfterApproval?: { caption: string };
  expect: { state: string | null; posted: boolean; calls?: "composio" | "graph"; jobKind?: string; error?: string };
}

const FOLDER = "demo/CONTENT/20261019_WEEK";
const MD5 = "f".repeat(32);
let w: World;

beforeEach(async () => {
  await clearPlan();
  await env.DB.batch(["DELETE FROM jobs", "DELETE FROM locks", "DELETE FROM audit"].map((s) => env.DB.prepare(s)));
  w = new World();
});

/** A post as the fixture describes it: planned in the database (texts and media references), approved if asked. */
async function plan(i: FixtureItem) {
  const format = i.format ?? null;
  const key = makeKey(keyClass(format as never), FOLDER, i.name);
  for (const m of i.media) w.drive.set(m.id, { md5: MD5, mimeType: m.mime });
  await env.DB.prepare(
    `INSERT INTO plan_items (item_key, account, folder, name, format, options, due_at, hold, content, caption, comment,
       alt, media, workspace_id, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'db', ?9, ?10, ?11, ?12, 'default', 0, 0)`,
  )
    .bind(
      key,
      i.account,
      FOLDER,
      i.name,
      format,
      JSON.stringify(i.options ?? {}),
      await localToUnix(i.date, i.time),
      i.hold ? 1 : 0,
      i.caption ?? null,
      i.comment ?? null,
      i.alt ?? null,
      JSON.stringify(i.media.map((m) => ({ store: "drive", id: m.id }))),
    )
    .run();
  if (i.approve) {
    const story = format === "story";
    const caption = story ? "" : (i.caption ?? "");
    await approve(key, {
      due: `${i.date} ${i.time}`,
      caption,
      comment: story ? null : commentText(caption, i.comment ?? null),
      alt: i.alt ?? null,
      media: i.media.map((m) => ({ driveId: m.id, md5: MD5 })),
    });
  }
  if (i.editAfterApproval)
    await env.DB.prepare("UPDATE plan_items SET caption = ?1 WHERE item_key = ?2")
      .bind(i.editAfterApproval.caption, key)
      .run();
  return key;
}

describe("a synthetic week", () => {
  it("every post ends as the fixture says", async () => {
    const e = await testEnv(env);
    await connectGraph(); // demo_cycling through instagram-graph; demo_travel stays on Composio
    igHappyPath(w);
    const items = week.items as FixtureItem[];
    const keys = new Map<string, string>();
    for (const i of items) keys.set(i.name, await plan(i));
    for (const s of week.shorts) {
      await env.DB.prepare(
        "INSERT INTO shorts_comments (video_id, channel, file, label, sort, text, created_at, workspace_id) VALUES (?1, ?2, '', ?1, 1, ?3, 0, 'default')",
      )
        .bind(s.video, s.channel, s.text)
        .run();
      await approveShort(s.video, s.text, s.channel);
      w.ytPrivacy.set(s.video, s.privacy);
    }

    // the cron's runs around each post's time: queued and started, processed, published, comments and record
    const times = [...new Set(await Promise.all(items.map((i) => localToUnix(i.date, i.time))))].sort();
    for (const t of times)
      for (const after of [1, 6, 11, 16])
        await tick(e, { fetch: w.fetch, now: new Date(((t as number) + after * 60) * 1000) });
    await tick(e, { fetch: w.fetch, now: new Date("2026-10-19T09:30:00Z") }, "shorts");

    for (const i of items) {
      const key = keys.get(i.name)!;
      const job = await env.DB.prepare("SELECT kind, state, last_error FROM jobs WHERE item_key = ?1")
        .bind(key)
        .first<{ kind: string; state: string; last_error: string | null }>();
      const posted = await env.DB.prepare("SELECT media_id FROM posted WHERE item_key = ?1")
        .bind(key)
        .first<{ media_id: string }>();
      const what = `${i.name}: ${JSON.stringify(job)}`;
      expect(job?.state ?? null, what).toBe(i.expect.state);
      expect(!!posted, what).toBe(i.expect.posted);
      if (i.expect.jobKind) expect(job?.kind, what).toBe(i.expect.jobKind);
      if (i.expect.error) expect(job?.last_error ?? "", what).toContain(i.expect.error);
      // which way it went out: the Composio fake numbers media "media-…", Instagram's API fake "gmedia-…"
      if (i.expect.calls === "composio") expect(posted?.media_id, what).toMatch(/^media-/);
      if (i.expect.calls === "graph") expect(posted?.media_id, what).toMatch(/^gmedia-/);
    }

    // the photo kept its location; the carousel's alt texts went to its images
    const creates = w.graph.filter((g) => g.path === "/17841400000000003/media").map((g) => g.params);
    expect(creates).toContainEqual(
      expect.objectContaining({ image_url: expect.any(String), location_id: "123456", alt_text: "A bowl of noodles" }),
    );
    expect(creates.filter((p) => p.is_carousel_item).map((p) => p.alt_text)).toEqual([
      "A road climbing a hill",
      "A bike against a wall",
    ]);
    expect(creates).toContainEqual(expect.objectContaining({ media_type: "STORIES" }));

    for (const s of week.shorts) {
      const done = await env.DB.prepare("SELECT 1 AS ok FROM shorts_commented WHERE video_id = ?1")
        .bind(s.video)
        .first();
      expect(done ? "commented" : "waiting", s.video).toBe(s.expect);
    }
    expect(w.ytComments.map((c) => c.text)).toEqual(["Full ride on the channel."]);
  });
});
