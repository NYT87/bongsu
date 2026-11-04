// Switching the session's workspace (docs/superpowers/specs/2026-11-04-phase13-part2-switching-notifications-design.md,
// sections 1 to 3): which workspaces someone can open (core/workspaces.ts workspacesOf, mayOpen), the dashboard's and
// the app's switch routes, and the lists /admin-api/state and /app-api/me answer. Each app's session keeps its own.
import { env } from "cloudflare:workers";
import { adminRoutes } from "@bongsu/api/dashboard/routes";
import { appRoutes } from "@bongsu/api/pwa/routes";
import { createSession, setSessionWorkspace } from "@bongsu/api/pwa/session";
import type { Verifiers } from "@bongsu/api/pwa/webauthn";
import { upsertAccount, upsertConnection } from "@bongsu/core/accounts";
import type { Env } from "@bongsu/core/env";
import { addMember, archiveWorkspace, createWorkspace } from "@bongsu/core/people";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearPlan, testEnv, World } from "./world";

const nowS = () => Math.floor(Date.now() / 1000);
const fake: Verifiers = {
  registration: (async () => ({ verified: true })) as unknown as Verifiers["registration"],
  authentication: (async () => ({
    verified: true,
    authenticationInfo: { newCounter: 1 },
  })) as unknown as Verifiers["authentication"],
};
const origFetch = globalThis.fetch;
const USERS = ["amy", "cleo", "ina", "otto"];
let w: World;
let e: Env;
/** The second workspace (`Studio Two`), the archived one and one nobody here is in. */
let w2: string;
let gone: string;
let other: string;

