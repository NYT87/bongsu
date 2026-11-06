// Agents write a YouTube video's title, translations and settings through /v1 (the same operations MCP calls).
// The demo YouTube channel here is `main` (the fake world's first channel).
import { env, exports } from "cloudflare:workers";
import { appRoutes } from "@bongsu/api/pwa/routes";
import type { Verifiers } from "@bongsu/api/pwa/webauthn";
import type { Env } from "@bongsu/core/env";
import { sha256Hex } from "@bongsu/core/formats/approved";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearPlan, localToUnix, MD5, seedAccounts, testEnv, World } from "./world";

const KEY = "bongsu_ytapiytapiytapiytapiytapiytap";
const ITEM = "post:20261020_DEMO/clip";
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
const TEXTS = { title: "Demo", tags: ["demo"], translations: { es: { title: "Demostración", description: "Hola" } } };
const origFetch = globalThis.fetch;
let w: World;
let e: Env;
let cookie = "";

const api = async (path: string, body?: unknown) => {
  const r = await exports.default.fetch(`https://scheduler.test${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: r.status, json: (await r.json()) as Record<string, any> };
};
const add = (extra: Record<string, unknown> = {}) =>
  api("/v1/plan", {
    account: "main",
    format: "video",
    folder: "vlogs/CONTENT/20261101_DEMO",
    name: "clip1",
    date: "2026-11-01",
    ...extra,
  });
const stored = async (key: string) =>
  env.DB.prepare("SELECT texts, caption FROM plan_items WHERE item_key = ?1")
    .bind(key)
    .first<{ texts: string | null; caption: string | null }>();

async function app(path: string, body: unknown = {}, method = "POST") {
  const r = await appRoutes(w.fetch, fake).request(
    `https://bongsu.test${path}`,
    {
      method,
      headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
      ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
    },
    e,
  );
  const set = r.headers.get("Set-Cookie");
  if (set) cookie = set.split(";")[0];
  return r;
}

/** A draft-made item with a video, signed in and approved through the passkey, as the owner does. */
async function seedApproved() {
  await env.DB.prepare("INSERT INTO setup_codes (code_hash, expires_at) VALUES (?1, ?2)")
    .bind(await sha256Hex("CODE-1234"), Math.floor(Date.now() / 1000) + 600)
    .run();
  const o = (await (await app("/app-api/setup/options", { code: "CODE-1234" })).json()) as { challengeId: string };
  await app("/app-api/setup/verify", { challengeId: o.challengeId, response: { id: "cred1" }, name: "t" });
  const clip = w.drivePut("UPLOADS/_uploads/clip.mp4", { md5: MD5, mimeType: "video/mp4" });
  await env.DB.prepare(
    "INSERT INTO plan_items (item_key, format, account, folder, name, due_at, options, hold, sort, created_at, updated_at, workspace_id, content, media, caption, texts) VALUES (?1, 'video', 'main', '20261020_DEMO', 'clip', ?2, '{}', 0, 1, 0, 0, 'default', 'db', ?3, 'A demo video', ?4)",
  )
    .bind(
      ITEM,
      await localToUnix("2026-10-20", "18:00"),
      JSON.stringify([{ store: "drive", id: clip }]),
      JSON.stringify({ title: "Demo" }),
    )
    .run();
  const ch = (await (await app("/app-api/approve/options", { key: ITEM })).json()) as { challengeId: string };
  await app("/app-api/approve/verify", { challengeId: ch.challengeId, response: { id: "cred1" } });
}
const matches = async () =>
  (
    (await (await app(`/app-api/item?key=${encodeURIComponent(ITEM)}`, {}, "GET")).json()) as {
      approved: { matches: boolean } | null;
    }
  ).approved;

beforeEach(async () => {
  await seedAccounts();
  await env.DB.batch(
    ["passkeys", "sessions", "challenges", "setup_codes", "audit", "drafts", "jobs", "api_keys", "rate_limits"].map(
      (t) => env.DB.prepare(`DELETE FROM ${t}`),
    ),
  );
  await env.DB.prepare(
    "INSERT INTO api_keys (id, name, key_hash, scopes) VALUES ('k', 'k', ?1, '[\"read\",\"draft\",\"plan\"]')",
  )
    .bind(await sha256Hex(KEY))
    .run();
  await clearPlan();
  w = new World();
  globalThis.fetch = w.fetch;
  e = await testEnv(env, { PUBLIC_URL: "https://bongsu.test", RP_ID: "bongsu.test" } as Partial<Env>);
  await env.DB.prepare("UPDATE accounts SET external_id = 'UCdemo000000000000000000' WHERE id = 'main'").run();
  cookie = "";
});
afterEach(() => {
  globalThis.fetch = origFetch;
});

