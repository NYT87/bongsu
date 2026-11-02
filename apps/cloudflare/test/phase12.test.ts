import { env } from "cloudflare:workers";
import { appRoutes } from "@bongsu/api/pwa/routes";
import type { Verifiers } from "@bongsu/api/pwa/webauthn";
import type { Env } from "@bongsu/core/env";
import { sha256Hex } from "@bongsu/core/formats/approved";
import { tick } from "@bongsu/core/tick";
import { beforeEach, describe, expect, it } from "vitest";
import { approve, clearPlan, igHappyPath, MD5, planItem, seedReel, testEnv, World } from "./world";

const fake: Verifiers = {
  registration: (async () => ({
    verified: true,
    registrationInfo: {
      credential: { id: "cred1", publicKey: new Uint8Array([1, 2, 3]), counter: 0, transports: ["internal"] },
    },
  })) as unknown as Verifiers["registration"],
  authentication: (async () => ({
    verified: true,
    authenticationInfo: { newCounter: 1 },
  })) as unknown as Verifiers["authentication"],
};
let w: World;
let e: Env;
let cookie = "";
async function call(path: string, init: RequestInit = {}) {
  const r = await appRoutes(w.fetch, fake).request(
    `https://bongsu.test${path}`,
    { ...init, headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) } },
    e,
  );
  const set = r.headers.get("Set-Cookie");
  if (set) cookie = set.split(";")[0];
  return r;
}
const post = (path: string, body: unknown = {}) => call(path, { method: "POST", body: JSON.stringify(body) });
async function signUp() {
  await env.DB.prepare("INSERT INTO setup_codes (code_hash, expires_at) VALUES (?1, ?2)")
    .bind(await sha256Hex("CODE-1234"), Math.floor(Date.now() / 1000) + 600)
    .run();
  const o = (await (await post("/app-api/setup/options", { code: "CODE-1234" })).json()) as { challengeId: string };
  await post("/app-api/setup/verify", { challengeId: o.challengeId, response: { id: "cred1" }, name: "t" });
}

beforeEach(async () => {
  await env.DB.batch(
    ["passkeys", "sessions", "challenges", "setup_codes", "audit", "drafts", "jobs"].map((t) =>
      env.DB.prepare(`DELETE FROM ${t}`),
    ),
  );
  await clearPlan();
  w = new World();
  e = await testEnv(env, { PUBLIC_URL: "https://bongsu.test", RP_ID: "bongsu.test" } as Partial<Env>);
  cookie = "";
});

describe("free-slot suggestions", () => {
  it("a clash comes with the account's next free hours, in the message and as data", async () => {
    await signUp();
    const { key } = await seedReel(w, { base: "short1_a", date: "2026-10-30" }); // 18:00
    await planItem({ folder: "vlogs/CONTENT/20260823_LISBON", name: "short2_b", date: "2026-10-30", time: "19:00" });
    await planItem({ folder: "vlogs/CONTENT/20260823_LISBON", name: "short3_c", date: "2026-10-31", time: "20:00" });
    const r = await post("/app-api/item/reschedule", {
      key: "reel:20260823_LISBON/short3_c",
      date: "2026-10-30",
      time: "18:30",
    });
    expect(r.status).toBe(409);
    const j = (await r.json()) as { error: string; suggestions: { date: string; time: string; at: string }[] };
    expect(j.suggestions).toEqual([
      { date: "2026-10-30", time: "20:30", at: "2026-10-30T11:30:00Z" },
      { date: "2026-10-30", time: "21:30", at: "2026-10-30T12:30:00Z" },
      { date: "2026-10-30", time: "22:30", at: "2026-10-30T13:30:00Z" },
      { date: "2026-10-30", time: "23:30", at: "2026-10-30T14:30:00Z" },
    ]); // 19:30 is taken by short2_b
    expect(j.error).toMatch(/free: 2026-10-30 20:30/);
    expect(key).toBeTruthy();
  });
});

