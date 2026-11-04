// The roles table (docs/superpowers/specs/2026-11-04-phase13-people-roles-design.md, section 1), one test per row:
// what an admin, an editor, a creator and an instance admin may do in the dashboard, the app and with a CLI token.
// Approval stays human: a role that edits but can't approve (the editor) never gets "approve", in any of them.
import { env } from "cloudflare:workers";
import { authenticate } from "@bongsu/api/agent/auth";
import { adminRoutes } from "@bongsu/api/dashboard/routes";
import { appRoutes } from "@bongsu/api/pwa/routes";
import { createSession, setSessionWorkspace } from "@bongsu/api/pwa/session";
import type { Verifiers } from "@bongsu/api/pwa/webauthn";
import type { Env } from "@bongsu/core/env";
import { sha256Hex } from "@bongsu/core/formats/approved";
import { isInstanceAdmin } from "@bongsu/core/roles";
import { sessionWorkspace } from "@bongsu/core/workspaces";
import { beforeEach, describe, expect, it } from "vitest";
import { testEnv, World } from "./world";

const nowS = () => Math.floor(Date.now() / 1000);
const fake: Verifiers = {
  registration: (async () => ({ verified: true })) as unknown as Verifiers["registration"],
  authentication: (async () => ({
    verified: true,
    authenticationInfo: { newCounter: 1 },
  })) as unknown as Verifiers["authentication"],
};

let w: World;
let e: Env;

