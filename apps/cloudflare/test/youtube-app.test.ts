// The app's routes for YouTube videos: scheduling a draft to a channel, editing its texts and settings.
import { env } from "cloudflare:workers";
import { appRoutes } from "@bongsu/api/pwa/routes";
import type { Verifiers } from "@bongsu/api/pwa/webauthn";
import type { Env } from "@bongsu/core/env";
import { sha256Hex } from "@bongsu/core/formats/approved";
import { YOUTUBE_LOCKED } from "@bongsu/core/texts/notifications";
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
    youtube: { texts: unknown; settings: unknown; channel: unknown; subtitles: unknown[]; thumbnail: string | null };
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

  it("a video draft with subtitles can't be scheduled to Instagram", async () => {
    await seedDraft("d_video", { texts: null });
    const r = await schedule({ account: "demo_travel", caption: "A caption" });
    expect(r.status).toBe(400);
    expect((await json(r)).error).toBe(
      "Instagram takes the video alone: remove the subtitle and thumbnail files, or schedule it to a YouTube channel",
    );
    expect(await row("reel:drafts/clip")).toBeNull();
  });

  it("approval flags a multi-file Instagram video", async () => {
    const clip = w.drivePut("UPLOADS/_uploads/ig.mp4", { md5: MD5, mimeType: "video/mp4" });
    const sub = w.drivePut("UPLOADS/_uploads/es.srt", { md5: "b".repeat(32), mimeType: "application/x-subrip" });
    await env.DB.prepare(
      "INSERT INTO plan_items (item_key, format, account, folder, name, due_at, options, hold, sort, created_at, updated_at, workspace_id, content, caption, media) VALUES ('reel:x/ig2', 'video', 'demo_travel', 'x', 'ig2', 1893456000, '{}', 0, 1, 0, 0, 'default', 'db', 'A caption', ?1)",
    )
      .bind(JSON.stringify([clip, sub].map((id) => ({ store: "drive", id }))))
      .run();
    expect((await item("reel:x/ig2")).problems).toContain(
      "Instagram takes the video alone: remove the subtitle and thumbnail files, or schedule it to a YouTube channel",
    );
  });

  it("the drafts list returns texts and offers the channels", async () => {
    await seedDraft();
    const d = (await json(await call("/app-api/drafts"))) as {
      accounts: string[];
      accountInfo: Record<string, { platform: string; youtube?: unknown }>;
      drafts: { texts: unknown }[];
    };
    expect(d.drafts[0].texts).toEqual(TEXTS);
    expect(d.accounts).toContain("main");
    // the form shows a channel's fields, starting from the channel's defaults
    expect(d.accountInfo.main).toEqual({
      platform: "youtube",
      youtube: { madeForKids: false, privacy: "public", category: "22" },
    });
    expect(d.accountInfo.demo_travel).toEqual({ platform: "instagram" });
  });

  it("the app's uploads take a video with its subtitle files and thumbnail as one video draft", async () => {
    const start = (name: string, mimeType: string) => post("/app-api/uploads/start", { name, mimeType, size: 10 });
    // phones send no type for a subtitle file: its name says what it is
    expect((await start("es.srt", "")).status).toBe(200);
    expect((await start("pt-BR.vtt", "text/vtt")).status).toBe(200);
    expect((await start("notes.txt", "text/plain")).status).toBe(400);
    expect((await start("English.srt", "")).status).toBe(400);
    const files = [
      w.drivePut("UPLOADS/_uploads/clip.mp4", { md5: MD5, mimeType: "video/mp4" }),
      w.drivePut("UPLOADS/_uploads/es.srt", { md5: "b".repeat(32), mimeType: "application/x-subrip" }),
      w.drivePut("UPLOADS/_uploads/thumbnail.jpg", { md5: "c".repeat(32), mimeType: "image/jpeg" }),
    ];
    const d = (await json(await post("/app-api/drafts/new", { files, project: "demo", name: "clip" }))) as {
      id: string;
    };
    const r = await env.DB.prepare("SELECT kind, payload FROM drafts WHERE id = ?1")
      .bind(d.id)
      .first<{ kind: string; payload: string }>();
    expect(r?.kind).toBe("reel");
    expect(JSON.parse(String(r?.payload)).files.map((f: { name: string }) => f.name)).toEqual([
      "clip.mp4",
      "es.srt",
      "thumbnail.jpg",
    ]);
    // a subtitle file alone is no draft
    const lone = w.drivePut("UPLOADS/_uploads/fr.srt", { md5: "d".repeat(32), mimeType: "application/x-subrip" });
    expect((await post("/app-api/drafts/new", { files: [lone], project: "demo", name: "x" })).status).toBe(400);
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
    // the channel's own defaults come along, so the form can set a value back to them (null)
    expect((await item(key)).youtube.channel).toEqual({ madeForKids: false, privacy: "public", category: "22" });
  });

  it("a caption edit leaves the texts alone, and a description may be long", async () => {
    const key = await scheduled();
    await post("/app-api/item/texts", { key, caption: "x".repeat(4000) });
    const r = await row(key);
    expect(String(r?.caption).length).toBe(4000);
    expect(JSON.parse(String(r?.texts))).toEqual(TEXTS);
  });

  it("a texts-only edit keeps the description, comments and settings", async () => {
    const key = await scheduled({ caption: "A description", comment: "A comment", comment2: "Another" });
    expect((await post("/app-api/item/texts", { key, texts: { title: "Only the title" } })).status).toBe(200);
    expect(await row(key)).toMatchObject({ caption: "A description", comment: "A comment", comment2: "Another" });
    expect(JSON.parse(String((await row(key))?.texts))).toEqual({ title: "Only the title" });
    // a field that is sent is still written, and an empty one clears
    await post("/app-api/item/texts", { key, comment: "" });
    expect(await row(key)).toMatchObject({ caption: "A description", comment: null, comment2: "Another" });
  });

  it("texts: null clears the texts, and madeForKids: null clears that setting", async () => {
    const key = await scheduled({ caption: "A description" });
    await post("/app-api/item/youtube", { key, madeForKids: true });
    await post("/app-api/item/texts", { key, texts: null });
    expect((await row(key))?.texts).toBeNull();
    expect((await row(key))?.caption).toBe("A description");
    const r = await post("/app-api/item/youtube", { key, madeForKids: null });
    expect(await r.json()).toMatchObject({ settings: { madeForKids: false } });
    expect((await row(key))?.options).toBe("{}");
  });

  it("the settings change is audited", async () => {
    const key = await scheduled();
    await post("/app-api/item/youtube", { key, privacy: "unlisted" });
    const a = await env.DB.prepare(
      "SELECT detail, workspace_id FROM audit WHERE action = 'item_youtube' AND target = ?1",
    )
      .bind(key)
      .first<{ detail: string; workspace_id: string }>();
    expect(a && [JSON.parse(a.detail), a.workspace_id]).toEqual([{ privacy: "unlisted" }, "default"]);
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

describe("an upload's progress on the item page", () => {
  const job = (state: string, data: Record<string, unknown>, lastError: string | null = null) =>
    env.DB.prepare(
      "INSERT INTO jobs (item_key, kind, account, due_at, state, last_error, dry_run, payload, created_at, updated_at, workspace_id) VALUES (?1, 'reel', 'main', 1800000000, ?2, ?3, 1, ?4, 0, 0, 'default') ON CONFLICT (item_key) DO UPDATE SET state = excluded.state, last_error = excluded.last_error, payload = excluded.payload",
    )
      .bind(KEY, state, lastError, JSON.stringify({ username: "main", step: { state: "processing", data } }))
      .run();
  const progress = async () =>
    ((await (await call(`/app-api/item?key=${encodeURIComponent(KEY)}`)).json()) as { progress: unknown }).progress;

  it("follows the job's phase: uploading, ready, locked", async () => {
    await scheduled();
    expect(await progress()).toBeNull();
    await job("container_created", { phase: "uploading", size: 100, offset: 40 });
    expect(await progress()).toEqual({ phase: "uploading", percent: 40 });
    await job("container_created", { phase: "waiting", size: 100, offset: 100, videoId: "v1" });
    expect(await progress()).toEqual({ phase: "ready", at: 1800000000 });
    await job("failed", { phase: "waiting", size: 100, videoId: "v1" }, YOUTUBE_LOCKED);
    expect(await progress()).toEqual({ phase: "locked" });
  });

  it("another workspace's job with the same key isn't read", async () => {
    await scheduled();
    await job("container_created", { phase: "uploading", size: 100, offset: 40 });
    await env.DB.prepare("UPDATE jobs SET workspace_id = 'other' WHERE item_key = ?1").bind(KEY).run();
    expect(await progress()).toBeNull();
  });
});
