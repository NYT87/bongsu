// Phase 14: the texts live only in D1. The scheduler posts its own copy and reads nothing from the repo; agents can set
// the texts directly (plan_add / plan_update / shorts_add), and a repo item's are copied there by an importer.
import { env, exports } from "cloudflare:workers";
import { sha256Hex } from "@bongsu/core/formats/approved";
import { tick } from "@bongsu/core/tick";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { approve, approveShort, clearPlan, igHappyPath, MD5, planItem, seedReel, testEnv, World } from "./world";

const KEY = "bongsu_allallallallallallallallal";
const AT = new Date("2026-10-20T09:32:00Z"); // 18:32 KST
let w: World;
let hosts: string[];
const origFetch = globalThis.fetch;
const req = (path: string, body?: object) =>
  exports.default.fetch(`https://scheduler.test${path}`, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
const tracked: typeof fetch = (input, init) => {
  hosts.push(new URL(new Request(input as RequestInfo, init).url).hostname);
  return w.fetch(input, init);
};

beforeEach(async () => {
  await env.DB.batch(
    ["api_keys", "audit", "rate_limits", "jobs", "locks"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)),
  );
  await env.DB.prepare("INSERT INTO api_keys (id, name, key_hash, scopes) VALUES ('k_all', 'test', ?1, ?2)")
    .bind(await sha256Hex(KEY), JSON.stringify(["read", "draft", "pause", "plan"]))
    .run();
  await clearPlan();
  w = new World();
  hosts = [];
  globalThis.fetch = w.fetch;
});
afterEach(() => {
  globalThis.fetch = origFetch;
});

