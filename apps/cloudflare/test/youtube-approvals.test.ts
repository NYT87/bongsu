// A YouTube video's approval covers its texts, subtitle files, thumbnail and settings; the tick refuses a texts change.
import { env } from "cloudflare:workers";
import { apiRoutes } from "@bongsu/api/agent/routes";
import { appRoutes } from "@bongsu/api/pwa/routes";
import type { Verifiers } from "@bongsu/api/pwa/webauthn";
import type { Env } from "@bongsu/core/env";
import { sha256Hex } from "@bongsu/core/formats/approved";
import { tick } from "@bongsu/core/tick";
import { beforeEach, describe, expect, it } from "vitest";
import { clearPlan, localToUnix, MD5, seedReel, testEnv, World } from "./world";

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
const KEY = "post:20261020_DEMO/clip";
const TEXTS = {
  title: "Demo",
  translations: { es: { title: "Demostración", description: "Un vídeo de prueba" } },
};
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
const item = async () =>
  (await (await call(`/app-api/item?key=${encodeURIComponent(KEY)}`)).json()) as {
    problems: string[];
    approved: { matches: boolean } | null;
    youtube: {
      texts: unknown;
      subtitles: { lang: string; name: string }[];
      thumbnail: string | null;
      settings: unknown;
    };
  };
async function approveIt() {
  const o = (await (await post("/app-api/approve/options", { key: KEY })).json()) as { challengeId: string };
  return (await post("/app-api/approve/verify", { challengeId: o.challengeId, response: { id: "cred1" } })).json();
}
const setTexts = (texts: unknown) =>
  env.DB.prepare("UPDATE plan_items SET texts = ?1 WHERE item_key = ?2").bind(JSON.stringify(texts), KEY).run();
const job = () =>
  env.DB.prepare("SELECT state, last_error FROM jobs WHERE item_key = ?1")
    .bind(KEY)
    .first<{ state: string; last_error: string | null }>();

async function signUp() {
  await env.DB.prepare("INSERT INTO setup_codes (code_hash, expires_at) VALUES (?1, ?2)")
    .bind(await sha256Hex("CODE-1234"), Math.floor(Date.now() / 1000) + 600)
    .run();
  const o = (await (await post("/app-api/setup/options", { code: "CODE-1234" })).json()) as { challengeId: string };
  await post("/app-api/setup/verify", { challengeId: o.challengeId, response: { id: "cred1" }, name: "t" });
}