describe("Stories", () => {
  it("a draft scheduled as a Story needs no caption, takes no hour, and goes out as STORIES without comments", async () => {
    await signUp();
    await seedReel(w, { base: "short1_reel", date: "2026-10-20" }); // a Reel at 18:00
    const img = w.drivePut("Bongsu app uploads/story.jpg", { md5: "a".repeat(32), mimeType: "image/jpeg" });
    await env.DB.prepare(
      "INSERT INTO drafts (id, kind, account, payload, source, created_by) VALUES ('d_s', 'photo', 'demo_travel', ?1, 'pwa', 'owner')",
    )
      .bind(JSON.stringify({ folder: "20260823_LISBON", name: "story1_sunset", media: [{ store: "drive", id: img }] }))
      .run();
    const s = await post("/app-api/drafts/d_s/schedule", { date: "2026-10-20", time: "18:00", format: "story" }); // same hour as the Reel: fine
    const { key } = (await s.json()) as { key: string };
    expect(key).toBe("post:20260823_LISBON/story1_sunset");
    const item = (await (await call(`/app-api/item?key=${encodeURIComponent(key)}`)).json()) as {
      format: string;
      problems: string[];
      caption: string;
    };
    expect(item).toMatchObject({ format: "story", problems: [], caption: "" });
    const o = (await (await post("/app-api/approve/options", { key })).json()) as { challengeId: string };
    expect(
      await (await post("/app-api/approve/verify", { challengeId: o.challengeId, response: { id: "cred1" } })).json(),
    ).toMatchObject({ approved: true });
    igHappyPath(w);
    for (const m of [1, 6, 11, 16]) await tick(e, { fetch: w.fetch, now: new Date(Date.UTC(2026, 9, 20, 9, m)) });
    const story = w.calls
      .filter((c) => c.slug === "INSTAGRAM_POST_IG_USER_MEDIA")
      .find((c) => c.args.media_type === "STORIES")!;
    expect(story.args).toMatchObject({ media_type: "STORIES" });
    expect(String(story.args.image_url)).toContain(`/m/${img}.jpg`);
    expect(story.args.caption).toBeUndefined();
    expect(await env.DB.prepare("SELECT source FROM posted WHERE item_key = ?1").bind(key).first("source")).toBe(
      "scheduler",
    );
    const comments = w.calls.filter((c) => c.slug === "INSTAGRAM_POST_IG_MEDIA_COMMENTS").map((c) => c.args.message);
    expect(comments).toEqual(["📍 Somewhere. Have you been?"]); // the Reel's only
  });
});

describe("cover frame and location", () => {
  it("the chosen cover goes out as thumb_offset; a location link is read into its place id", async () => {
    await signUp();
    const { key, folder, base } = await seedReel(w, { base: "short1_cov", approve: false });
    const id = w.drivePut(`UPLOADS/${folder}/exports/shorts/instagram/${base}.mp4`, {
      md5: MD5,
      mimeType: "video/mp4",
    });
    expect(await (await post("/app-api/item/cover", { key, ms: 2300 })).json()).toEqual({ key, cover_ms: 2300 });
    expect((await post("/app-api/item/location", { key, location: "nonsense" })).status).toBe(400);
    expect(
      (
        await post("/app-api/item/location", {
          key,
          location: "https://www.instagram.com/explore/locations/987654321/jungmun-beach/",
        })
      ).status,
    ).toBe(200);
    expect(
      JSON.parse(
        (await env.DB.prepare("SELECT options FROM plan_items WHERE item_key = ?1")
          .bind(key)
          .first("options")) as string,
      ),
    ).toMatchObject({ location: "987654321", coverMs: 2300 });
    await approve(key, {
      due: "2026-10-20 18:00",
      caption: "A caption\n\nWhere next?\n\n#travel",
      comment: "📍 Somewhere. Have you been?",
      media: [{ driveId: id, md5: MD5 }],
    });
    igHappyPath(w);
    await tick(e, { fetch: w.fetch, now: new Date(Date.UTC(2026, 9, 20, 9, 1)) });
    expect(w.calls.find((c) => c.slug === "INSTAGRAM_POST_IG_USER_MEDIA")!.args).toMatchObject({
      thumb_offset: 2300,
      location_id: "987654321",
    });
  });
});

describe("the user's own time zone", () => {
  it("shows and takes times in it; the database keeps UTC, so changing it moves nothing", async () => {
    await signUp();
    const key = await planItem({ folder: "vlogs/CONTENT/20260823_LISBON", name: "short1_a", date: "2026-10-30" });
    const stored = await env.DB.prepare("SELECT due_at FROM plan_items WHERE item_key = ?1").bind(key).first("due_at");
    expect(stored).toBe(Date.UTC(2026, 9, 30, 9, 0) / 1000); // 18:00 in Seoul, the workspace's zone

    expect(await (await call("/app-api/me")).json()).toMatchObject({
      timezone: "Asia/Seoul",
      workspaceTimezone: "Asia/Seoul",
    });
    expect((await post("/app-api/me/timezone", { timezone: "Mars/Base" })).status).toBe(400);
    expect(await (await post("/app-api/me/timezone", { timezone: "Europe/Madrid" })).json()).toEqual({
      timezone: "Europe/Madrid",
      workspaceTimezone: "Asia/Seoul",
    });
    // Same instant, shown on the user's clock
    const q = (await (await call("/app-api/queue?days=30")).json()) as { items: { key: string; due: string }[] };
    expect(q.items.find((i) => i.key === key)?.due).toBe("2026-10-30 10:00 Europe/Madrid");
    expect(await env.DB.prepare("SELECT due_at FROM plan_items WHERE item_key = ?1").bind(key).first("due_at")).toBe(
      stored,
    );
    // A time the user enters is on their clock: 20:00 in Madrid (UTC+1 after the change) is 19:00Z
    const r = await post("/app-api/item/reschedule", { key, date: "2026-10-30", time: "20:00" });
    expect(await r.json()).toMatchObject({ due: "2026-10-30 20:00 Europe/Madrid", due_at: "2026-10-30T19:00:00Z" });
    // Back to the workspace's
    await post("/app-api/me/timezone", { timezone: null });
    expect(await (await call("/app-api/me")).json()).toMatchObject({ timezone: "Asia/Seoul" });
  });
});