type Call = (path: string, body?: unknown) => Promise<{ status: number; json: Record<string, unknown> }>;
const caller =
  (routes: "dashboard" | "pwa", cookie: string): Call =>
  async (path, body) => {
    const app = routes === "dashboard" ? adminRoutes(w.fetch, fake) : appRoutes(w.fetch, fake);
    const r = await app.request(
      `https://bongsu.test${path}`,
      {
        method: body === undefined ? "GET" : "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      e,
    );
    return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
  };
const setRole = (userId: string, role: string) =>
  env.DB.prepare(
    "INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES ('default', ?1, ?2, 0) ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = ?2",
  )
    .bind(userId, role)
    .run();
/** Bea, a plain user, with `role` in the default workspace: her dashboard session, or her app session. */
const asRole = async (role: string, app: "dashboard" | "pwa" = "dashboard") => {
  await setRole("bea", role);
  return app === "dashboard"
    ? caller(app, `bongsu_admin=${await createSession(env.DB, nowS(), { app: "dashboard", userId: "bea" })}`)
    : caller(app, `bongsu_session=${await createSession(env.DB, nowS(), { userId: "bea" })}`);
};
/** Ina, an instance admin: with no membership, or (given a role) a member of the default workspace with that role. */
const asInstanceAdmin = async (role?: string, app: "dashboard" | "pwa" = "dashboard") => {
  if (role) await setRole("ina", role);
  return app === "dashboard"
    ? caller(app, `bongsu_admin=${await createSession(env.DB, nowS(), { app: "dashboard", userId: "ina" })}`)
    : caller(app, `bongsu_session=${await createSession(env.DB, nowS(), { userId: "ina" })}`);
};
/** A CLI token of `userId` in the default workspace: the scopes it carries. */
const tokenScopes = async (userId: string) => {
  const token = `bongsu_cli_${userId}${"x".repeat(32 - userId.length)}`;
  await env.DB.prepare(
    "INSERT INTO api_keys (id, name, key_hash, scopes, workspace_id, user_id, expires_at) VALUES (?1, 'cli', ?2, '[]', 'default', ?3, ?4) ON CONFLICT (id) DO NOTHING",
  )
    .bind(`t_${userId}`, await sha256Hex(token), userId, nowS() + 86400)
    .run();
  return (await authenticate(env.DB, `Bearer ${token}`, nowS()))?.scopes ?? null;
};

beforeEach(async () => {
  w = new World();
  e = await testEnv(env, { PUBLIC_URL: "https://bongsu.test", RP_ID: "bongsu.test" } as Partial<Env>);
  await env.DB.batch(
    [
      "DELETE FROM sessions",
      "DELETE FROM api_keys",
      "UPDATE workspace_settings SET paused = NULL",
      "DELETE FROM memberships WHERE user_id IN ('bea', 'ina', 'dee')",
      "INSERT INTO workspaces (id, name, created_at) VALUES ('b', 'Workspace B', 0) ON CONFLICT (id) DO UPDATE SET archived_at = NULL",
      "UPDATE workspaces SET archived_at = NULL",
      "INSERT INTO users (id, name, created_at, instance_admin) VALUES ('dee', 'Dee', 0, 0) ON CONFLICT (id) DO UPDATE SET instance_admin = 0",
      "INSERT INTO users (id, name, created_at, instance_admin) VALUES ('bea', 'Bea', 0, 0) ON CONFLICT (id) DO UPDATE SET instance_admin = 0",
      "INSERT INTO users (id, name, created_at, instance_admin) VALUES ('ina', 'Ina', 0, 1) ON CONFLICT (id) DO UPDATE SET instance_admin = 1",
    ].map((s) => env.DB.prepare(s)),
  );
});

describe("the roles table", () => {
  it("knows who is an instance admin", async () => {
    expect(await isInstanceAdmin(env.DB, "ina")).toBe(true);
    expect(await isInstanceAdmin(env.DB, "bea")).toBe(false);
    expect(await isInstanceAdmin(env.DB, "nobody")).toBe(false);
  });

  it("dashboard: admins, editors and instance admins; a creator is pointed at the app", async () => {
    for (const role of ["admin", "editor"]) {
      const call = await asRole(role);
      expect((await call("/admin-api/overview")).status, role).toBe(200);
      expect((await call("/admin-api/passkeys")).status, role).toBe(200);
    }
    expect((await (await asInstanceAdmin("editor"))("/admin-api/overview")).status).toBe(200);
    const creator = await asRole("creator");
    for (const path of ["/admin-api/overview", "/admin-api/passkeys", "/admin-api/tokens", "/admin-api/audit"]) {
      const r = await creator(path);
      expect([r.status, r.json], path).toEqual([403, { error: "creators use the Bongsu app", app: true }]);
    }
    expect((await creator("/admin-api/tokens", { name: "laptop", days: 30 })).status).toBe(403);
    // what the sign-in page needs, and the way out, still answer
    expect((await creator("/admin-api/state")).json).toMatchObject({ signedIn: true, role: "creator" });
    expect((await creator("/admin-api/signout", {})).status).toBe(200);
  });

  it("PWA: every role", async () => {
    for (const role of ["admin", "editor", "creator"]) {
      const call = await asRole(role, "pwa");
      expect((await call("/app-api/status")).status, role).toBe(200);
      expect((await call("/app-api/queue")).status, role).toBe(200);
    }
    expect((await (await asInstanceAdmin("editor", "pwa"))("/app-api/status")).status).toBe(200);
  });

  it("instance settings (Media, OAuth apps) and the Workspaces page: instance admins only, reading included", async () => {
    for (const role of ["admin", "editor", "creator"]) {
      const call = await asRole(role);
      expect((await call("/admin-api/media-stores")).status, role).toBe(403);
      expect((await call("/admin-api/oauth-apps")).status, role).toBe(403);
      expect((await call("/admin-api/media-stores/s3", { bucket: "x" })).status, role).toBe(403);
      expect((await call("/admin-api/oauth-apps/instagram", { clientId: "x" })).status, role).toBe(403);
      expect((await call("/admin-api/workspaces")).status, role).toBe(403);
      expect((await call("/admin-api/instance-admins")).status, role).toBe(403);
    }
    // with no membership at all
    const ina = await asInstanceAdmin();
    expect((await ina("/admin-api/media-stores")).status).toBe(200);
    expect((await ina("/admin-api/oauth-apps")).status).toBe(200);
    expect((await ina("/admin-api/workspaces")).status).toBe(200);
    expect((await ina("/admin-api/state")).json).toMatchObject({ signedIn: true, instanceAdmin: true });
    expect((await (await asRole("admin"))("/admin-api/state")).json).toMatchObject({ instanceAdmin: false });
  });

  it("members (invite, change role, remove): admins and instance admins", async () => {
    for (const role of ["editor", "creator"]) {
      const call = await asRole(role);
      expect((await call("/admin-api/members/x/role", { role: "admin" })).status, role).toBe(403);
      expect((await call("/admin-api/invites", { email: "a@example.com" })).status, role).toBe(403);
    }
    // past the guard: the route's own check (a role is missing)
    expect((await (await asRole("admin"))("/admin-api/invites", { email: "a@example.com" })).status).toBe(400);
    expect((await (await asInstanceAdmin("editor"))("/admin-api/invites", { email: "a@example.com" })).status).toBe(
      400,
    );
  });

  it("connections, accounts, settings, agent keys: admins and instance admins; an editor only reads the accounts", async () => {
    const editor = await asRole("editor");
    expect((await editor("/admin-api/keys", { name: "k", scopes: ["plan"] })).status).toBe(403);
    expect((await editor("/admin-api/settings", { timezone: "Europe/Madrid" })).status).toBe(403);
    expect((await editor("/admin-api/settings/ntfy", { url: "https://ntfy.sh/x" })).status).toBe(403);
    expect((await editor("/admin-api/accounts/demo_travel", { captionRules: { hashtagMax: 3 } })).status).toBe(403);
    expect((await editor("/admin-api/connections/c1/remove", {})).status).toBe(403);
    expect((await editor("/admin-api/connect/instagram/start", {})).status).toBe(403);
    // not even read: the workspace's agent keys, connections, settings, members and invites
    for (const path of [
      "/admin-api/keys",
      "/admin-api/connections",
      "/admin-api/settings",
      "/admin-api/settings/ntfy",
      "/admin-api/members",
      "/admin-api/invites",
    ]) {
      const r = await editor(path);
      expect([r.status, r.json.error], path).toEqual([403, "only an admin of the workspace can see this"]);
    }
    // what an editor reads: the overview, the accounts, the videos, and their own passkeys, devices and CLI tokens
    for (const path of ["/admin-api/overview", "/admin-api/accounts", "/admin-api/videos", "/admin-api/passkeys"])
      expect((await editor(path)).status, path).toBe(200);
    const tokens = await editor("/admin-api/tokens");
    expect([tokens.status, tokens.json.rights]).toEqual([200, ["read", "draft", "plan", "reschedule", "metrics"]]);
    expect((await editor("/admin-api/tokens", { name: "laptop", days: 30 })).status).toBe(200);
    for (const call of [await asRole("admin"), await asInstanceAdmin("editor")]) {
      for (const path of ["/admin-api/keys", "/admin-api/connections", "/admin-api/settings"])
        expect((await call(path)).status, path).toBe(200);
      expect((await call("/admin-api/keys", { name: "k", scopes: ["plan"] })).status).toBe(200);
      expect((await call("/admin-api/settings", { timezone: "Asia/Seoul" })).status).toBe(200);
    }
  });

  it("plan, texts, drafts, release dates: every role", async () => {
    for (const role of ["admin", "editor", "creator"]) {
      const call = await asRole(role, "pwa");
      expect((await call("/app-api/item/hold", { key: "reel:x/y", hold: true })).status, role).toBe(404); // no item
      expect((await call("/app-api/item/texts", { key: "reel:x/y", caption: "x" })).status, role).toBe(404);
    }
    // the dashboard's Videos page moves a release date for admins and editors (a creator uses the app)
    for (const role of ["admin", "editor"]) {
      const r = await (await asRole(role))("/admin-api/videos/v1/release", {});
      expect([r.status, r.json.error], role).toEqual([400, "give a date and time"]); // past the guard
    }
  });

  it("approve, pause, resume: admins, creators and instance admins, never editors", async () => {
    const editor = await asRole("editor", "pwa");
    for (const [path, b] of [
      ["/app-api/approve/options", { key: "reel:x/y" }],
      ["/app-api/approve/verify", {}],
      ["/app-api/resume/options", {}],
      ["/app-api/resume/verify", {}],
      ["/app-api/pause", { reason: "x" }],
    ] as const) {
      const r = await editor(path, b);
      expect([r.status, r.json.error], path).toEqual([403, expect.stringMatching(/your role/)]);
    }
    expect(await env.DB.prepare("SELECT 1 FROM workspace_settings WHERE paused IS NOT NULL").first()).toBeNull();
    // what the app shows: an editor's scopes have no approve, pause or resume
    expect((await editor("/app-api/me")).json.scopes).toEqual(["read", "draft", "plan", "reschedule", "metrics"]);
    for (const call of [
      await asRole("admin", "pwa"),
      await asRole("creator", "pwa"),
      await asInstanceAdmin("editor", "pwa"),
    ]) {
      expect((await call("/app-api/approve/options", { key: "reel:x/y" })).status).toBe(404); // allowed; no item
      expect((await call("/app-api/resume/options", {})).status).toBe(200);
      expect((await call("/app-api/pause", { reason: "x" })).status).toBe(200);
      await env.DB.prepare("UPDATE workspace_settings SET paused = NULL").run();
    }
    expect((await (await asRole("creator", "pwa"))("/app-api/me")).json.scopes).toContain("approve");
  });

  it("a CLI token carries the role's rights: approve for admins, creators and instance admins, never editors", async () => {
    const all = ["read", "draft", "plan", "pause", "reschedule", "metrics", "approve", "resume"];
    await setRole("bea", "admin");
    expect(await tokenScopes("bea")).toEqual(all);
    await setRole("bea", "creator");
    expect(await tokenScopes("bea")).toEqual(all);
    await setRole("bea", "editor");
    expect(await tokenScopes("bea")).toEqual(["read", "draft", "plan", "reschedule", "metrics"]);
    // an instance admin acts with an admin's rights, whatever their role in the workspace
    await setRole("ina", "editor");
    expect(await tokenScopes("ina")).toEqual(all);
  });

  it("stats and comments: every role", async () => {
    for (const role of ["admin", "editor", "creator"]) {
      const call = await asRole(role, "pwa");
      expect((await call("/app-api/stats")).status, role).toBe(200);
      expect((await call("/app-api/comments")).status, role).toBe(200);
      expect((await call("/app-api/comments/seen", {})).status, role).toBe(200);
    }
  });
});

/** A session of `userId` in `app` that names `workspaceId` (as the Workspaces page's "open" will). */
const sessionIn = async (userId: string, workspaceId: string | null, app: "dashboard" | "pwa" = "dashboard") => {
  const token = await createSession(env.DB, nowS(), { app, userId });
  if (workspaceId) await setSessionWorkspace(env.DB, token, workspaceId);
  return caller(app, `${app === "dashboard" ? "bongsu_admin" : "bongsu_session"}=${token}`);
};
const member = (workspaceId: string, userId: string, role: string) =>
  env.DB.prepare("INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES (?1, ?2, ?3, 0)")
    .bind(workspaceId, userId, role)
    .run();
const zoneOf = async (workspaceId: string) =>
  (
    await env.DB.prepare("SELECT timezone FROM workspace_settings WHERE workspace_id = ?1")
      .bind(workspaceId)
      .first<{ timezone: string }>()
  )?.timezone ?? null;

describe("a request's workspace", () => {
  it("uses the role of the request's workspace for a user in two", async () => {
    await member("default", "dee", "editor");
    await member("b", "dee", "admin");
    // she joined b later: the default workspace is her first (the oldest membership)
    await env.DB.prepare("UPDATE memberships SET created_at = 1 WHERE user_id = 'dee' AND workspace_id = 'b'").run();
    const before = await zoneOf("default");
    const inB = await sessionIn("dee", "b");
    expect((await inB("/admin-api/settings", { timezone: "Asia/Seoul" })).status).toBe(200);
    expect(await zoneOf("b")).toBe("Asia/Seoul");
    expect(await zoneOf("default")).toBe(before);
    expect((await inB("/admin-api/state")).json).toMatchObject({ role: "admin" });
    const inDefault = await sessionIn("dee", "default");
    expect((await inDefault("/admin-api/settings", { timezone: "Europe/Madrid" })).status).toBe(403);
    expect((await inDefault("/admin-api/state")).json).toMatchObject({ role: "editor" });
    // the app too: in b she approves, in the default workspace (an editor) she doesn't
    expect((await (await sessionIn("dee", "b", "pwa"))("/app-api/me")).json.scopes).toContain("approve");
    expect((await (await sessionIn("dee", "default", "pwa"))("/app-api/me")).json.scopes).not.toContain("approve");
    // a session that names no workspace works in her first one
    expect(await sessionWorkspace(env.DB, { userId: "dee", workspaceId: null })).toEqual({
      workspaceId: "default",
      role: "editor",
      instanceAdmin: false,
    });
    // only her first one when the session names a workspace she isn't in
    expect(await sessionWorkspace(env.DB, { userId: "dee", workspaceId: "nowhere" })).toMatchObject({
      workspaceId: "default",
    });
    // a user whose only workspace is archived works nowhere
    await member("b", "bea", "admin");
    await env.DB.prepare("UPDATE workspaces SET archived_at = 1 WHERE id = 'b'").run();
    expect(await sessionWorkspace(env.DB, { userId: "bea", workspaceId: "b" })).toBeNull();
    expect(await sessionWorkspace(env.DB, { userId: "bea", workspaceId: null })).toBeNull();
    for (const app of ["dashboard", "pwa"] as const) {
      const r = await (await sessionIn("bea", "b", app))(
        app === "dashboard" ? "/admin-api/overview" : "/app-api/status",
      );
      expect([r.status, r.json], app).toEqual([
        403,
        { error: "you're not a member of any workspace", noWorkspace: true },
      ]);
    }
    // and Dee, whose session names the archived one, is back in the default workspace
    expect((await inB("/admin-api/state")).json).toMatchObject({ role: "editor" });
    expect((await inB("/admin-api/settings", { timezone: "Asia/Seoul" })).status).toBe(403);
  });

  it("the dashboard lands a creator somewhere who's an editor elsewhere where they edit; the app keeps the oldest", async () => {
    await member("default", "dee", "creator");
    await member("b", "dee", "editor");
    await env.DB.prepare("UPDATE memberships SET created_at = 1 WHERE user_id = 'dee' AND workspace_id = 'b'").run();
    const dash = await sessionIn("dee", null);
    expect((await dash("/admin-api/state")).json).toMatchObject({ role: "editor", noWorkspace: false });
    expect((await dash("/admin-api/overview")).status).toBe(200);
    expect(await sessionWorkspace(env.DB, { userId: "dee", workspaceId: null }, { notCreator: true })).toMatchObject({
      workspaceId: "b",
      role: "editor",
    });
    // the app takes creators: there the oldest membership still comes first
    expect(await sessionWorkspace(env.DB, { userId: "dee", workspaceId: null })).toMatchObject({
      workspaceId: "default",
      role: "creator",
    });
  });

  it("an instance admin acts as an admin in the workspace their session names, without a membership", async () => {
    expect(await sessionWorkspace(env.DB, { userId: "ina", workspaceId: "b" })).toEqual({
      workspaceId: "b",
      role: "admin",
      instanceAdmin: true,
    });
    const ina = await sessionIn("ina", "b");
    expect((await ina("/admin-api/settings", { timezone: "Asia/Tokyo" })).status).toBe(200);
    expect(await zoneOf("b")).toBe("Asia/Tokyo");
    expect((await ina("/admin-api/state")).json).toMatchObject({ role: "admin", instanceAdmin: true });
    expect((await (await sessionIn("ina", "b", "pwa"))("/app-api/status")).status).toBe(200);
    // not in an archived one, nor in one that doesn't exist
    expect(await sessionWorkspace(env.DB, { userId: "ina", workspaceId: "nowhere" })).toBeNull();
    await env.DB.prepare("UPDATE workspaces SET archived_at = 1 WHERE id = 'b'").run();
    expect(await sessionWorkspace(env.DB, { userId: "ina", workspaceId: "b" })).toBeNull();
    expect((await ina("/admin-api/settings", { timezone: "Asia/Seoul" })).status).toBe(403);
    // the instance's own pages still answer
    expect((await ina("/admin-api/media-stores")).status).toBe(200);
  });

  it("the app's signed-in routes need a session: no default caller", async () => {
    const anon = caller("pwa", "");
    for (const path of ["/app-api/status", "/app-api/queue", "/app-api/me/timezone"])
      expect((await anon(path)).status, path).toBe(401);
    // who am I answers signed out, read-only
    expect((await anon("/app-api/me")).json).toMatchObject({ signedIn: false, scopes: [] });
  });

  it("who am I, signed in without a workspace: says so, on UTC, never the default workspace's zone", async () => {
    const tz = await zoneOf("default");
    await env.DB.prepare("UPDATE workspace_settings SET timezone = 'Asia/Tokyo' WHERE workspace_id = 'default'").run();
    const ina = await sessionIn("ina", null, "pwa"); // an instance admin with no membership
    expect((await ina("/app-api/me")).json).toMatchObject({
      signedIn: true,
      noWorkspace: true,
      scopes: [],
      accounts: 0,
      timezone: "UTC",
      workspaceTimezone: "UTC",
    });
    // the user's own zone still counts
    await env.DB.prepare("UPDATE users SET timezone = 'Europe/Madrid' WHERE id = 'ina'").run();
    expect((await ina("/app-api/me")).json).toMatchObject({ timezone: "Europe/Madrid", workspaceTimezone: "UTC" });
    // a member: no flag
    expect((await (await sessionIn("ina", "b", "pwa"))("/app-api/me")).json).toMatchObject({ noWorkspace: false });
    await env.DB.prepare("UPDATE users SET timezone = NULL WHERE id = 'ina'").run();
    await env.DB.prepare("UPDATE workspace_settings SET timezone = ?1 WHERE workspace_id = 'default'").bind(tz).run();
  });
});
