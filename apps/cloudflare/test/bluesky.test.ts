// Bluesky (docs/superpowers/specs/2026-11-25-bluesky-design.md): the approval page, the provider and the tick.
import { env } from "cloudflare:workers";
import { resolveItem } from "@bongsu/api/pwa/approve";
import { upsertAccount, upsertConnection } from "@bongsu/core/accounts";
import { pasteConnect } from "@bongsu/core/connections";
import type { Env } from "@bongsu/core/env";
import { refreshConnections } from "@bongsu/core/providers/refresh";
import { tick } from "@bongsu/core/tick";
import { beforeEach, describe, expect, it } from "vitest";
import { approve, clearPlan, localToUnix, serveLinks, testEnv, World } from "./world";

const KEY = "post:20261020_DEMO/photo";

async function seedAccount() {
  await upsertConnection(
    env.DB,
    {
      workspaceId: "default",
      id: "c_demo_bluesky",
      provider: "bluesky-atproto",
      kind: "service",
      secretName: "UNUSED",
    },
    0,
  );
  await upsertAccount(
    env.DB,
    {
      workspaceId: "default",
      id: "demo_bluesky",
      platform: "bluesky",
      handle: "demo_travel.bsky.social",
      externalId: "did:plc:demotravel0000000000000",
      connectionId: "c_demo_bluesky",
    },
    0,
  );
}

/** A draft-made image post with one image in the Drive store of the given size. */
async function seedImagePost(w: World, size: number) {
  const id = w.drivePut("UPLOADS/_uploads/photo.jpg", { md5: "a".repeat(32), mimeType: "image/jpeg", size });
  await env.DB.prepare(
    "INSERT INTO plan_items (item_key, format, account, folder, name, due_at, options, hold, sort, created_at, updated_at, workspace_id, content, media, caption) VALUES (?1, 'image', 'demo_bluesky', '20261020_DEMO', 'photo', ?2, '{}', 0, 1, 0, 0, 'default', 'db', ?3, 'A photo')",
  )
    .bind(KEY, await localToUnix("2026-10-20", "18:00"), JSON.stringify([{ store: "drive", id }]))
    .run();
}

const problems = async (w: World) =>
  (await resolveItem(await testEnv(env), w.fetch, KEY, "Asia/Seoul", "default"))!.problems;

describe("bluesky approval", () => {
  beforeEach(async () => {
    await clearPlan();
    await env.DB.batch(
      [
        "DELETE FROM accounts WHERE platform = 'bluesky'",
        "DELETE FROM connections WHERE provider = 'bluesky-atproto'",
      ].map((q) => env.DB.prepare(q)),
    );
    await seedAccount();
  });

  it("takes an image of exactly 1 MB", async () => {
    const w = new World();
    await seedImagePost(w, 1_000_000);
    expect((await problems(w)).filter((p) => /takes images/.test(p))).toEqual([]);
  });

  it("refuses an image over 1 MB", async () => {
    const w = new World();
    await seedImagePost(w, 1_000_001);
    expect(await problems(w)).toContain("photo.jpg is 1.01 MB; Bluesky takes images up to 1 MB");
  });
});

// ---- the provider, through the tick and the connect flow

const PASTE = "demo_travel.bsky.social:aaaa-bbbb-cccc-dddd";
const DUE = new Date("2026-10-20T09:00:00Z"); // 18:00 in Seoul
const later = (min: number) => new Date(DUE.getTime() + min * 60_000);
let w: World;
let e: Env;
let account = "";

async function connect() {
  const r = await pasteConnect(e, w.fetch, "bluesky-atproto", PASTE, 0, "default");
  account = r.accounts[0].id;
}