describe("texts in the database only", () => {
  it("publishing reads nothing from GitLab: the caption and comments come from the item's own copy", async () => {
    await seedReel(w, { comment2: "Second" });
    igHappyPath(w);
    const e = await testEnv(env);
    for (let i = 0; i < 3; i++) await tick(e, { fetch: tracked, now: new Date(AT.getTime() + i * 5 * 60_000) });
    expect(w.calls.find((c) => c.slug === "INSTAGRAM_POST_IG_USER_MEDIA")!.args.caption).toBe(
      "A caption\n\nWhere next?\n\n#travel",
    );
    expect(w.calls.filter((c) => c.slug === "INSTAGRAM_POST_IG_MEDIA_COMMENTS").map((c) => c.args.message)).toEqual([
      "📍 Somewhere. Have you been?",
      "Second",
    ]);
    expect(hosts).not.toContain("gitlab.com");
  });

  it("a repo item whose texts were never copied is refused, saying how to copy them", async () => {
    const key = await planItem({ folder: "vlogs/CONTENT/20260823_LISBON", name: "short2_y", time: "18:00" });
    w.drive.set("drive_y", { md5: MD5, mimeType: "video/mp4" });
    await approve(key, {
      due: "2026-10-20 18:00",
      caption: "A caption",
      comment: null,
      media: [{ driveId: "drive_y", md5: MD5 }],
    });
    await tick(await testEnv(env), { fetch: w.fetch, now: AT });
    const job = await env.DB.prepare("SELECT state, last_error FROM jobs").first<{
      state: string;
      last_error: string;
    }>();
    expect(job).toMatchObject({
      state: "refused",
      last_error: `no caption in the scheduler: add one in the app or with \`bongsu texts set ${key}\``,
    });
    const item = (await (await req(`/v1/items/${encodeURIComponent(key)}`)).json()) as {
      texts_source: { by: string | null; repo_files: { caption: string } };
    };
    expect(item.texts_source).toMatchObject({
      by: null,
      repo_files: { caption: "channels/vlogs/CONTENT/20260823_LISBON/shorts/instagram/short2_y.txt" },
    });
  });

  it("an agent sets the texts with plan_add and plan_update; they're what gets posted", async () => {
    const add = {
      kind: "post",
      account: "demo_travel",
      folder: "vlogs/CONTENT/20260823_LISBON",
      name: "posts/photo1_sea",
      date: "2026-11-01",
      time: "17:00",
      caption: "The sea at Lisbon\n\nBeen?",
      comment: "📍 Hamdeok",
      alt: "01\tBlue water",
    };
    expect(await (await req("/v1/plan", add)).json()).toEqual({
      key: "post:20260823_LISBON/photo1_sea",
      added: true,
      due: "2026-11-01 17:00 Asia/Seoul",
      due_at: "2026-11-01T08:00:00Z",
      texts: ["caption", "comment", "alt"],
    });
    let row = await env.DB.prepare(
      "SELECT caption, comment, comment2, alt, texts_by FROM plan_items WHERE item_key = 'post:20260823_LISBON/photo1_sea'",
    ).first();
    expect(row).toEqual({
      caption: "The sea at Lisbon\n\nBeen?",
      comment: "📍 Hamdeok",
      comment2: null,
      alt: "01\tBlue water",
      texts_by: "key:k_all",
    });

    const up = (await (
      await req("/v1/plan/update", { key: "post:20260823_LISBON/photo1_sea", comment2: "Music: Autumn Sky" })
    ).json()) as { texts: string[] };
    expect(up.texts).toEqual(["comment2"]);
    row = await env.DB.prepare(
      "SELECT caption, comment2 FROM plan_items WHERE item_key = 'post:20260823_LISBON/photo1_sea'",
    ).first();
    expect(row).toEqual({ caption: "The sea at Lisbon\n\nBeen?", comment2: "Music: Autumn Sky" }); // the others untouched

    const item = (await (await req("/v1/items/post%3A20260823_LISBON%2Fphoto1_sea")).json()) as Record<string, unknown>;
    expect(item).toMatchObject({
      caption: "The sea at Lisbon\n\nBeen?",
      comment: "📍 Hamdeok",
      comment2: "Music: Autumn Sky",
      alt: ["Blue water"],
    });

    const { key } = await seedReel(w);
    expect((await req("/v1/plan/update", { key, alt: "x" })).status).toBe(400); // a Reel has no alt texts
    expect((await req("/v1/plan/update", { key, caption: "x".repeat(2201) })).status).toBe(400);
    const noted = (await (await req("/v1/plan/update", { key, caption: "New words" })).json()) as { note: string };
    expect(noted.note).toMatch(/approve again/); // it was approved
    await env.DB.prepare(
      "INSERT INTO posted (item_key, account, published_at) VALUES (?1, 'demo_travel', unixepoch('2026-10-20 09:00'))",
    )
      .bind(key)
      .run();
    expect((await req("/v1/plan/update", { key, caption: "Too late" })).status).toBe(409);
  });

  it("a Shorts comment: its text from shorts_add (approved by the owner), or refused until an importer copies it", async () => {
    expect(
      await (
        await req("/v1/shorts", {
          video_id: "vidPUBLIC01",
          channel: "main",
          file: "channels/main/c1.comment.txt",
          text: "Full video: https://youtu.be/x",
        })
      ).json(),
    ).toEqual({ video_id: "vidPUBLIC01", added: true, note: expect.stringMatching(/owner approves/) });
    const r = (await (
      await req("/v1/shorts", { video_id: "vidPUBLIC02", channel: "main", file: "channels/main/c2.comment.txt" })
    ).json()) as { note: string };
    expect(r.note).toMatch(/bongsu texts set, or the app/);
    await approveShort("vidPUBLIC01", "Full video: https://youtu.be/x");
    w.ytPrivacy.set("vidPUBLIC01", "public").set("vidPUBLIC02", "public");
    await tick(await testEnv(env), { fetch: tracked, now: AT }, "shorts");
    expect(w.ytComments).toEqual([{ video: "vidPUBLIC01", text: "Full video: https://youtu.be/x" }]);
    const refused = await env.DB.prepare(
      "SELECT state, last_error FROM jobs WHERE item_key = 'comment:vidPUBLIC02'",
    ).first<{ state: string; last_error: string }>();
    expect(refused!.state).toBe("refused");
    expect(refused!.last_error).toMatch(
      /no comment text in the scheduler: add one in the app or with `bongsu texts set <key> --comment`/,
    );
    expect(hosts).not.toContain("gitlab.com");
  });
});
