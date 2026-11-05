// The instance admin's Workspaces page (docs/superpowers/specs/2026-11-04-phase13-people-roles-design.md, section 4):
// list, create, rename, add an admin, archive and restore, open; and a workspace's own admins renaming it from
// Settings. An archived workspace stops completely: nothing publishes, its agent keys and its members are refused,
// and restoring it brings it back as it was.
import { env, exports } from "cloudflare:workers";
import { adminRoutes, FRESH_S } from "@bongsu/api/dashboard/routes";
import { appRoutes } from "@bongsu/api/pwa/routes";
import { createSession, setSessionWorkspace } from "@bongsu/api/pwa/session";
import type { Verifiers } from "@bongsu/api/pwa/webauthn";
import { upsertAccount, upsertConnection } from "@bongsu/core/accounts";
import { dailyDigest } from "@bongsu/core/digest";
import type { Env } from "@bongsu/core/env";
import { sha256Hex } from "@bongsu/core/formats/approved";
import { createWorkspace } from "@bongsu/core/people";
import { tick } from "@bongsu/core/tick";
import { setMediaFolder, setWorkspaceSettings, workspaceSettings } from "@bongsu/core/workspaces";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { approve, clearPlan, copyText, igHappyPath, MD5, planItem, testEnv, World } from "./world";

const AT = new Date("2026-10-20T09:32:00Z"); // 18:32 KST: B's Reel below is due
const later = (min: number) => new Date(AT.getTime() + min * 60_000);
const KEY_B = "bongsu_archBarchBarchBarchBarchBa";
const nowS = () => Math.floor(Date.now() / 1000);
const fake: Verifiers = {
  registration: (async () => ({ verified: true })) as unknown as Verifiers["registration"],
  authentication: (async () => ({
    verified: true,
    authenticationInfo: { newCounter: 1 },
  })) as unknown as Verifiers["authentication"],
};
const origFetch = globalThis.fetch;
let w: World;
let e: Env;