async function publish(o: { caption: string; comment?: string; comment2?: string; alt?: string; images?: string[] }) {
  const media = (o.images ?? []).map((name, i) => ({
    driveId: w.drivePut(`UPLOADS/_uploads/${name}`, {
      md5: String(i + 1).repeat(32),
      mimeType: "image/jpeg",
      bytes: name,
    }),
    md5: String(i + 1).repeat(32),
  }));
  await env.DB.prepare(
    "INSERT INTO plan_items (item_key, format, account, folder, name, due_at, options, hold, sort, created_at, updated_at, workspace_id, content, media, caption, comment, comment2, alt) VALUES (?1, ?2, ?3, '20261020_DEMO', 'photo', ?4, '{}', 0, 1, 0, 0, 'default', 'db', ?5, ?6, ?7, ?8, ?9)",
  )
    .bind(
      KEY,
      media.length ? "image" : "text",
      account,
      await localToUnix("2026-10-20", "18:00"),
      JSON.stringify(media.map((m) => ({ store: "drive", id: m.driveId }))),
      o.caption,
      o.comment ?? null,
      o.comment2 ?? null,
      o.alt ?? null,
    )
    .run();
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
const jobRow = () =>
  env.DB.prepare("SELECT state, last_error FROM jobs WHERE item_key = ?1")
    .bind(KEY)
    .first<{ state: string; last_error: string | null }>();

describe("bluesky provider", () => {
  beforeEach(async () => {
    await clearPlan();
    await env.DB.batch(
      [
        "DELETE FROM jobs",
        "DELETE FROM locks",
        "DELETE FROM accounts WHERE platform = 'bluesky'",
        "DELETE FROM connections WHERE provider = 'bluesky-atproto'",
      ].map((q) => env.DB.prepare(q)),
    );
    w = new World();
    e = await testEnv(env);
    serveLinks(w, e, () => DUE);
    await connect();
  });

  it("posts text without an embed", async () => {
    await publish({ caption: "Hello from demo_travel" });
    await run(0);
    expect(w.bskyRecords).toHaveLength(1);
    const rec = w.bskyRecords[0].body;
    expect(rec).toMatchObject({ collection: "app.bsky.feed.post", record: { text: "Hello from demo_travel" } });
    expect(rec.record.embed).toBeUndefined();
    expect(await jobRow()).toMatchObject({ state: "published" });
    const job = await env.DB.prepare("SELECT permalink, media_id FROM jobs WHERE item_key = ?1").bind(KEY).first();
    expect(job).toEqual({
      permalink: "https://bsky.app/profile/did:plc:demotravel0000000000000/post/" + w.bskyRecords[0].rkey,
      media_id: "at://did:plc:demotravel0000000000000/app.bsky.feed.post/" + w.bskyRecords[0].rkey,
    });
  });

  it("posts two images with their alt texts in order, and links as facets", async () => {
    await publish({
      caption: "Look https://example.com/a",
      images: ["one.jpg", "two.jpg"],
      alt: "first alt\nsecond alt",
    });
    await run(0);
    const rec = w.bskyRecords[0].body.record;
    expect(w.bskyBlobs).toEqual([
      { type: "image/jpeg", bytes: 7 },
      { type: "image/jpeg", bytes: 7 },
    ]);
    expect(rec.embed.$type).toBe("app.bsky.embed.images");
    expect(rec.embed.images.map((i: { alt: string }) => i.alt)).toEqual(["first alt", "second alt"]);
    expect(rec.embed.images[0].image.ref.$link).toBe("bafkblob1");
    expect(rec.facets).toEqual([
      {
        index: { byteStart: 5, byteEnd: 26 },
        features: [{ $type: "app.bsky.richtext.facet#link", uri: "https://example.com/a" }],
      },
    ]);
  });

  it("answers the first and second comment as replies to the post", async () => {
    await publish({ caption: "Post", comment: "first", comment2: "second" });
    await run(0, 5, 10, 15);
    expect(w.bskyRecords).toHaveLength(3);
    const post = w.bskyRecords[0];
    const ref = { uri: `at://did:plc:demotravel0000000000000/app.bsky.feed.post/${post.rkey}`, cid: post.cid };
    for (const [i, text] of [
      [1, "first"],
      [2, "second"],
    ] as const) {
      expect(w.bskyRecords[i].body.record).toMatchObject({ text, reply: { root: ref, parent: ref } });
    }
  });

  it("retries after a 429 and publishes exactly one record", async () => {
    await publish({ caption: "Rate limited once" });
    w.bskyRateLimit = true;
    await run(0, 5);
    expect(w.bskyRecords).toHaveLength(1);
    expect(await jobRow()).toMatchObject({ state: "published" });
  });

  it("fails the job with Bluesky's message when it refuses the post, without a second record", async () => {
    await publish({ caption: "Refused" });
    w.bskyReject = "Record text is too long";
    await run(0, 5, 10);
    expect(w.bskyRecords).toHaveLength(0);
    expect(await jobRow()).toMatchObject({ state: "failed" });
    expect((await jobRow())?.last_error).toMatch(/Record text is too long/);
  });

  it("connects by pasting handle:app-password, and pasting again updates the same account", async () => {
    const count = (t: string) =>
      env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE ${t === "accounts" ? "platform" : "provider"} = ?1`)
        .bind(t === "accounts" ? "bluesky" : "bluesky-atproto")
        .first<number>("n");
    expect(await count("connections")).toBe(1);
    await expect(
      pasteConnect(e, w.fetch, "bluesky-atproto", "demo_travel.bsky.social:wrong-password-here", 0, "default"),
    ).rejects.toThrow(/password/i);
    await expect(pasteConnect(e, w.fetch, "bluesky-atproto", "nonsense", 0, "default")).rejects.toThrow(
      "paste the handle and an app password as handle:app-password",
    );
    expect(await count("connections")).toBe(1);
    const again = await pasteConnect(e, w.fetch, "bluesky-atproto", `@${PASTE}`, 1, "default");
    expect(again.accounts).toMatchObject([{ id: account, created: false }]);
    expect(await count("accounts")).toBe(1);
    expect(await count("connections")).toBe(1);
    const row = await env.DB.prepare("SELECT external_id, handle FROM accounts WHERE id = ?1").bind(account).first();
    expect(row).toEqual({ external_id: "did:plc:demotravel0000000000000", handle: "demo_travel.bsky.social" });
  });

  it("marks the connection broken when the app password was revoked", async () => {
    w.bskyRevoked = true;
    const r = await refreshConnections(e, { fetch: w.fetch, now: new Date(DUE.getTime() + 30 * 86400_000) });
    expect(r.failed.some((x) => x.includes("bluesky"))).toBe(true);
    const c = await env.DB.prepare("SELECT status FROM connections WHERE provider = 'bluesky-atproto'").first<string>(
      "status",
    );
    expect(c).toBe("broken");
  });

  it("keeps the connection inside its workspace", async () => {
    const { listAccounts } = await import("@bongsu/core/accounts");
    expect(
      (await listAccounts(env.DB, { workspaceId: "default", all: true })).some((a) => a.platform === "bluesky"),
    ).toBe(true);
    expect(await listAccounts(env.DB, { workspaceId: "other-workspace", all: true })).toEqual([]);
  });

  it("posts once when createRecord's answer is lost", async () => {
    await publish({ caption: "Answer lost" });
    w.bskyLoseAnswer = true;
    await run(0, 5, 10);
    expect(w.bskyRecords).toHaveLength(1);
    expect(["published", "done"]).toContain((await jobRow())?.state);
  });

  it("creates nothing while the post is only started (the write belongs to the guarded publishing call)", async () => {
    const { BlueskyProvider } = await import("@bongsu/core/providers/bluesky");
    const pr = new BlueskyProvider({ handle: "demo_travel.bsky.social", password: "aaaa-bbbb-cccc-dddd" }, w.fetch);
    const step = await pr.start({ format: "text", caption: "hi", alts: [], media: [], options: {} });
    expect(step.state).toBe("ready");
    expect(w.bskyRecords).toHaveLength(0);
  });

  it("refuses a video instead of dropping it", async () => {
    const { BlueskyProvider } = await import("@bongsu/core/providers/bluesky");
    const pr = new BlueskyProvider({ handle: "demo_travel.bsky.social", password: "aaaa-bbbb-cccc-dddd" }, w.fetch);
    const step = await pr.start({
      format: "image",
      caption: "hi",
      alts: [],
      media: [{ id: "v", url: "https://x.test/v", video: true, name: "clip.mp4", checksum: "c" }],
      options: {},
    });
    expect(step.state).toBe("failed");
  });

  it("takes a caption of 40 family emoji (320 UTF-16 units, 40 characters) from the agent write path", async () => {
    const { writeTexts } = await import("@bongsu/core/data");
    await publish({ caption: "x" });
    await writeTexts(env.DB, { item_key: KEY, format: "image" }, { caption: "👨‍👩‍👧".repeat(40) }, "test", 0, 300);
  });
});

describe("bluesky approval of videos", () => {
  beforeEach(async () => {
    await clearPlan();
    await env.DB.batch(
      [
        "DELETE FROM accounts WHERE platform = 'bluesky'",
        "DELETE FROM connections WHERE provider = 'bluesky-atproto'",
      ].map((q) => env.DB.prepare(q)),
    );
    await seedAccount();
  });

  it("refuses a video file", async () => {
    const w = new World();
    const id = w.drivePut("UPLOADS/_uploads/clip.mp4", { md5: "b".repeat(32), mimeType: "video/mp4", size: 10 });
    await env.DB.prepare(
      "INSERT INTO plan_items (item_key, format, account, folder, name, due_at, options, hold, sort, created_at, updated_at, workspace_id, content, media, caption) VALUES (?1, 'image', 'demo_bluesky', '20261020_DEMO', 'photo', ?2, '{}', 0, 1, 0, 0, 'default', 'db', ?3, 'A clip')",
    )
      .bind(KEY, await localToUnix("2026-10-20", "18:00"), JSON.stringify([{ store: "drive", id }]))
      .run();
    expect(await problems(w)).toContain("Bluesky can't post video: remove clip.mp4");
  });
});