type Res = { status: number; json: Record<string, unknown> };
type Session = ((path: string, body?: unknown) => Promise<Res>) & { token: string };
async function req(routes: "dashboard" | "pwa", cookie: string, path: string, body?: unknown): Promise<Res> {
  const app = routes === "dashboard" ? adminRoutes(w.fetch, fake) : appRoutes(w.fetch, fake);
  const r = await app.request(
    `https://bongsu.test${path}`,
    {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    e,
  );
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
}
const session = async (app: "dashboard" | "pwa", userId: string, workspaceId?: string): Promise<Session> => {
  const token = await createSession(env.DB, nowS(), app === "dashboard" ? { app, userId } : { userId });
  if (workspaceId) await setSessionWorkspace(env.DB, token, workspaceId);
  const cookie = `${app === "dashboard" ? "bongsu_admin" : "bongsu_session"}=${token}`;
  return Object.assign((path: string, body?: unknown) => req(app, cookie, path, body), { token });
};
const dash = (userId: string, workspaceId?: string) => session("dashboard", userId, workspaceId);
const app = (userId: string, workspaceId?: string) => session("pwa", userId, workspaceId);
const stateOf = async (s: Session) => (await s("/admin-api/state")).json;
const meOf = async (s: Session) => (await s("/app-api/me")).json;
const opens = () =>
  env.DB.prepare("SELECT workspace_id, actor FROM audit WHERE action = 'workspace_open' ORDER BY id").all();

beforeEach(async () => {
  w = new World();
  globalThis.fetch = w.fetch;
  await clearPlan();
  e = await testEnv(env, { PUBLIC_URL: "https://bongsu.test", RP_ID: "bongsu.test" } as Partial<Env>);
  const ids = USERS.map((u) => `'${u}'`).join(", ");
  await env.DB.batch(
    [
      "DELETE FROM audit",
      "DELETE FROM sessions",
      `DELETE FROM memberships WHERE user_id IN (${ids})`,
      `DELETE FROM users WHERE id IN (${ids})`,
      // amy: an admin of both; cleo: the default workspace's admin and w2's creator; ina: an instance admin in none;
      // otto: the default workspace's editor only
      "INSERT INTO users (id, email, name, created_at) VALUES ('amy', 'amy@example.com', 'Amy', 0)",
      "INSERT INTO users (id, email, name, created_at) VALUES ('cleo', 'cleo@example.com', 'Cleo', 0)",
      "INSERT INTO users (id, email, name, created_at, instance_admin) VALUES ('ina', 'ina@example.com', 'Ina', 0, 1)",
      "INSERT INTO users (id, email, name, created_at) VALUES ('otto', 'otto@example.com', 'Otto', 0)",
    ].map((s) => env.DB.prepare(s)),
  );
  w2 = await createWorkspace(env.DB, { name: "Studio Two", timezone: "Europe/Madrid", createdBy: "amy" }, 0);
  gone = await createWorkspace(env.DB, { name: "Archived Studio", timezone: "UTC", createdBy: "amy" }, 0);
  other = await createWorkspace(env.DB, { name: "Elsewhere", timezone: "UTC", createdBy: "ina" }, 0);
  await addMember(env.DB, "default", "amy", "admin", 0);
  await addMember(env.DB, w2, "amy", "admin", 1);
  await addMember(env.DB, gone, "amy", "admin", 2);
  await archiveWorkspace(env.DB, gone, 3);
  await addMember(env.DB, "default", "cleo", "admin", 0);
  await addMember(env.DB, w2, "cleo", "creator", 1);
  await addMember(env.DB, "default", "otto", "editor", 0);
  await upsertConnection(
    env.DB,
    { id: "c_w2", workspaceId: w2, provider: "composio", kind: "composio", externalRef: "instagram_conn-w2" },
    0,
  );
  await upsertAccount(
    env.DB,
    {
      id: "demo_studio2",
      workspaceId: w2,
      platform: "instagram",
      handle: "demo_studio2",
      externalId: "17841400000000077",
      connectionId: "c_w2",
    },
    0,
  );
});
afterEach(async () => {
  globalThis.fetch = origFetch;
  await env.DB.prepare("DELETE FROM accounts WHERE id = 'demo_studio2'").run();
});

describe("switching the session's workspace", () => {
  it("an admin of both lists both by name, switches to the second, and works there", async () => {
    const amy = await dash("amy", "default");
    const before = await stateOf(amy);
    expect(before.workspace).toEqual({ id: "default", name: "Default" });
    expect(before.workspaces).toEqual([
      { id: "default", name: "Default", role: "admin" },
      { id: w2, name: "Studio Two", role: "admin" },
    ]);
    expect(await amy("/admin-api/session/workspace", { id: w2 })).toEqual({ status: 200, json: { ok: true, id: w2 } });
    expect((await stateOf(amy)).workspace).toEqual({ id: w2, name: "Studio Two" });
    const accounts = (await amy("/admin-api/accounts")).json.accounts as { id: string }[];
    expect(accounts.map((a) => a.id)).toEqual(["demo_studio2"]);
    // a member moving between their own workspaces leaves no audit row
    expect((await opens()).results).toEqual([]);
    // the app's list is the same, and its switch works the same way
    const amyApp = await app("amy", "default");
    expect((await meOf(amyApp)).workspaces).toEqual(before.workspaces);
    expect(await amyApp("/app-api/session/workspace", { id: w2 })).toEqual({ status: 200, json: { ok: true, id: w2 } });
    expect((await meOf(amyApp)).workspace).toEqual({ id: w2, name: "Studio Two" });
  });

  it("a creator in w2 can't open it in the dashboard, but can in the app", async () => {
    const cleo = await dash("cleo", "default");
    expect((await stateOf(cleo)).workspaces).toEqual([{ id: "default", name: "Default", role: "admin" }]);
    expect(await cleo("/admin-api/session/workspace", { id: w2 })).toEqual({
      status: 403,
      json: { error: "you can't open that workspace" },
    });
    expect((await stateOf(cleo)).workspace).toEqual({ id: "default", name: "Default" });

    const cleoApp = await app("cleo", "default");
    expect((await meOf(cleoApp)).workspaces).toEqual([
      { id: "default", name: "Default", role: "admin" },
      { id: w2, name: "Studio Two", role: "creator" },
    ]);
    expect((await cleoApp("/app-api/session/workspace", { id: w2 })).status).toBe(200);
    const me = await meOf(cleoApp);
    expect(me.workspace).toEqual({ id: w2, name: "Studio Two" });
    // and works there: w2's zone
    expect(me.workspaceTimezone).toBe("Europe/Madrid");
  });

  it("refuses an archived workspace, one the person isn't in and one that doesn't exist; the session stays", async () => {
    const amy = await dash("amy", "default");
    const amyApp = await app("amy", "default");
    for (const id of [gone, other, "nope", ""]) {
      expect(await amy("/admin-api/session/workspace", { id }), id).toEqual({
        status: 403,
        json: { error: "you can't open that workspace" },
      });
      expect((await amyApp("/app-api/session/workspace", { id })).status, id).toBe(403);
    }
    expect((await stateOf(amy)).workspace).toEqual({ id: "default", name: "Default" });
    expect((await meOf(amyApp)).workspace).toEqual({ id: "default", name: "Default" });
    // the archived one isn't offered either
    expect(((await stateOf(amy)).workspaces as { id: string }[]).map((x) => x.id)).not.toContain(gone);
  });

  it("an instance admin opens any workspace that isn't archived, as its admin, and its admins see it", async () => {
    const ina = await dash("ina");
    const listed = (await stateOf(ina)).workspaces as { id: string; role: string }[];
    expect(listed).toEqual(expect.arrayContaining([{ id: other, name: "Elsewhere", role: "admin" }]));
    expect(listed.map((x) => x.id)).not.toContain(gone);
    const names = (listed as unknown as { name: string }[]).map((x) => x.name);
    expect(names).toEqual([...names].sort());
    expect(await ina("/admin-api/session/workspace", { id: other })).toEqual({
      status: 200,
      json: { ok: true, id: other },
    });
    expect(await stateOf(ina)).toMatchObject({ workspace: { id: other, name: "Elsewhere" }, role: "admin" });
    expect((await opens()).results).toEqual([{ workspace_id: other, actor: "user:ina" }]);
    expect((await ina("/admin-api/session/workspace", { id: gone })).status).toBe(403);
    // the old route still answers as it did
    expect(await ina(`/admin-api/workspaces/${w2}/open`, {})).toEqual({ status: 200, json: { id: w2 } });
    expect((await stateOf(ina)).workspace).toEqual({ id: w2, name: "Studio Two" });
    expect((await ina("/admin-api/workspaces/nope/open", {})).status).toBe(404);
    expect((await ina(`/admin-api/workspaces/${gone}/open`, {})).status).toBe(409);
    expect((await opens()).results).toEqual([
      { workspace_id: other, actor: "user:ina" },
      { workspace_id: w2, actor: "user:ina" },
    ]);
  });

  it("a switch in the app doesn't move the dashboard's session", async () => {
    const amy = await dash("amy", "default");
    const amyApp = await app("amy", "default");
    expect((await amyApp("/app-api/session/workspace", { id: w2 })).status).toBe(200);
    expect((await stateOf(amy)).workspace).toEqual({ id: "default", name: "Default" });
    expect((await amy("/admin-api/session/workspace", { id: w2 })).status).toBe(200);
    expect((await amy("/admin-api/session/workspace", { id: "default" })).status).toBe(200);
    expect((await meOf(amyApp)).workspace).toEqual({ id: w2, name: "Studio Two" });
  });

  it("one workspace: the list has just it", async () => {
    const otto = await app("otto");
    expect(await meOf(otto)).toMatchObject({
      workspace: { id: "default", name: "Default" },
      workspaces: [{ id: "default", name: "Default", role: "editor" }],
    });
  });

  it("signed out: the switches answer 401, and the lists are empty", async () => {
    expect((await req("pwa", "", "/app-api/session/workspace", { id: "default" })).status).toBe(401);
    expect((await req("dashboard", "", "/admin-api/session/workspace", { id: "default" })).status).toBe(401);
    expect((await req("pwa", "", "/app-api/me")).json).toMatchObject({ workspace: null, workspaces: [] });
    expect((await req("dashboard", "", "/admin-api/state")).json).toMatchObject({ workspace: null, workspaces: [] });
  });
});