/** A draft-made YouTube item (content 'db') with a video, Spanish subtitles and a thumbnail in the Drive store. */
async function seedVideo(texts: unknown = TEXTS) {
  ids = {
    clip: w.drivePut("UPLOADS/_uploads/clip.mp4", { md5: MD5, mimeType: "video/mp4" }),
    es: w.drivePut("UPLOADS/_uploads/es.srt", { md5: "b".repeat(32), mimeType: "application/x-subrip" }),
    thumb: w.drivePut("UPLOADS/_uploads/thumbnail.jpg", { md5: "c".repeat(32), mimeType: "image/jpeg" }),
  };
  const due = await localToUnix("2026-10-20", "18:00");
  await env.DB.prepare(
    "INSERT INTO plan_items (item_key, format, account, folder, name, due_at, options, hold, sort, created_at, updated_at, workspace_id, content, media, caption, texts) VALUES (?1, 'video', 'main', '20261020_DEMO', 'clip', ?2, '{}', 0, 1, 0, 0, 'default', 'db', ?3, 'A demo video', ?4)",
  )
    .bind(
      KEY,
      due,
      JSON.stringify(Object.values(ids).map((id) => ({ store: "drive", id }))),
      texts === null ? null : JSON.stringify(texts),
    )
    .run();
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

describe("approving a YouTube video", () => {
  it("a YouTube video without a title can't be approved", async () => {
    await seedVideo({ title: "" });
    expect((await item()).problems).toContain("a YouTube video needs a title");
    await env.DB.prepare("UPDATE plan_items SET texts = NULL WHERE item_key = ?1").bind(KEY).run();
    expect((await item()).problems).toContain("a YouTube video needs a title");
  });

  it("refuses texts and media that don't fit the video", async () => {
    await seedVideo({ title: "Demo", tags: ["<b>"] });
    expect((await item()).problems).toContain("tags: no < or > (YouTube refuses them)");
    const notes = w.drivePut("UPLOADS/_uploads/notes.txt", { md5: "d".repeat(32), mimeType: "text/plain" });
    await env.DB.prepare("UPDATE plan_items SET media = ?1 WHERE item_key = ?2")
      .bind(JSON.stringify([...Object.values(ids), notes].map((id) => ({ store: "drive", id }))), KEY)
      .run();
    expect((await item()).problems).toContain(
      "notes.txt isn't a video, a subtitle file (<lang>.srt or .vtt) or thumbnail.jpg/png",
    );
  });

  it("the approval shows everything it covers", async () => {
    await seedVideo();
    const i = await item();
    expect(i.problems).toEqual([]);
    expect(i.youtube).toEqual({
      texts: TEXTS,
      roles: [`video:${ids.clip}`, `subtitle:es:${ids.es}`, `thumbnail:${ids.thumb}`],
      subtitles: [{ lang: "es", name: "es.srt" }],
      thumbnail: "thumbnail.jpg",
      settings: { madeForKids: false, privacy: "public", category: "22" },
    });
  });

  it("a changed title needs a new approval", async () => {
    await seedVideo();
    expect(await approveIt()).toMatchObject({ approved: true });
    expect((await item()).approved).toMatchObject({ matches: true });
    await setTexts({ ...TEXTS, title: "Changed" });
    expect((await item()).approved).toMatchObject({ matches: false });
  });

  it("a changed translation, subtitle file or thumbnail needs a new approval", async () => {
    await seedVideo();
    await approveIt();
    await setTexts({ title: "Demo", translations: { es: { title: "Otro", description: "Un vídeo de prueba" } } });
    expect((await item()).approved).toMatchObject({ matches: false });
    await setTexts(TEXTS);
    expect((await item()).approved).toMatchObject({ matches: true });
    w.drive.get(ids.es)!.md5 = "e".repeat(32);
    expect((await item()).approved).toMatchObject({ matches: false });
    w.drive.get(ids.es)!.md5 = "b".repeat(32);
    expect((await item()).approved).toMatchObject({ matches: true });
    w.drive.get(ids.thumb)!.md5 = "f".repeat(32);
    expect((await item()).approved).toMatchObject({ matches: false });
  });

  it("the tick refuses a texts change", async () => {
    await seedVideo();
    await approveIt();
    await setTexts({ ...TEXTS, title: "Changed after approval" });
    // The lead (upload ahead of the due time) comes with Task 11, so the tick runs at the due time.
    await tick(e, { fetch: w.fetch, now: new Date("2026-10-20T09:00:00Z") });
    expect(await job()).toEqual({ state: "refused", last_error: "the title or translations changed after approval" });
  });

  it("the tick passes unchanged texts on to verify", async () => {
    await seedVideo();
    await approveIt();
    await tick(e, { fetch: w.fetch, now: new Date("2026-10-20T09:00:00Z") });
    // past verify: it reaches the provider, whose upload isn't built yet (Task 10), and is not refused
    expect(await job()).toEqual({ state: "pending", last_error: expect.stringContaining("aren't supported yet") });
  });

  it("a renamed subtitle file breaks the approval, in the app and in the tick", async () => {
    await seedVideo();
    await approveIt();
    w.drive.get(ids.es)!.name = "fr.srt"; // same id and checksum, another language
    expect((await item()).approved).toMatchObject({ matches: false });
    await tick(e, { fetch: w.fetch, now: new Date("2026-10-20T09:00:00Z") });
    expect(await job()).toEqual({ state: "refused", last_error: "the title or translations changed after approval" });
  });

  it("a YouTube approval stores a texts fingerprint", async () => {
    await seedVideo();
    await approveIt();
    expect(
      await env.DB.prepare("SELECT texts_sha FROM approvals WHERE item_key = ?1").bind(KEY).first("texts_sha"),
    ).toMatch(/^[0-9a-f]{64}$/);
  });

  it("the tick refuses texts removed after approval", async () => {
    await seedVideo();
    await approveIt();
    await env.DB.prepare("UPDATE plan_items SET texts = NULL WHERE item_key = ?1").bind(KEY).run();
    await tick(e, { fetch: w.fetch, now: new Date("2026-10-20T09:00:00Z") });
    expect(await job()).toEqual({ state: "refused", last_error: "the title or translations changed after approval" });
  });

  it("an agent key can't approve a YouTube video", async () => {
    await seedVideo();
    await env.DB.prepare("INSERT INTO api_keys (id, name, key_hash, scopes) VALUES ('k1', 'agent', ?1, ?2)")
      .bind(await sha256Hex("bongsu_agentagentagentagentagentag"), JSON.stringify(["read", "plan", "approve"]))
      .run();
    const r = await apiRoutes(w.fetch).request(
      `https://scheduler.test/v1/approve/${encodeURIComponent(KEY)}`,
      { headers: { Authorization: "Bearer bongsu_agentagentagentagentagentag" } },
      e,
    );
    expect(r.status).toBe(403);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM approvals").first("n")).toBe(0);
  });

  it("an Instagram approval stores no texts fingerprint", async () => {
    const { key, folder, base } = await seedReel(w, { base: "short1_ig", approve: false });
    w.drivePut(`UPLOADS/${folder}/exports/shorts/instagram/${base}.mp4`, { md5: MD5, mimeType: "video/mp4" });
    const o = (await (await post("/app-api/approve/options", { key })).json()) as { challengeId: string };
    expect(
      await (await post("/app-api/approve/verify", { challengeId: o.challengeId, response: { id: "cred1" } })).json(),
    ).toMatchObject({ approved: true });
    expect(
      await env.DB.prepare("SELECT texts_sha FROM approvals WHERE item_key = ?1").bind(key).first("texts_sha"),
    ).toBeNull();
  });
});