type Res = { status: number; json: Record<string, unknown> };
async function req(routes: "dashboard" | "pwa", cookie: string, path: string, body?: unknown): Promise<Res> {
  const app = routes === "dashboard" ? adminRoutes(w.fetch, fake) : appRoutes(w.fetch, fake);
  const r = await app.request(
    `https://bongsu.test${path}`,
    {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    e,
  );
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
}
/** A dashboard session of `userId` (working in `workspaceId` when given). `stale`: its last passkey check is older
 *  than FRESH_S. */
const dash = async (userId: string, workspaceId?: string, o: { stale?: boolean } = {}) => {
  const token = await createSession(env.DB, nowS(), { app: "dashboard", userId });
  if (workspaceId) await setSessionWorkspace(env.DB, token, workspaceId);
  if (o.stale)
    await env.DB.prepare("UPDATE sessions SET verified_at = ?1 WHERE token_hash = ?2")
      .bind(nowS() - FRESH_S - 1, await sha256Hex(token))
      .run();
  return (path: string, body?: unknown) => req("dashboard", `bongsu_admin=${token}`, path, body);
};
const app = async (userId: string) => {
  const token = await createSession(env.DB, nowS(), { userId });
  return (path: string, body?: unknown) => req("pwa", `bongsu_session=${token}`, path, body);
};
const status = (key: string) =>
  exports.default.fetch("https://scheduler.test/v1/status", { headers: { Authorization: `Bearer ${key}` } });
const jobState = (key: string) =>
  env.DB.prepare("SELECT state FROM jobs WHERE item_key = ?1").bind(key).first<string>("state");
const nameOf = (id: string) =>
  env.DB.prepare("SELECT name FROM workspaces WHERE id = ?1").bind(id).first<string>("name");

const digestSent = () =>
  env.DB.prepare("SELECT value FROM settings WHERE key = 'digest_last:b'").first<string>("value");

/** An approved Reel of workspace B's b_shop, due at 18:00 Seoul time. */
async function seedReelB() {
  const folder = "shop/CONTENT/20261020_SALE";
  const key = await planItem({ folder, name: "short1_sale", account: "b_shop", workspaceId: "b", location: "111" });
  await copyText(`channels/${folder}/shorts/instagram/short1_sale.txt`, "Sale today\n");
  await copyText(`channels/${folder}/shorts/instagram/short1_sale.comment.txt`, "Which one?\n");
  w.drive.set("drive_short1_sale_000000", { md5: MD5, mimeType: "video/mp4" });
  await approve(key, {
    due: "2026-10-20 18:00",
    caption: "Sale today",
    comment: "Which one?",
    media: [{ driveId: "drive_short1_sale_000000", md5: MD5 }],
  });
  return key;
}

beforeEach(async () => {
  w = new World();
  globalThis.fetch = w.fetch;
  await clearPlan();
  e = await testEnv(env, { PUBLIC_URL: "https://bongsu.test", RP_ID: "bongsu.test" } as Partial<Env>);
  await env.DB.batch(
    [
      "DELETE FROM jobs",
      "DELETE FROM audit",
      "DELETE FROM locks",
      "DELETE FROM api_keys",
      "DELETE FROM sessions",
      "DELETE FROM invites",
      "DELETE FROM memberships WHERE user_id IN ('ada', 'bob', 'eda', 'cara', 'ina')",
      "DELETE FROM users WHERE id IN ('ada', 'bob', 'eda', 'cara', 'ina')",
      "INSERT INTO workspaces (id, name, created_at) VALUES ('b', 'Workspace B', 0) ON CONFLICT (id) DO UPDATE SET name = 'Workspace B'",
      "UPDATE workspaces SET archived_at = NULL",
      // ada: the default workspace's admin; bob: B's admin; eda: B's editor; cara: B's creator; ina: an instance admin
      // in no workspace
      "INSERT INTO users (id, email, name, created_at) VALUES ('ada', 'ada@example.com', 'Ada', 0)",
      "INSERT INTO users (id, email, name, created_at) VALUES ('bob', 'bob@example.com', 'Bob', 0)",
      "INSERT INTO users (id, email, name, created_at) VALUES ('eda', 'eda@example.com', 'Eda', 0)",
      "INSERT INTO users (id, email, name, created_at) VALUES ('cara', 'cara@example.com', 'Cara', 0)",
      "INSERT INTO users (id, email, name, created_at, instance_admin) VALUES ('ina', 'ina@example.com', 'Ina', 0, 1)",
      "INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES ('default', 'ada', 'admin', 0)",
      "INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES ('b', 'bob', 'admin', 0)",
      "INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES ('b', 'eda', 'editor', 0)",
      "INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES ('b', 'cara', 'creator', 0)",
    ].map((s) => env.DB.prepare(s)),
  );
  await setWorkspaceSettings(env.DB, "b", { timezone: "Europe/Madrid", digestHour: 8 }, 0);
  await upsertConnection(
    env.DB,
    { id: "c_b", workspaceId: "b", provider: "composio", kind: "composio", externalRef: "instagram_conn-b2" },
    0,
  );
  await upsertAccount(
    env.DB,
    {
      id: "b_shop",
      workspaceId: "b",
      platform: "instagram",
      handle: "b_shop",
      externalId: "17841400000000099",
      connectionId: "c_b",
    },
    0,
  );
  await env.DB.prepare(
    "INSERT INTO api_keys (id, name, key_hash, scopes, workspace_id) VALUES ('kb', 'kb', ?1, '[\"read\"]', 'b')",
  )
    .bind(await sha256Hex(KEY_B))
    .run();
});
afterEach(async () => {
  globalThis.fetch = origFetch;
  await env.DB.prepare("UPDATE workspaces SET archived_at = NULL").run();
});

describe("the Workspaces page", () => {
  it("archives a workspace: nothing publishes, its keys and members are refused, restoring brings it back", async () => {
    const reel = await seedReelB();
    const ina = await dash("ina");
    const bob = await dash("bob");
    const cara = await app("cara");
    expect((await status(KEY_B)).status).toBe(200);
    expect((await bob("/admin-api/members")).status).toBe(200);

    expect((await ina("/admin-api/workspaces/b/archive", {})).json).toEqual({ archived: true });
    expect((await ina("/admin-api/workspaces/b/archive", {})).status).toBe(409);
    const archivedAt = await env.DB.prepare("SELECT archived_at FROM workspaces WHERE id = 'b'").first("archived_at");
    expect(archivedAt).toEqual(expect.any(Number));

    // no digest either (11:32 in Madrid: B's is due)
    await dailyDigest(e, { fetch: w.fetch, now: AT });
    expect(await digestSent()).toBeNull();
    // nothing publishes: its Reel isn't even picked up, and the tick says nothing about it being paused
    igHappyPath(w);
    const t = await tick(e, { fetch: w.fetch, now: AT });
    expect(t.detail).toMatchObject({ held: ["b"] });
    expect(await jobState(reel)).toBeNull();
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'paused'").first("n")).toBe(0);
    // its agent key works like an unknown one, its members can't open it (dashboard or app)
    expect((await status(KEY_B)).status).toBe(401);
    expect(await bob("/admin-api/members")).toMatchObject({ status: 403, json: { noWorkspace: true } });
    expect((await cara("/app-api/queue")).status).toBe(403);
    // the instance admin can't open it either until it's restored
    expect((await ina("/admin-api/workspaces/b/open", {})).status).toBe(409);
    // the list says so
    const list = (await ina("/admin-api/workspaces")).json.workspaces as Record<string, unknown>[];
    expect(list.find((x) => x.id === "b")).toEqual({
      id: "b",
      name: "Workspace B",
      members: 3,
      accounts: 1,
      createdAt: 0,
      archivedAt,
    });

    // restoring brings it back unchanged: the key, the members, the Reel
    expect((await ina("/admin-api/workspaces/b/restore", {})).json).toEqual({ restored: true });
    expect((await ina("/admin-api/workspaces/b/restore", {})).status).toBe(409);
    expect((await status(KEY_B)).status).toBe(200);
    expect((await bob("/admin-api/members")).status).toBe(200);
    expect((await cara("/app-api/queue")).status).toBe(200);
    await tick(e, { fetch: w.fetch, now: later(5) });
    expect(await jobState(reel)).toBe("container_created");
    await dailyDigest(e, { fetch: w.fetch, now: later(5) });
    expect(await digestSent()).toBe("2026-10-20");
    // both changes are in B's audit, by the instance admin
    const audit = await env.DB.prepare(
      "SELECT action, workspace_id, actor FROM audit WHERE action LIKE 'workspace_%' ORDER BY id",
    ).all();
    expect(audit.results).toEqual([
      { action: "workspace_archive", workspace_id: "b", actor: "user:ina" },
      { action: "workspace_restore", workspace_id: "b", actor: "user:ina" },
    ]);
  });

  it("opens any workspace for an instance admin who isn't a member, acting as its admin", async () => {
    const ina = await dash("ina", "default");
    expect((await ina("/admin-api/workspaces/nope/open", {})).status).toBe(404);
    expect((await ina("/admin-api/workspaces/b/open", {})).json).toEqual({ id: "b" });
    // the session works in B, as its admin: B's members, B's settings
    const state = await ina("/admin-api/state");
    expect(state.json).toMatchObject({ instanceAdmin: true, role: "admin", noWorkspace: false });
    const members = (await ina("/admin-api/members")).json.members as { userId: string }[];
    expect(members.map((m) => m.userId).sort()).toEqual(["bob", "cara", "eda"]);
    expect((await ina("/admin-api/settings")).json).toMatchObject({ name: "Workspace B", timezone: "Europe/Madrid" });
    // what it changes lands in B, nowhere else
    expect((await ina("/admin-api/settings", { name: "Shop" })).json).toEqual({ saved: true });
    expect(await nameOf("b")).toBe("Shop");
    expect(await nameOf("default")).not.toBe("Shop");
    const made = await ina("/admin-api/invites", { email: "new@example.com", role: "editor" });
    expect(made.status).toBe(200);
    expect(await env.DB.prepare("SELECT workspace_id FROM invites WHERE email = 'new@example.com'").first()).toEqual({
      workspace_id: "b",
    });
    const audit = await env.DB.prepare("SELECT action, workspace_id FROM audit ORDER BY id").all();
    expect(audit.results).toEqual([
      { action: "workspace_open", workspace_id: "b" },
      { action: "settings", workspace_id: "b" },
      { action: "invite_create", workspace_id: "b" },
    ]);
  });

  it("gives each workspace a media folder from its name, numbered when another has it, and keeps them unique", async () => {
    const a = await createWorkspace(env.DB, { name: "Demo Studio", timezone: "UTC", createdBy: "owner" }, nowS());
    const b = await createWorkspace(env.DB, { name: "Demo Studio", timezone: "UTC", createdBy: "owner" }, nowS());
    expect((await workspaceSettings(env.DB, a)).mediaFolder).toBe("demo-studio");
    expect((await workspaceSettings(env.DB, b)).mediaFolder).toBe("demo-studio-2");
    await expect(setMediaFolder(env.DB, b, "demo-studio", nowS())).rejects.toThrow(
      "another workspace uses demo-studio",
    );
    expect(await setMediaFolder(env.DB, b, "Client B", nowS())).toBe("Client B");
    expect((await workspaceSettings(env.DB, b)).mediaFolder).toBe("Client B");
    // the seeded workspace keeps the folder its files are in
    expect((await workspaceSettings(env.DB, "default")).mediaFolder).toBe("UPLOADS");
  });

  it("compares folders without case: a disk or a Drive that ignores it would otherwise mix two workspaces' files", async () => {
    const a = await createWorkspace(env.DB, { name: "Demo Studio", timezone: "UTC", createdBy: "owner" }, nowS());
    const b = await createWorkspace(env.DB, { name: "Demo Two", timezone: "UTC", createdBy: "owner" }, nowS());
    await setMediaFolder(env.DB, a, "Shared Media", nowS());
    // the seeded workspace's UPLOADS, another's Shared Media: neither again in another case
    await expect(setMediaFolder(env.DB, b, "uploads", nowS())).rejects.toThrow("another workspace uses uploads");
    await expect(setMediaFolder(env.DB, b, "SHARED media", nowS())).rejects.toThrow("another workspace uses");
    await expect(
      createWorkspace(
        env.DB,
        { name: "Demo Three", timezone: "UTC", createdBy: "owner", mediaFolder: "Uploads" },
        nowS(),
      ),
    ).rejects.toThrow("another workspace uses Uploads");
    // a workspace changes its own folder's case
    expect(await setMediaFolder(env.DB, a, "shared media", nowS())).toBe("shared media");
    // the slug steps over a folder that differs only in case
    await setMediaFolder(env.DB, b, "Demo-Four", nowS());
    const c = await createWorkspace(env.DB, { name: "Demo Four", timezone: "UTC", createdBy: "owner" }, nowS());
    expect((await workspaceSettings(env.DB, c)).mediaFolder).toBe("demo-four-2");
    // and the database refuses it too, whatever writes the row
    await expect(
      env.DB.prepare("UPDATE workspace_settings SET media_folder = 'SHARED MEDIA' WHERE workspace_id = ?1")
        .bind(c)
        .run(),
    ).rejects.toThrow(/UNIQUE/);
  });

  it("lists, creates, renames and adds admins to workspaces, for instance admins only", async () => {
    const ina = await dash("ina");
    const list = (await ina("/admin-api/workspaces")).json.workspaces as Record<string, unknown>[];
    expect(list.map((x) => x.id)).toEqual(expect.arrayContaining(["default", "b"]));
    expect(list.find((x) => x.id === "b")).toMatchObject({ name: "Workspace B", members: 3, archivedAt: null });

    expect((await ina("/admin-api/workspaces/b", { name: "  Shop  " })).json).toEqual({ id: "b", name: "Shop" });
    expect(await nameOf("b")).toBe("Shop");
    expect((await ina("/admin-api/workspaces/b", { name: " " })).status).toBe(400);
    expect((await ina("/admin-api/workspaces/b", { name: "x".repeat(81) })).status).toBe(400);
    expect((await ina("/admin-api/workspaces/nope", { name: "Shop" })).status).toBe(404);

    // an admin: an invite to that workspace, a link to copy
    const added = await ina("/admin-api/workspaces/b/admins", { email: "Dee@Example.com" });
    expect(added.json).toEqual({
      url: expect.stringMatching(/^https:\/\/bongsu\.test\/dashboard\/invite\/[\w-]{43}$/),
    });
    expect(
      await env.DB.prepare("SELECT workspace_id, role FROM invites WHERE email = 'dee@example.com'").first(),
    ).toEqual({ workspace_id: "b", role: "admin" });
    expect((await ina("/admin-api/workspaces/b/admins", { email: "bob@example.com" })).status).toBe(409);
    expect((await ina("/admin-api/workspaces/b/admins", { email: "nope" })).status).toBe(400);

    // a workspace's own admin is refused all of it
    const bob = await dash("bob");
    for (const [path, body] of [
      ["/admin-api/workspaces", undefined],
      ["/admin-api/workspaces/b", { name: "Mine" }],
      ["/admin-api/workspaces/b/archive", {}],
      ["/admin-api/workspaces/default/open", {}],
      ["/admin-api/workspaces/b/admins", { email: "x@example.com" }],
      ["/admin-api/instance-admins", { userId: "bob", on: true }],
    ] as const)
      expect((await bob(path, body)).status).toBe(403);
    expect(await nameOf("b")).toBe("Shop");
  });

  it("a workspace's admins rename it from Settings; editors can't, and a name can't be emptied", async () => {
    const bob = await dash("bob");
    expect((await bob("/admin-api/settings", { name: " Shop " })).json).toEqual({ saved: true });
    expect(await nameOf("b")).toBe("Shop");
    expect((await bob("/admin-api/settings")).json).toMatchObject({ name: "Shop" });
    expect((await bob("/admin-api/settings", { name: "" })).status).toBe(400);
    expect((await bob("/admin-api/settings", { name: "x".repeat(81) })).status).toBe(400);
    expect(await nameOf("b")).toBe("Shop");
    // the time zone alone leaves the name
    expect((await bob("/admin-api/settings", { timezone: "Europe/Paris" })).json).toEqual({ saved: true });
    expect(await nameOf("b")).toBe("Shop");
    const eda = await dash("eda");
    expect((await eda("/admin-api/settings", { name: "Eda's" })).status).toBe(403);
    expect(await nameOf("b")).toBe("Shop");
    expect(await nameOf("default")).not.toBe("Shop");
    const audit = await env.DB.prepare(
      "SELECT workspace_id, detail FROM audit WHERE action = 'settings' ORDER BY id",
    ).all();
    expect(audit.results[0]).toEqual({ workspace_id: "b", detail: expect.stringContaining('"name":"Shop"') });
  });

  it("archiving, restoring, adding an admin and changing instance admins ask for a fresh passkey", async () => {
    const ina = await dash("ina", undefined, { stale: true });
    const archivedAt = () => env.DB.prepare("SELECT archived_at FROM workspaces WHERE id = 'b'").first("archived_at");
    expect(await ina("/admin-api/workspaces/b/archive", {})).toMatchObject({ status: 403, json: { verify: true } });
    expect(await archivedAt()).toBeNull();
    await env.DB.prepare("UPDATE workspaces SET archived_at = 1 WHERE id = 'b'").run();
    expect(await ina("/admin-api/workspaces/b/restore", {})).toMatchObject({ status: 403, json: { verify: true } });
    expect(await archivedAt()).toBe(1);
    await env.DB.prepare("UPDATE workspaces SET archived_at = NULL WHERE id = 'b'").run();
    expect(await ina("/admin-api/workspaces/b/admins", { email: "dee@example.com" })).toMatchObject({
      status: 403,
      json: { verify: true },
    });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM invites").first("n")).toBe(0);
    expect(await ina("/admin-api/instance-admins", { userId: "bob", on: true })).toMatchObject({
      status: 403,
      json: { verify: true },
    });
    expect(await env.DB.prepare("SELECT instance_admin FROM users WHERE id = 'bob'").first("instance_admin")).toBe(0);
    // renaming is a setting, not a change to who can do what: no fresh check
    expect((await ina("/admin-api/workspaces/b", { name: "Shop" })).status).toBe(200);
    const bob = await dash("bob", undefined, { stale: true });
    expect((await bob("/admin-api/settings", { name: "Shop 2" })).status).toBe(200);
  });

  it("Get started's time zone step (time zone and digest hour, no name) keeps the workspace's name", async () => {
    const bob = await dash("bob");
    // the body the Get started page sends
    expect((await bob("/admin-api/settings", { timezone: "Europe/Paris", digestHour: 9 })).json).toEqual({
      saved: true,
    });
    expect(await nameOf("b")).toBe("Workspace B");
    expect((await bob("/admin-api/settings")).json).toMatchObject({
      name: "Workspace B",
      timezone: "Europe/Paris",
      digestHour: 9,
    });
  });

  it("makes and unmakes instance admins, never the last one", async () => {
    await env.DB.prepare("UPDATE users SET instance_admin = 0 WHERE id <> 'ina'").run();
    const ina = await dash("ina");
    expect(await ina("/admin-api/instance-admins", { userId: "ina", on: false })).toMatchObject({ status: 409 });
    expect((await ina("/admin-api/instance-admins", { userId: "nobody", on: true })).status).toBe(404);
    expect((await ina("/admin-api/instance-admins", { userId: "bob", on: true })).json).toEqual({
      userId: "bob",
      instanceAdmin: true,
    });
    expect((await ina("/admin-api/instance-admins", { userId: "ina", on: false })).json).toEqual({
      userId: "ina",
      instanceAdmin: false,
    });
    // ina is no longer one; bob is, and now the last
    expect((await ina("/admin-api/workspaces")).status).toBe(403);
    const bob = await dash("bob");
    expect((await bob("/admin-api/instance-admins", { userId: "bob", on: false })).status).toBe(409);
  });

  it("the Members page tells an instance admin who's one, for its Make instance admin control; not anyone else", async () => {
    await env.DB.prepare("UPDATE users SET instance_admin = 0 WHERE id <> 'ina'").run();
    const ina = await dash("ina", "b");
    const flags = async () =>
      ((await ina("/admin-api/members")).json.members as { userId: string; instanceAdmin?: boolean }[])
        .map((m) => [m.userId, m.instanceAdmin])
        .sort();
    expect(await flags()).toEqual([
      ["bob", false],
      ["cara", false],
      ["eda", false],
    ]);
    expect((await ina("/admin-api/instance-admins", { userId: "eda", on: true })).status).toBe(200);
    expect(await flags()).toContainEqual(["eda", true]);
    // B's own admin sees the members, not who runs the instance
    const members = (await (await dash("bob"))("/admin-api/members")).json.members as Record<string, unknown>[];
    expect(members.every((m) => !("instanceAdmin" in m))).toBe(true);
  });
});
