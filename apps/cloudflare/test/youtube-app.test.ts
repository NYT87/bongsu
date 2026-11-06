// The app's routes for YouTube videos: scheduling a draft to a channel, editing its texts and settings.
import { env } from "cloudflare:workers";
import { appRoutes } from "@bongsu/api/pwa/routes";
import type { Verifiers } from "@bongsu/api/pwa/webauthn";
import type { Env } from "@bongsu/core/env";
import { sha256Hex } from "@bongsu/core/formats/approved";
import { beforeEach, describe, expect, it } from "vitest";
import { clearPlan, MD5, testEnv, World } from "./world";

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
const TEXTS = { title: "Demo", translations: { es: { title: "Demostración", description: "Un vídeo de prueba" } } };
let w: World;
let e: Env;
let cookie = "";
let ids: Record<string, string>;

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
const json = async (r: Response) => (await r.json()) as Record<string, unknown>;
const item = async (key: string) =>
  (await (await call(`/app-api/item?key=${encodeURIComponent(key)}`)).json()) as {
    problems: string[];
    approved: { matches: boolean } | null;
    youtube: { texts: unknown; settings: unknown; subtitles: unknown[]; thumbnail: string | null };
  };
const row = (key: string) =>
  env.DB.prepare("SELECT * FROM plan_items WHERE item_key = ?1")
    .bind(key)
    .first<Record<string, string | number | null>>();

async function signUp() {
  await env.DB.prepare("INSERT INTO setup_codes (code_hash, expires_at) VALUES (?1, ?2)")
    .bind(await sha256Hex("CODE-1234"), Math.floor(Date.now() / 1000) + 600)
    .run();
  const o = (await (await post("/app-api/setup/options", { code: "CODE-1234" })).json()) as { challengeId: string };
  await post("/app-api/setup/verify", { challengeId: o.challengeId, response: { id: "cred1" }, name: "t" });
}
async function approveIt(key: string) {
  const o = (await (await post("/app-api/approve/options", { key })).json()) as { challengeId: string };
  return (await post("/app-api/approve/verify", { challengeId: o.challengeId, response: { id: "cred1" } })).json();
}

/** A video draft for the demo channel with a video, Spanish subtitles and a thumbnail. */
async function seedDraft(id = "d_video", extra: { texts?: unknown; payload?: Record<string, unknown> } = {}) {
  ids = {
    clip: w.drivePut("UPLOADS/_uploads/clip.mp4", { md5: MD5, mimeType: "video/mp4" }),
    es: w.drivePut("UPLOADS/_uploads/es.srt", { md5: "b".repeat(32), mimeType: "application/x-subrip" }),
    thumb: w.drivePut("UPLOADS/_uploads/thumbnail.jpg", { md5: "c".repeat(32), mimeType: "image/jpeg" }),
  };
  const media = Object.values(ids).map((i) => ({ store: "drive", id: i }));
  await env.DB.prepare(
    "INSERT INTO drafts (id, kind, account, payload, source, created_by, status, created_at, updated_at, workspace_id, texts) VALUES (?1, 'reel', 'main', ?2, 'api', 'key:k', 'draft', 0, 0, 'default', ?3)",
  )
    .bind(
      id,
      JSON.stringify({ media, ...(extra.payload ?? {}) }),
      extra.texts === undefined ? JSON.stringify(TEXTS) : extra.texts === null ? null : JSON.stringify(extra.texts),
    )
    .run();
}
const schedule = (body: Record<string, unknown> = {}, id = "d_video") =>
  post(`/app-api/drafts/${id}/schedule`, { date: "2026-10-20", time: "18:00", name: "clip", ...body });
const KEY = "reel:drafts/clip";
async function scheduled(body: Record<string, unknown> = {}, draft?: Parameters<typeof seedDraft>[1]) {
  await seedDraft("d_video", draft);
  const r = await schedule(body);
  expect(r.status).toBe(200);
  return ((await r.json()) as { key: string }).key;
}

beforeEach(async () => {
  await env.DB.batch(
    ["passkeys", "sessions", "challenges", "setup_codes", "audit", "drafts", "jobs", "api_keys"].map((t) =>
      env.DB.prepare(`DELETE FROM ${t}`),
    ),
  );
  await clearPlan();
  w = new World();
  e = await testEnv(env, { PUBLIC_URL: "https://bongsu.test", RP_ID: "bongsu.test" } as Partial<Env>);
  await env.DB.prepare("UPDATE accounts SET external_id = 'UCdemo000000000000000000' WHERE id = 'main'").run();
  cookie = "";
  await signUp();
});

