// The roles table (docs/superpowers/specs/2026-11-04-phase13-people-roles-design.md, section 1), one test per row:
// what an admin, an editor, a creator and an instance admin may do in the dashboard, the app and with a CLI token.
// Approval stays human: a role that edits but can't approve (the editor) never gets "approve", in any of them.
import { env } from "cloudflare:workers";
import { authenticate } from "@bongsu/api/agent/auth";
import { adminRoutes } from "@bongsu/api/dashboard/routes";
import { appRoutes } from "@bongsu/api/pwa/routes";
import { createSession } from "@bongsu/api/pwa/session";
import type { Verifiers } from "@bongsu/api/pwa/webauthn";
import type { Env } from "@bongsu/core/env";
import { sha256Hex } from "@bongsu/core/formats/approved";
import { isInstanceAdmin } from "@bongsu/core/roles";
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
      "DELETE FROM settings WHERE key = 'paused'",
      "DELETE FROM memberships WHERE user_id IN ('bea', 'ina')",
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
    expect((await ina("/admin-api/workspaces")).status).toBe(404); // past the guard; the page comes later
    expect((await ina("/admin-api/state")).json).toMatchObject({ signedIn: true, instanceAdmin: true });
    expect((await (await asRole("admin"))("/admin-api/state")).json).toMatchObject({ instanceAdmin: false });
  });

  it("members (invite, change role, remove): admins and instance admins", async () => {
    for (const role of ["editor", "creator"]) {
      const call = await asRole(role);
      expect((await call("/admin-api/members/x/role", { role: "admin" })).status, role).toBe(403);
      expect((await call("/admin-api/invites", { email: "a@example.com" })).status, role).toBe(403);
    }
    // past the guard (the routes come with the Members page)
    expect((await (await asRole("admin"))("/admin-api/invites", { email: "a@example.com" })).status).toBe(404);
    expect((await (await asInstanceAdmin("editor"))("/admin-api/invites", { email: "a@example.com" })).status).toBe(
      404,
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
    expect(await env.DB.prepare("SELECT value FROM settings WHERE key = 'paused'").first()).toBeNull();
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
      await env.DB.prepare("DELETE FROM settings WHERE key = 'paused'").run();
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
