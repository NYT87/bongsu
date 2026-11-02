// Approving from the CLI (Phase 6): a CLI token of an owner, admin or approver reads an item as it would be published
// and approves exactly what it was shown; an agent key never can, whatever its row says (Refs #72, #74).
import { env } from "cloudflare:workers";
import { apiRoutes } from "@bongsu/api/agent/routes";
import { TOOLS } from "@bongsu/api/agent/tools";
import type { Snapshot } from "@bongsu/api/pwa/approve";
import type { Env } from "@bongsu/core/env";
import { sha256Hex } from "@bongsu/core/formats/approved";
import { tick } from "@bongsu/core/tick";
import { beforeEach, describe, expect, it } from "vitest";
import { clearPlan, copyText, igHappyPath, MD5, seedReel, testEnv, World } from "./world";

const OWNER_TOKEN = "bongsu_ownerownerownerownerownero";
const KEY_FORGED = "bongsu_forgedforgedforgedforgedfo";
const AT = new Date("2026-10-20T09:32:00Z"); // 18:32 in Seoul: short1_x is due
const at = (min: number) => new Date(AT.getTime() + min * 60_000);

let w: World;
let e: Env;
let key: string;

async function addKey(id: string, token: string, scopes: string[]) {
  await env.DB.prepare("INSERT INTO api_keys (id, name, key_hash, scopes) VALUES (?1, ?2, ?3, ?4)")
    .bind(id, `test ${id}`, await sha256Hex(token), JSON.stringify(scopes))
    .run();
}

/** A CLI token of user bea, with `role` in the default workspace. */
async function addToken(id: string, token: string, userId: string, role: string) {
  await env.DB.prepare(
    "INSERT INTO api_keys (id, name, key_hash, scopes, workspace_id, user_id, expires_at) VALUES (?1, ?2, ?3, '[]', 'default', ?4, ?5)",
  )
    .bind(id, `cli ${id}`, await sha256Hex(token), userId, Math.floor(Date.now() / 1000) + 86400)
    .run();
  await env.DB.prepare(
    "INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES ('default', ?1, ?2, 0) ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = ?2",
  )
    .bind(userId, role)
    .run();
}

const setRole = (role: string) =>
  env.DB.prepare("UPDATE memberships SET role = ?1 WHERE user_id = 'bea' AND workspace_id = 'default'")
    .bind(role)
    .run();

const req = (path: string, token: string, init: RequestInit = {}) =>
  apiRoutes(w.fetch).request(
    `https://scheduler.test${path}`,
    { ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } },
    e,
  );
const show = async (k: string, token = OWNER_TOKEN) =>
  (await (await req(`/v1/approve/${encodeURIComponent(k)}`, token)).json()) as { snapshot: Snapshot } & Record<
    string,
    unknown
  >;
const approve = (k: string, snapshot: unknown, token = OWNER_TOKEN) =>
  req("/v1/approve", token, { method: "POST", body: JSON.stringify({ key: k, snapshot }) });
const approvals = async () =>
  (await env.DB.prepare("SELECT COUNT(*) AS n FROM approvals").first<{ n: number }>())?.n ?? 0;

beforeEach(async () => {
  await clearPlan();
  await env.DB.batch(
    ["api_keys", "audit", "jobs", "locks", "rate_limits"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)),
  );
  w = new World();
  e = await testEnv(env);
  igHappyPath(w);
  await env.DB.prepare(
    "INSERT INTO workspaces (id, name, created_at) VALUES ('b', 'Workspace B', 0) ON CONFLICT (id) DO NOTHING",
  ).run();
  await env.DB.prepare(
    "INSERT INTO users (id, name, created_at) VALUES ('bea', 'Bea', 0) ON CONFLICT (id) DO NOTHING",
  ).run();
  await addToken("tok-owner", OWNER_TOKEN, "bea", "owner");
  const { folder, base, key: k } = await seedReel(w, { approve: false });
  w.drivePut(`UPLOADS/${folder}/exports/shorts/instagram/${base}.mp4`, { md5: MD5, mimeType: "video/mp4" });
  key = k;
});

