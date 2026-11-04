// The first run (Phase 13, docs/superpowers/specs/2026-11-04-phase13-people-roles-design.md, section 0): on an empty
// instance the setup token makes an instance admin who belongs to no workspace; they create the first one.
import { env } from "cloudflare:workers";
import { adminRoutes, FRESH_S } from "@bongsu/api/dashboard/routes";
import type { Verifiers } from "@bongsu/api/pwa/webauthn";
import type { Env } from "@bongsu/core/env";
import { beforeEach, describe, expect, it } from "vitest";
import { World } from "./world";

// A stand-in authenticator: the credential id is whatever the "browser" says (response.id).
const fake: Verifiers = {
  registration: (async (o: { response: { id: string } }) => ({
    verified: true,
    registrationInfo: {
      credential: { id: o.response.id, publicKey: new Uint8Array([1, 2, 3]), counter: 0, transports: ["internal"] },
    },
  })) as unknown as Verifiers["registration"],
  authentication: (async () => ({
    verified: true,
    authenticationInfo: { newCounter: 1 },
  })) as unknown as Verifiers["authentication"],
};

let e: Env;
let w: World;
const jar: Record<string, string> = {};
async function call(path: string, body?: unknown) {
  const cookie = Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
  const r = await adminRoutes(w.fetch, fake).request(
    `https://bongsu.test${path}`,
    {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    e,
  );
  const set = r.headers.get("Set-Cookie");
  if (set) {
    const [kv] = set.split(";");
    const [k, v] = kv.split("=");
    if (set.includes("Max-Age=0")) delete jar[k];
    else jar[k] = v;
  }
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
}

async function bootstrap(email = "first@example.com") {
  const o = await call("/admin-api/bootstrap/options", { token: "setup-token-123", email, name: "First" });
  expect(o.status).toBe(200);
  return call("/admin-api/bootstrap/verify", { challengeId: o.json.challengeId, response: { id: "first-key" } });
}

beforeEach(async () => {
  for (const k of Object.keys(jar)) delete jar[k];
  w = new World();
  // not testEnv: it seeds the demo accounts into the default workspace, and there's none here
  e = { ...env, SETUP_TOKEN: "setup-token-123", PUBLIC_URL: "https://bongsu.test", RP_ID: "bongsu.test" } as Env;
  // a truly empty instance: no users, no workspaces (the tests' seed gone)
  await env.DB.batch(
    [
      "DELETE FROM passkeys",
      "DELETE FROM sessions",
      "DELETE FROM challenges",
      "DELETE FROM recovery_codes",
      "DELETE FROM api_keys",
      "DELETE FROM audit",
      "DELETE FROM settings WHERE key = 'bootstrap_done'",
      "DELETE FROM memberships",
      "DELETE FROM invites",
      "DELETE FROM users",
      "DELETE FROM workspace_settings",
      "DELETE FROM workspaces",
    ].map((s) => env.DB.prepare(s)),
  );
});

describe("the first run", () => {
  it("bootstraps an instance admin with no workspace, who creates the first one as its admin", async () => {
    expect((await bootstrap()).status).toBe(200);
    const me = await env.DB.prepare("SELECT id, instance_admin FROM users WHERE email = 'first@example.com'").first<{
      id: string;
      instance_admin: number;
    }>();
    expect(me?.id).toMatch(/^u_[0-9a-f]{16}$/);
    expect(me?.instance_admin).toBe(1);
    expect(await env.DB.prepare("SELECT user_id FROM passkeys WHERE id = 'first-key'").first("user_id")).toBe(me?.id);
    expect((await call("/admin-api/state")).json).toMatchObject({
      signedIn: true,
      instanceAdmin: true,
      noWorkspace: true,
      // none at all: the first run's "create your first workspace"
      anyWorkspace: false,
    });
    // nothing landed in a workspace no one chose: the bootstrap's audit row is the instance's
    expect(await env.DB.prepare("SELECT action, workspace_id FROM audit").all()).toMatchObject({
      results: [{ action: "bootstrap", workspace_id: null }],
    });
    // a workspace's pages wait for one
    expect((await call("/admin-api/overview")).json).toMatchObject({ noWorkspace: true });

    const made = await call("/admin-api/workspaces", { name: "Demo Travel", timezone: "Europe/Madrid", admin: "me" });
    expect(made.status).toBe(200);
    expect(made.json.id).toMatch(/^w_[0-9a-f]{16}$/);
    expect(made.json.invite).toBeUndefined();
    expect((await call("/admin-api/state")).json).toMatchObject({
      signedIn: true,
      instanceAdmin: true,
      noWorkspace: false,
      role: "admin",
    });
    // the session works in it straight away
    expect((await call("/admin-api/settings")).json).toMatchObject({ timezone: "Europe/Madrid", digestHour: 8 });
    expect(await env.DB.prepare("SELECT workspace_id, user_id, role FROM memberships").all()).toMatchObject({
      results: [{ workspace_id: made.json.id, user_id: me?.id, role: "admin" }],
    });
    expect(await env.DB.prepare("SELECT name FROM workspaces").all()).toMatchObject({
      results: [{ name: "Demo Travel" }],
    });
    expect(
      await env.DB.prepare("SELECT workspace_id FROM audit WHERE action = 'workspace_create'").first("workspace_id"),
    ).toBeNull();
  });

  it("refuses a workspace without a name, with an unknown zone or a first admin that's neither me nor an email", async () => {
    await bootstrap();
    const bad = [
      { name: " ", timezone: "Europe/Madrid", admin: "me" },
      { name: "Demo Travel", timezone: "Mars/Base", admin: "me" },
      { name: "Demo Travel", timezone: "Europe/Madrid", admin: "nope" },
      // the rename's limit too: refused, not cut short
      { name: "x".repeat(81), timezone: "Europe/Madrid", admin: "me" },
    ];
    for (const b of bad) expect((await call("/admin-api/workspaces", b)).status, JSON.stringify(b)).toBe(400);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM workspaces").first("n")).toBe(0);
  });

  it("invites someone else as the new workspace's first admin, and opens it for the instance admin", async () => {
    await bootstrap();
    const made = await call("/admin-api/workspaces", {
      name: "Demo Running",
      timezone: "UTC",
      admin: "Runner@Example.com",
    });
    expect(made.status).toBe(200);
    const invite = made.json.invite as { url: string };
    expect(invite.url).toMatch(/^https:\/\/bongsu\.test\/dashboard\/invite\/[A-Za-z0-9_-]{43}$/);
    // nobody's a member until the invite is accepted; the instance admin works in it meanwhile, as its admin
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM memberships").first("n")).toBe(0);
    expect(
      await env.DB.prepare("SELECT workspace_id, email, role FROM invites").first<Record<string, unknown>>(),
    ).toEqual({ workspace_id: made.json.id, email: "runner@example.com", role: "admin" });
    expect((await call("/admin-api/state")).json).toMatchObject({ noWorkspace: false, role: "admin" });
    const token = invite.url.split("/").pop();
    expect((await call(`/admin-api/invite/${token}`)).json).toEqual({ workspace: "Demo Running", role: "admin" });
  });

  it("signs in again in no workspace: the passkey check works there, then a workspace can be made", async () => {
    await bootstrap();
    // the first workspace is a client's: its admin is someone else, so the instance admin is a member of none
    expect(
      (await call("/admin-api/workspaces", { name: "Client", timezone: "UTC", admin: "client@example.com" })).status,
    ).toBe(200);
    await call("/admin-api/signout", {});
    const o = await call("/admin-api/signin/options", { email: "first@example.com" });
    const v = await call("/admin-api/signin/verify", {
      challengeId: o.json.challengeId,
      response: { id: "first-key" },
    });
    expect(v.status).toBe(200);
    // the Instance pages, not "create your first workspace": there is one
    expect((await call("/admin-api/state")).json).toMatchObject({
      instanceAdmin: true,
      noWorkspace: true,
      anyWorkspace: true,
    });
    expect((await call("/admin-api/workspaces")).status).toBe(200);
    expect((await call("/admin-api/passkeys")).status).toBe(200);
    // signed in in no workspace: the instance's row
    expect(
      await env.DB.prepare("SELECT workspace_id FROM audit WHERE action = 'signin'").first("workspace_id"),
    ).toBeNull();
    // later: the sign-in's check is stale
    await env.DB.prepare("UPDATE sessions SET verified_at = verified_at - ?1")
      .bind(FRESH_S + 60)
      .run();
    const body = { name: "Second", timezone: "UTC", admin: "me" };
    const stale = await call("/admin-api/workspaces", body);
    expect([stale.status, stale.json.verify]).toEqual([403, true]);
    const vo = await call("/admin-api/verify/options", {});
    expect(vo.status).toBe(200);
    const vv = await call("/admin-api/verify/verify", {
      challengeId: vo.json.challengeId,
      response: { id: "first-key" },
    });
    expect(vv.json).toEqual({ verified: true });
    const made = await call("/admin-api/workspaces", body);
    expect(made.status).toBe(200);
    expect((await call("/admin-api/state")).json).toMatchObject({ noWorkspace: false, role: "admin" });
  });

  it("only an instance admin creates workspaces", async () => {
    await bootstrap();
    const me = await env.DB.prepare("SELECT id FROM users").first<{ id: string }>();
    await call("/admin-api/workspaces", { name: "Demo Travel", timezone: "Europe/Madrid", admin: "me" });
    await env.DB.prepare("UPDATE users SET instance_admin = 0 WHERE id = ?1").bind(me?.id).run();
    const r = await call("/admin-api/workspaces", { name: "Demo Running", timezone: "UTC", admin: "me" });
    expect(r.status).toBe(403);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM workspaces").first("n")).toBe(1);
  });
});