describe("texts for a YouTube channel", () => {
  it("plan_add and plan_update take texts for a YouTube channel", async () => {
    const r = await add({ texts: { title: "  Demo \r\n", tags: ["demo", " "] }, caption: "About it" });
    expect(r.status).toBe(200);
    expect(r.json.texts).toEqual(["caption", "texts"]);
    const key = r.json.key as string;
    expect(JSON.parse((await stored(key))?.texts ?? "null")).toEqual({ title: "Demo", tags: ["demo"] });
    const u = await api("/v1/plan/update", { key, texts: TEXTS });
    expect(u.status).toBe(200);
    expect(u.json.texts).toEqual(["texts"]);
    expect(JSON.parse((await stored(key))?.texts ?? "null")).toEqual(TEXTS);
    const i = await api(`/v1/items/${encodeURIComponent(key)}`);
    expect(i.json.texts).toEqual(TEXTS);
    // null clears them
    await api("/v1/plan/update", { key, texts: null });
    expect((await stored(key))?.texts).toBeNull();
  });

  it("a 101-character title is refused, and nothing is added", async () => {
    const r = await add({ texts: { title: "x".repeat(101) } });
    expect(r.status).toBe(400);
    expect(String(r.json.error)).toContain("title");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM plan_items").first()).toEqual({ n: 0 });
    const ok = await add({ texts: { title: "x".repeat(100) } });
    expect(ok.status).toBe(200);
    expect((await api("/v1/plan/update", { key: ok.json.key, texts: { title: "y".repeat(101) } })).status).toBe(400);
  });

  it("a YouTube description may be 5000 characters", async () => {
    const key = (await add()).json.key;
    expect((await api("/v1/plan/update", { key, caption: "d".repeat(5000) })).status).toBe(200);
    expect((await api("/v1/plan/update", { key, caption: "d".repeat(5001) })).status).toBe(400);
    expect((await stored(key as string))?.caption).toHaveLength(5000);
  });

  it("Instagram refuses texts", async () => {
    const r = await add({ account: "demo_travel", texts: { title: "Nope" } });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe("Instagram posts have no title or translations");
    const ig = await add({ account: "demo_travel", name: "short1_x", caption: "Hi" });
    expect(ig.status).toBe(200);
    const u = await api("/v1/plan/update", { key: ig.json.key, texts: { title: "Nope" } });
    expect(u.status).toBe(400);
    expect(u.json.error).toBe("Instagram posts have no title or translations");
    // an Instagram caption still stops at 2200
    expect((await api("/v1/plan/update", { key: ig.json.key, caption: "c".repeat(2201) })).status).toBe(400);
  });

  it("YouTube options are validated", async () => {
    expect((await add({ options: { privacy: "private" } })).status).toBe(400);
    const ok = await add({ options: { privacy: "unlisted", madeForKids: true, category: "10" } });
    expect(ok.status).toBe(200);
    expect((await api("/v1/plan/update", { key: ok.json.key, options: { privacy: "private" } })).status).toBe(400);
  });

  it("create_draft takes a YouTube channel, texts and options", async () => {
    const r = await api("/v1/drafts", {
      kind: "reel",
      account: "main",
      texts: TEXTS,
      options: { privacy: "unlisted" },
      caption: "About it",
    });
    expect(r.status).toBe(200);
    const row = await env.DB.prepare("SELECT texts, payload FROM drafts WHERE id = ?1")
      .bind(r.json.id)
      .first<{ texts: string; payload: string }>();
    expect(JSON.parse(row?.texts ?? "null")).toEqual(TEXTS);
    expect(JSON.parse(row?.payload ?? "{}")).toMatchObject({ options: { privacy: "unlisted" }, caption: "About it" });
    // texts alone are enough for a draft; a bad option, bad texts and an Instagram account are refused
    expect((await api("/v1/drafts", { kind: "reel", account: "main", texts: { title: "Only" } })).status).toBe(200);
    expect(
      (await api("/v1/drafts", { kind: "reel", account: "main", texts: TEXTS, options: { privacy: "x" } })).status,
    ).toBe(400);
    expect((await api("/v1/drafts", { kind: "reel", account: "main", texts: { title: "<b>" } })).status).toBe(400);
    expect((await api("/v1/drafts", { kind: "reel", account: "demo_travel", texts: TEXTS })).status).toBe(400);
    expect((await api("/v1/drafts", { kind: "photo", account: "main", caption: "x" })).status).toBe(400);
  });

  it("get_item and the drafts list return texts", async () => {
    await api("/v1/drafts", { kind: "reel", account: "main", texts: TEXTS });
    const d = (await api("/v1/drafts")).json.drafts as { texts: unknown }[];
    expect(d.map((x) => x.texts)).toEqual([TEXTS]);
    const key = (await add()).json.key;
    expect((await api(`/v1/items/${encodeURIComponent(key as string)}`)).json.texts).toBeNull();
  });

  it("MCP offers texts on plan_add, plan_update and create_draft", async () => {
    const r = await exports.default.fetch("https://scheduler.test/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const tools = ((await r.json()) as any).result.tools as { name: string; inputSchema: any }[];
    for (const n of ["plan_add", "plan_update", "create_draft"])
      expect(tools.find((t) => t.name === n)?.inputSchema.properties.texts).toBeTruthy();
    expect(tools.find((t) => t.name === "create_draft")?.inputSchema.properties.options).toBeTruthy();
  });

  it("changing texts voids the approval", async () => {
    await seedApproved();
    expect(await matches()).toMatchObject({ matches: true });
    const u = await api("/v1/plan/update", { key: ITEM, texts: { title: "Another title" } });
    expect(u.status).toBe(200);
    expect(u.json.note).toContain("approve again");
    expect(await matches()).toMatchObject({ matches: false });
  });
});