describe("approving from a CLI token", () => {
  it("shows and writes an approval for an owner's CLI token, then the tick publishes", async () => {
    const shown = await show(key);
    expect(shown.snapshot.key).toBe(key);
    expect(shown).toMatchObject({ key, account: "demo_travel", approved: null });
    expect(shown.media).toHaveLength(1);
    const r = await approve(key, shown.snapshot);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ approved: true, key });
    const a = await env.DB.prepare("SELECT approved_by, user_id, account FROM approvals WHERE item_key = ?1")
      .bind(key)
      .first();
    expect(a).toEqual({ approved_by: "owner@cli", user_id: "bea", account: "demo_travel" });
    expect(await env.DB.prepare("SELECT action, actor FROM audit WHERE action = 'approve'").first()).toEqual({
      action: "approve",
      actor: "key:tok-owner",
    });
    await tick(e, { fetch: w.fetch, now: at(0) });
    expect((await env.DB.prepare("SELECT state FROM jobs WHERE item_key = ?1").bind(key).first())?.state).toBe(
      "container_created",
    );
  });

  it("lets an approver's token approve", async () => {
    await setRole("approver");
    const shown = await show(key);
    expect((await approve(key, shown.snapshot)).status).toBe(200);
    expect(await approvals()).toBe(1);
  });

  it("refuses a viewer's and an editor's token", async () => {
    const shown = await show(key);
    for (const role of ["viewer", "editor"]) {
      await setRole(role);
      const g = await req(`/v1/approve/${encodeURIComponent(key)}`, OWNER_TOKEN);
      expect(g.status).toBe(403);
      expect(await g.json()).toEqual({ error: "approving takes a CLI token of an owner, admin or approver" });
      expect((await approve(key, shown.snapshot)).status).toBe(403);
    }
    expect(await approvals()).toBe(0);
  });

  it("refuses an agent key, even one whose row says approve", async () => {
    await addKey("k-forged", KEY_FORGED, ["read", "plan", "approve", "resume"]);
    expect((await req(`/v1/approve/${encodeURIComponent(key)}`, KEY_FORGED)).status).toBe(403);
    expect((await req("/v1/approve", KEY_FORGED, { method: "POST", body: "{}" })).status).toBe(403);
    const shown = await show(key);
    expect((await approve(key, shown.snapshot, KEY_FORGED)).status).toBe(403);
    expect(await approvals()).toBe(0);
    expect(TOOLS.map((t) => t.name)).not.toContain("approve"); // Refs #74
  });

  it("refuses when the caption changed since it was shown", async () => {
    const shown = await show(key);
    await copyText("channels/vlogs/CONTENT/20260823_LISBON/shorts/instagram/short1_x.txt", "new");
    const r = await approve(key, shown.snapshot);
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({
      error: "it changed since you looked: check the new version, then approve",
      changed: true,
    });
    expect(await approvals()).toBe(0);
  });

  it("refuses what can't be approved yet, with the problems", async () => {
    await env.DB.prepare("UPDATE plan_items SET due_at = NULL WHERE item_key = ?1").bind(key).run();
    const g = await req(`/v1/approve/${encodeURIComponent(key)}`, OWNER_TOKEN);
    expect(g.status).toBe(409);
    expect(await g.json()).toEqual({
      error: "can't approve yet",
      problems: ["the item has no valid date/time: schedule it first"],
    });
    const p = await approve(key, { key });
    expect(p.status).toBe(409);
    expect(await p.json()).toMatchObject({ problems: ["the item has no valid date/time: schedule it first"] });
    expect(await approvals()).toBe(0);
  });

  it("approves a Shorts comment by its comment: key", async () => {
    await env.DB.prepare(
      "INSERT INTO shorts_comments (video_id, channel, file, label, sort, created_at, text, workspace_id) VALUES ('dQw4w9WgXcQ', 'main', '', 's1', 0, 0, 'Agent text', 'default')",
    ).run();
    const shown = await show("comment:dQw4w9WgXcQ");
    expect(shown).toMatchObject({ key: "comment:dQw4w9WgXcQ", caption: "Agent text", media: [] });
    expect((await approve("comment:dQw4w9WgXcQ", shown.snapshot)).status).toBe(200);
    const a = await env.DB.prepare(
      "SELECT account, caption_sha, due_at FROM approvals WHERE item_key = 'comment:dQw4w9WgXcQ'",
    ).first();
    expect(a).toEqual({ account: "main", caption_sha: await sha256Hex("Agent text"), due_at: 0 });
  });

  it("answers 404 for another workspace's item", async () => {
    await env.DB.prepare("UPDATE plan_items SET workspace_id = 'b' WHERE item_key = ?1").bind(key).run();
    const g = await req(`/v1/approve/${encodeURIComponent(key)}`, OWNER_TOKEN);
    expect(g.status).toBe(404);
    expect(await g.json()).toEqual({ error: `${key} isn't planned` });
    expect((await approve(key, { key })).status).toBe(404);
  });
});

