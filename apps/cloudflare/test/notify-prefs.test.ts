// The app's notification settings (Phase 13 part 2): GET and PUT /app-api/notify-prefs read and change the signed-in
// person's own groups in the session's workspace. Runs on real SQL (D1): the role defaults, the row deleted when a
// setting goes back to its default, and a role change moving whoever hasn't chosen.
import { env, exports } from "cloudflare:workers";
import { appRoutes } from "@bongsu/api/pwa/routes";
import { createSession, setSessionWorkspace } from "@bongsu/api/pwa/session";
import type { Env } from "@bongsu/core/env";
import { sha256Hex } from "@bongsu/core/formats/approved";
import { setRole } from "@bongsu/core/invites";
import { addMember, createWorkspace } from "@bongsu/core/people";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearPlan, testEnv, World } from "./world";

const nowS = () => Math.floor(Date.now() / 1000);
const origFetch = globalThis.fetch;
const USERS = ["amy", "otto", "ina", "ivy"];
let w: World;
let e: Env;

type Group = { grp: string; enabled: boolean; isDefault: boolean };
const req = async (cookie: string, method: "GET" | "PUT", body?: unknown) => {
  const r = await appRoutes(w.fetch).request(
    "https://bongsu.test/app-api/notify-prefs",
    {
      method,
      headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    e,
  );
  return { status: r.status, json: (await r.json().catch(() => ({}))) as { groups?: Group[]; error?: string } };
};
/** A signed-in person's calls: their own session, in `workspaceId` when given. */
const as = async (userId: string, workspaceId?: string) => {
  const token = await createSession(env.DB, nowS(), { userId });
  if (workspaceId) await setSessionWorkspace(env.DB, token, workspaceId);
  const cookie = `bongsu_session=${token}`;
  return {
    get: () => req(cookie, "GET"),
    put: (body: unknown) => req(cookie, "PUT", body),
  };
};
const rows = (userId: string, ws = "default") =>
  env.DB.prepare("SELECT grp, enabled FROM notify_prefs WHERE workspace_id = ?1 AND user_id = ?2 ORDER BY grp")
    .bind(ws, userId)
    .all();
const of = (r: { json: { groups?: Group[] } }, grp: string) => r.json.groups?.find((g) => g.grp === grp);

beforeEach(async () => {
  w = new World();
  globalThis.fetch = w.fetch;
  await clearPlan();
  e = await testEnv(env, { PUBLIC_URL: "https://bongsu.test", RP_ID: "bongsu.test" } as Partial<Env>);
  const ids = USERS.map((u) => `'${u}'`).join(", ");
  await env.DB.batch(
    [
      "DELETE FROM sessions",
      "DELETE FROM notify_prefs",
      `DELETE FROM memberships WHERE user_id IN (${ids})`,
      `DELETE FROM users WHERE id IN (${ids})`,
      "INSERT INTO users (id, email, name, created_at) VALUES ('amy', 'amy@example.com', 'Amy', 0)",
      "INSERT INTO users (id, email, name, created_at) VALUES ('otto', 'otto@example.com', 'Otto', 0)",
      // ina: an instance admin in no workspace; ivy: an instance admin who is the default workspace's editor
      "INSERT INTO users (id, email, name, created_at, instance_admin) VALUES ('ina', 'ina@example.com', 'Ina', 0, 1)",
      "INSERT INTO users (id, email, name, created_at, instance_admin) VALUES ('ivy', 'ivy@example.com', 'Ivy', 0, 1)",
    ].map((s) => env.DB.prepare(s)),
  );
  await addMember(env.DB, "default", "amy", "admin", 0);
  await addMember(env.DB, "default", "otto", "editor", 0);
  await addMember(env.DB, "default", "ivy", "editor", 0);
});
afterEach(() => {
  globalThis.fetch = origFetch;
});

describe("GET and PUT /app-api/notify-prefs", () => {
  it("lists the five groups in order, the role's defaults for someone who chose nothing", async () => {
    const admin = await (await as("amy")).get();
    expect(admin.status).toBe(200);
    expect(admin.json.groups).toEqual(
      ["needs_you", "problems", "published", "inbox", "digest"].map((grp) => ({ grp, enabled: true, isDefault: true })),
    );
    const editor = await (await as("otto")).get();
    expect(of(editor, "needs_you")).toEqual({ grp: "needs_you", enabled: false, isDefault: true });
    expect(editor.json.groups?.filter((g) => g.enabled).length).toBe(4);
  });

  it("a change shows on the next GET from the stored row, and going back to the default deletes the row", async () => {
    const amy = await as("amy");
    const off = await amy.put({ grp: "problems", enabled: false });
    expect(off.status).toBe(200);
    expect(of(off, "problems")).toEqual({ grp: "problems", enabled: false, isDefault: false });
    expect((await rows("amy")).results).toEqual([{ grp: "problems", enabled: 0 }]);
    expect(of(await amy.get(), "problems")).toEqual({ grp: "problems", enabled: false, isDefault: false });

    const back = await amy.put({ grp: "problems", enabled: true });
    expect(of(back, "problems")).toEqual({ grp: "problems", enabled: true, isDefault: true });
    expect((await rows("amy")).results).toEqual([]);
    expect(of(await amy.get(), "problems")).toEqual({ grp: "problems", enabled: true, isDefault: true });
  });

  it("an editor can turn needs_you on (a stored row), and back off (no row)", async () => {
    const otto = await as("otto");
    expect(of(await otto.put({ grp: "needs_you", enabled: true }), "needs_you")).toEqual({
      grp: "needs_you",
      enabled: true,
      isDefault: false,
    });
    expect((await rows("otto")).results).toEqual([{ grp: "needs_you", enabled: 1 }]);
    await otto.put({ grp: "needs_you", enabled: false });
    expect((await rows("otto")).results).toEqual([]);
  });

  it("a muted group stays muted when the role changes, and an untouched one follows the new default", async () => {
    const amy = await as("amy");
    await amy.put({ grp: "published", enabled: false });
    expect(of(await amy.get(), "needs_you")?.enabled).toBe(true);
    await setRole(env.DB, "default", "amy", "editor", { instanceAdmin: true }, nowS());
    const after = await amy.get();
    expect(of(after, "published")).toEqual({ grp: "published", enabled: false, isDefault: false });
    expect(of(after, "needs_you")).toEqual({ grp: "needs_you", enabled: false, isDefault: true });
  });

  it("refuses an unknown group and a non-boolean enabled with a 400, and changes nothing", async () => {
    const amy = await as("amy");
    for (const bad of [{ grp: "everything", enabled: true }, { enabled: true }, { grp: 3, enabled: true }]) {
      const r = await amy.put(bad);
      expect([r.status, r.json.error]).toEqual([400, "unknown group"]);
    }
    for (const enabled of ["false", 0, null, undefined]) {
      const r = await amy.put({ grp: "problems", enabled });
      expect(r.status, String(enabled)).toBe(400);
    }
    expect((await rows("amy")).results).toEqual([]);
  });

  it("signed out gets a 401, on both", async () => {
    expect((await req("", "GET")).status).toBe(401);
    expect((await req("", "PUT", { grp: "problems", enabled: false })).status).toBe(401);
  });

  it("settings are per workspace: the same person's other workspace keeps its own", async () => {
    const w2 = await createWorkspace(env.DB, { name: "Studio Two", timezone: "UTC", createdBy: "amy" }, 0);
    await addMember(env.DB, w2, "amy", "admin", 1);
    await (await as("amy", w2)).put({ grp: "digest", enabled: false });
    expect(of(await (await as("amy", "default")).get(), "digest")?.enabled).toBe(true);
    expect(of(await (await as("amy", w2)).get(), "digest")?.enabled).toBe(false);
    expect((await rows("amy", "default")).results).toEqual([]);
  });

  it("an instance admin who is an editor member gets the editor's defaults, not an admin's", async () => {
    const ivy = await as("ivy");
    expect(of(await ivy.get(), "needs_you")).toEqual({ grp: "needs_you", enabled: false, isDefault: true });
    expect(of(await ivy.put({ grp: "needs_you", enabled: true }), "needs_you")).toEqual({
      grp: "needs_you",
      enabled: true,
      isDefault: false,
    });
    expect((await rows("ivy")).results).toEqual([{ grp: "needs_you", enabled: 1 }]);
  });

  it("an instance admin who isn't a member there gets a 403 on both, and no row is written", async () => {
    const ina = await as("ina", "default");
    const msg = "you get no notifications from a workspace you're not a member of";
    for (const r of [await ina.get(), await ina.put({ grp: "problems", enabled: false })])
      expect([r.status, r.json.error]).toEqual([403, msg]);
    expect((await rows("ina")).results).toEqual([]);
  });

  it("an agent key is refused on both, and writes no row", async () => {
    const key = "bongsu_notifyPrefsAgentKeyNotifyP";
    await env.DB.prepare(
      "INSERT INTO api_keys (id, name, key_hash, scopes, workspace_id) VALUES ('kn', 'kn', ?1, '[\"read\",\"draft\",\"plan\",\"reschedule\"]', 'default')",
    )
      .bind(await sha256Hex(key))
      .run();
    for (const [method, body] of [
      ["GET", undefined],
      ["PUT", JSON.stringify({ grp: "problems", enabled: false })],
    ] as const) {
      const r = await exports.default.fetch("https://scheduler.test/app-api/notify-prefs", {
        method,
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        ...(body ? { body } : {}),
      });
      expect(r.status, method).toBe(401);
    }
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM notify_prefs").first("n")).toBe(0);
    await env.DB.prepare("DELETE FROM api_keys WHERE id = 'kn'").run();
  });
});