describe("scheduling a draft to a YouTube channel", () => {
  it("a video draft schedules to a YouTube channel with its texts and files", async () => {
    const key = await scheduled({ caption: "A description" });
    expect(key).toBe(KEY);
    const r = await row(key);
    expect(r).toMatchObject({ content: "db", format: "video", account: "main", caption: "A description" });
    expect(JSON.parse(String(r?.texts))).toEqual(TEXTS);
    expect(r?.texts_by).toBe("owner@app");
    expect(JSON.parse(String(r?.media))).toEqual(Object.values(ids).map((id) => ({ store: "drive", id })));
    const i = await item(key);
    expect(i.youtube.subtitles).toEqual([{ lang: "es", name: "es.srt" }]);
    expect(i.youtube.thumbnail).toBe("thumbnail.jpg");
    expect(i.problems).toEqual([]);
  });

  it("the body's texts replace the draft's, and checkTexts guards them", async () => {
    const key = await scheduled({ texts: { title: "From the form" } });
    expect(JSON.parse(String((await row(key))?.texts))).toEqual({ title: "From the form" });
    await seedDraft("d_bad");
    const bad = await schedule({ texts: { title: "<b>" }, name: "other" }, "d_bad");
    expect(bad.status).toBe(400);
    expect(await row("reel:drafts/other")).toBeNull();
  });

  it("the draft's settings carry over and the body's override them", async () => {
    const key = await scheduled({ options: { privacy: "unlisted" } }, { payload: { options: { madeForKids: true } } });
    expect(JSON.parse(String((await row(key))?.options))).toEqual({ madeForKids: true, privacy: "unlisted" });
    await seedDraft("d_two", { payload: { options: { category: "10" } } });
    expect((await schedule({ name: "two", time: "19:00" }, "d_two")).status).toBe(200);
    expect(JSON.parse(String((await row("reel:drafts/two"))?.options))).toEqual({ category: "10" });
    await seedDraft("d_three");
    expect((await schedule({ name: "three", time: "20:00", options: { privacy: "private" } }, "d_three")).status).toBe(
      400,
    );
  });

  it("a YouTube draft needs a title only at approval", async () => {
    const key = await scheduled({}, { texts: null });
    expect((await row(key))?.texts).toBeNull();
    expect((await item(key)).problems).toContain("a YouTube video needs a title");
  });

  it("an Instagram account takes no texts, and a photo draft no YouTube channel", async () => {
    await seedDraft();
    expect((await schedule({ account: "demo_travel", caption: "x" })).status).toBe(400);
    await env.DB.prepare("UPDATE drafts SET kind = 'photo', texts = NULL WHERE id = 'd_video'").run();
    expect((await schedule()).status).toBe(400);
  });

  it("the drafts list returns texts and offers the channels", async () => {
    await seedDraft();
    const d = (await json(await call("/app-api/drafts"))) as { accounts: string[]; drafts: { texts: unknown }[] };
    expect(d.drafts[0].texts).toEqual(TEXTS);
    expect(d.accounts).toContain("main");
  });
});

describe("editing a YouTube video in the app", () => {
  it("the app edits a YouTube video's texts and settings", async () => {
    const key = await scheduled();
    expect(
      (await post("/app-api/item/texts", { key, caption: "New description", texts: { title: "New title" } })).status,
    ).toBe(200);
    const r = await row(key);
    expect(r).toMatchObject({ caption: "New description" });
    expect(JSON.parse(String(r?.texts))).toEqual({ title: "New title" });
    const s = await post("/app-api/item/youtube", { key, madeForKids: true, privacy: "unlisted", category: "10" });
    expect(await s.json()).toEqual({
      key,
      settings: { madeForKids: true, privacy: "unlisted", category: "10" },
    });
    // null clears one back to the default
    expect(await (await post("/app-api/item/youtube", { key, privacy: null })).json()).toMatchObject({
      settings: { madeForKids: true, privacy: "public", category: "10" },
    });
    expect((await item(key)).youtube.settings).toEqual({ madeForKids: true, privacy: "public", category: "10" });
  });

  it("a caption edit leaves the texts alone, and a description may be long", async () => {
    const key = await scheduled();
    await post("/app-api/item/texts", { key, caption: "x".repeat(4000) });
    const r = await row(key);
    expect(String(r?.caption).length).toBe(4000);
    expect(JSON.parse(String(r?.texts))).toEqual(TEXTS);
  });

  it("refuses bad texts without changing anything", async () => {
    const key = await scheduled({ caption: "Keep me" });
    const r = await post("/app-api/item/texts", { key, caption: "Changed", texts: { title: "x".repeat(101) } });
    expect(r.status).toBe(400);
    expect((await row(key))?.caption).toBe("Keep me");
  });

  it("editing voids the approval", async () => {
    const key = await scheduled({ caption: "A description" });
    expect(await approveIt(key)).toMatchObject({ approved: true });
    expect((await item(key)).approved).toMatchObject({ matches: true });
    await post("/app-api/item/texts", { key, caption: "A description", texts: { ...TEXTS, title: "Changed" } });
    expect((await item(key)).approved).toMatchObject({ matches: false });
    expect(await approveIt(key)).toMatchObject({ approved: true });
    expect((await item(key)).approved).toMatchObject({ matches: true });
    // settings are shown at approval but, like the location, not part of what it hashes
    await post("/app-api/item/youtube", { key, privacy: "unlisted" });
    expect((await item(key)).approved).toMatchObject({ matches: true });
  });

  it("settings are validated", async () => {
    const key = await scheduled();
    expect((await post("/app-api/item/youtube", { key, privacy: "private" })).status).toBe(400);
    expect((await post("/app-api/item/youtube", { key, madeForKids: "yes" })).status).toBe(400);
    expect((await post("/app-api/item/youtube", { key, category: "abc" })).status).toBe(400);
    expect((await post("/app-api/item/youtube", { key: "reel:nope/x" })).status).toBe(404);
    expect((await row(key))?.options).toBe("{}");
  });

  it("an Instagram item has no YouTube settings", async () => {
    await env.DB.prepare(
      "INSERT INTO plan_items (item_key, format, account, folder, name, due_at, options, hold, sort, created_at, updated_at, workspace_id, content) VALUES ('reel:x/ig', 'video', 'demo_travel', 'x', 'ig', 1, '{}', 0, 1, 0, 0, 'default', 'db')",
    ).run();
    expect((await post("/app-api/item/youtube", { key: "reel:x/ig", privacy: "public" })).status).toBe(400);
  });
});