describe("export", () => {
  type Row = Record<string, unknown>;
  const exported = async (query = "", token = OWNER_TOKEN) => {
    const r = await req(`/v1/export${query}`, token);
    return { status: r.status, json: (await r.json()) as { timezone: string; items: Row[] } };
  };

  it("lists every item of the workspace by due time, with approval and posting state", async () => {
    const past = await seedReel(w, { base: "past_one", date: "2026-10-01", time: "09:00" });
    const future = await seedReel(w, { base: "future_one", date: "2026-11-05", time: "09:00" }); // approved
    await env.DB.prepare(
      "INSERT INTO posted (item_key, account, media_id, permalink, source, at, published_at, workspace_id) VALUES (?1, 'demo_travel', 'm_1', 'https://example.com/p/1', 'scheduler', 1, 1790000000, 'default')",
    )
      .bind(past.key)
      .run();
    const { status, json } = await exported();
    expect(status).toBe(200);
    expect(json.timezone).toEqual(expect.any(String));
    const by = (k: string) => json.items.find((i) => i.key === k) as Row;
    expect(json.items.map((i) => i.due_at)).toEqual([...json.items.map((i) => i.due_at as string)].sort());
    expect(by(past.key)).toMatchObject({
      account: "demo_travel",
      platform: "instagram",
      hold: false,
      posted_media_id: "m_1",
      posted_permalink: "https://example.com/p/1",
    });
    expect(by(past.key).published_at).toEqual(expect.any(String));
    expect(by(future.key)).toMatchObject({
      approved: true,
      approval_matches: true,
      posted_media_id: null,
      posted_permalink: null,
      published_at: null,
    });
    expect(by(future.key).approved_at).toEqual(expect.any(String));
    expect(by(key)).toMatchObject({ approved: false, approval_matches: false, approved_at: null });
    expect(by(key)).not.toHaveProperty("caption");
  });

  it("adds the texts with ?texts=1", async () => {
    const { json } = await exported("?texts=1");
    const row = json.items.find((i) => i.key === key) as Row;
    expect(row.caption).toBe("A caption\n\nWhere next?\n\n#travel");
    expect(row.comment).toBe("📍 Somewhere. Have you been?");
    expect(row).toHaveProperty("comment2");
  });

  it("needs the read scope", async () => {
    await addKey("k-draft", KEY_FORGED, ["draft"]);
    const r = await exported("", KEY_FORGED);
    expect(r.status).toBe(403);
    expect(r.json).toMatchObject({ error: 'this key lacks the "read" scope' });
  });
});
