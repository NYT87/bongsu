// The dashboard's API (Phase 4b, docs/PLAN.md 2.8): bootstrap with SETUP_TOKEN, sign-in with email + passkey,
// recovery codes, fresh passkey checks, agent keys, devices and passkeys; PWA sessions and agent keys can't reach it.
import { env, exports } from "cloudflare:workers";
import { authenticate } from "@bongsu/api/agent/auth";
import { adminRoutes, FRESH_S } from "@bongsu/api/dashboard/routes";
import { appRoutes } from "@bongsu/api/pwa/routes";
import type { Verifiers } from "@bongsu/api/pwa/webauthn";
import { addApproval } from "@bongsu/core/data";
import type { Env } from "@bongsu/core/env";
import { beforeEach, describe, expect, it } from "vitest";
import { clearPlan, joinDefault, testEnv, UNBOOTSTRAP, World } from "./world";

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
/** The bootstrapped user's id (an instance admin, also the default workspace's admin here). */
let me = "";
const jar: Record<string, string> = {};
async function call(path: string, body?: unknown, which: "admin" | "pwa" = "admin") {
  const routes = which === "admin" ? adminRoutes(w.fetch, fake) : appRoutes(w.fetch, fake);
  const cookie = Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
  const r = await routes.request(
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
const signOut = () => {
  for (const k of Object.keys(jar)) delete jar[k];
};

async function bootstrap(email = "owner@example.com") {
  const o = await call("/admin-api/bootstrap/options", { token: "setup-token-123", email, name: "Owner" });
  expect(o.status).toBe(200);
  const r = await call("/admin-api/bootstrap/verify", {
    challengeId: o.json.challengeId,
    response: { id: "laptop-key" },
    device: "laptop",
  });
  // the bootstrap makes an instance admin in no workspace (first-run.test.ts); here they work in the default one
  if (r.status === 200) me = await joinDefault(email);
  return r;
}
async function signIn(email: string, credential: string) {
  const o = await call("/admin-api/signin/options", { email });
  return call("/admin-api/signin/verify", { challengeId: o.json.challengeId, response: { id: credential } });
}

beforeEach(async () => {
  signOut();
  w = new World();
  await env.DB.batch([...UNBOOTSTRAP, "DELETE FROM rate_limits"].map((s) => env.DB.prepare(s)));
  e = await testEnv(env, {
    SETUP_TOKEN: "setup-token-123",
    PUBLIC_URL: "https://bongsu.test",
    RP_ID: "bongsu.test",
  } as Partial<Env>);
});

describe("bootstrap", () => {
  it("the setup token creates the first user once, with a passkey and recovery codes", async () => {
    expect((await call("/admin-api/state")).json).toMatchObject({
      bootstrapNeeded: true,
      signedIn: false,
      setupTokenSet: true,
    });
    expect((await call("/admin-api/bootstrap/options", { token: "wrong", email: "a@example.com" })).status).toBe(403);
    expect((await call("/admin-api/bootstrap/options", { token: "setup-token-123", email: "nope" })).status).toBe(400);
    const r = await bootstrap();
    expect(r.status).toBe(200);
    const codes = r.json.recoveryCodes as string[];
    expect(codes).toHaveLength(10);
    expect(codes[0]).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect((await call("/admin-api/state")).json).toMatchObject({
      bootstrapNeeded: false,
      signedIn: true,
      user: { id: me, email: "owner@example.com", name: "Owner" },
    });
    expect(me).toMatch(/^u_[0-9a-f]{16}$/);
    expect(await env.DB.prepare("SELECT user_id FROM passkeys WHERE id = 'laptop-key'").first("user_id")).toBe(me);
    // used up: a second attempt is refused, even with the right token
    signOut();
    expect(
      (await call("/admin-api/bootstrap/options", { token: "setup-token-123", email: "b@example.com" })).status,
    ).toBe(409);
  });

  it("without SETUP_TOKEN on the Worker it says so", async () => {
    e = { ...e, SETUP_TOKEN: undefined };
    const r = await call("/admin-api/bootstrap/options", { token: "x", email: "a@example.com" });
    expect([r.status, r.json.error]).toEqual([409, expect.stringMatching(/SETUP_TOKEN/)]);
  });
});

describe("sign-in", () => {
  it("email, then that user's own passkey; an unknown email or another user's passkey fails", async () => {
    await bootstrap();
    signOut();
    expect((await call("/admin-api/overview")).status).toBe(401);
    expect((await signIn("someone@example.com", "laptop-key")).status).toBe(401);
    // a passkey of another user can't sign this one in
    await env.DB.prepare(
      "INSERT INTO users (id, email, name, created_at) VALUES ('u2', 'two@example.com', 'Two', 0) ON CONFLICT DO NOTHING",
    ).run();
    await env.DB.prepare(
      "INSERT INTO passkeys (id, public_key, user_id, created_at) VALUES ('two-key', 'AQID', 'u2', 0)",
    ).run();
    expect((await signIn("owner@example.com", "two-key")).status).toBe(401);
    expect((await signIn("Owner@Example.com", "laptop-key")).status).toBe(200); // emails compare lowercased
    expect((await call("/admin-api/overview")).status).toBe(200);
  });

  it("a recovery code signs in once", async () => {
    const codes = (await bootstrap()).json.recoveryCodes as string[];
    signOut();
    expect(
      (await call("/admin-api/signin/recovery", { email: "owner@example.com", code: codes[0].toLowerCase() })).status,
    ).toBe(200);
    signOut();
    expect((await call("/admin-api/signin/recovery", { email: "owner@example.com", code: codes[0] })).status).toBe(401);
    expect((await call("/admin-api/signin/recovery", { email: "other@example.com", code: codes[1] })).status).toBe(401);
  });

  it("recovery codes can't be guessed: five tries an email in 15 minutes, right or wrong", async () => {
    const codes = (await bootstrap()).json.recoveryCodes as string[];
    signOut();
    const tryCode = (email: string, code: string) => call("/admin-api/signin/recovery", { email, code });
    for (let i = 0; i < 5; i++) expect((await tryCode("owner@example.com", `WRNG-CD0${i}`)).status).toBe(401);
    // the sixth try is refused before the code is looked at, even the right one, and the code stays unused
    const sixth = await tryCode("Owner@Example.com ", codes[0]);
    expect(sixth.status).toBe(429);
    expect(sixth.json.error).toMatch(/too many tries/);
    const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ?1 AND used_at IS NULL")
      .bind(me)
      .first<{ n: number }>();
    expect(left?.n).toBe(10);
    // an unknown email is limited the same way, so the answer says nothing about which emails exist
    for (let i = 0; i < 5; i++) expect((await tryCode("nobody@example.com", codes[1])).status).toBe(401);
    expect((await tryCode("nobody@example.com", codes[1])).status).toBe(429);
    // 15 minutes on, the owner's code works
    await env.DB.prepare('UPDATE rate_limits SET "window" = "window" - 15').run();
    expect((await tryCode("owner@example.com", codes[0])).status).toBe(200);
  });

  it("the PWA's session and agent keys can't reach /admin-api", async () => {
    await bootstrap();
    signOut();
    // a PWA session (its own cookie) isn't a dashboard session
    const k = await call("/admin-api/devices", {}); // signed out
    expect(k.status).toBe(401);
    jar.bongsu_session = "pwa-session-token-aaaaaaaaaaaaaaaaaaaa";
    expect((await call("/admin-api/overview")).status).toBe(401);
    const viaKey = await exports.default.fetch("https://scheduler.test/admin-api/overview", {
      headers: { Authorization: "Bearer bongsu_somekeysomekeysomekeysomekey" },
    });
    expect(viaKey.status).toBe(401);
  });
});

describe("signed in", () => {
  beforeEach(async () => {
    await bootstrap();
  });

  it("Get started: each step's state comes from the data", async () => {
    await env.DB.batch(
      [
        "UPDATE workspace_settings SET updated_at = 0 WHERE workspace_id = 'default'",
        "UPDATE accounts SET connection_id = NULL",
        "DELETE FROM connections",
        "DELETE FROM oauth_apps",
        "DELETE FROM push_subs",
        "DELETE FROM media_store",
      ].map((s) => env.DB.prepare(s)),
    );
    const setup = async () => (await call("/admin-api/overview")).json.setup;
    expect(await setup()).toEqual({
      timezone: false,
      oauthApp: false,
      mediaStore: false,
      connection: false,
      device: false,
    });
    await call("/admin-api/settings", { timezone: "Asia/Seoul", digestHour: 8 });
    // the device: a session in the app, as adding a device makes
    await env.DB.prepare(
      "INSERT INTO sessions (token_hash, created_at, expires_at, user_id, app, verified_at) VALUES ('t-phone', 0, 9999999999, ?1, 'pwa', 0)",
    )
      .bind(me)
      .run();
    // a workspace's own bucket isn't the instance's: the other workspaces would still have no store
    await env.DB.prepare(
      "INSERT INTO media_store (id, kind, workspace_id, is_default, settings, status, updated_at) VALUES ('s3-default', 's3', 'default', 1, '{}', 'ok', 0)",
    ).run();
    expect(await setup()).toMatchObject({ mediaStore: false });
    await env.DB.prepare(
      "INSERT INTO media_store (kind, is_default, settings, status, updated_at) VALUES ('s3', 1, '{}', 'ok', 0)",
    ).run();
    expect(await setup()).toEqual({
      timezone: true,
      oauthApp: false,
      mediaStore: true,
      connection: false,
      device: true,
    });
  });

  it("Waiting for approval counts what the app's Needs you lists: not approved, or approved for another time", async () => {
    await clearPlan();
    const soon = Math.floor(Date.now() / 1000) + 86400;
    const plan = (key: string, due: number, hold = 0) =>
      env.DB.prepare(
        "INSERT INTO plan_items (item_key, format, account, folder, name, due_at, options, hold, sort, created_at, updated_at) VALUES (?1, 'video', 'demo_travel', 'channels/vlogs/INSTAGRAM', ?1, ?2, '{}', ?3, 1, 0, 0)",
      )
        .bind(key, due, hold)
        .run();
    const approve = (key: string, dueAt: number) =>
      addApproval(env.DB, {
        key,
        account: "demo_travel",
        dueAt,
        captionSha256: null,
        commentSha256: null,
        altSha256: null,
        media: [],
        approvedAt: "2026-10-01T00:00:00Z",
        approvedBy: "owner",
      });
    await plan("reel:x/new", soon); // never approved
    await plan("reel:x/moved", soon + 3600); // approved, then moved an hour later
    await approve("reel:x/moved", soon);
    await plan("reel:x/ok", soon + 7200); // approved for its time
    await approve("reel:x/ok", soon + 7200);
    await plan("reel:x/held", soon + 10800, 1); // held: not waiting
    await plan("reel:x/past", soon - 2 * 86400); // its time has passed
    expect((await call("/admin-api/overview")).json.waitingApproval).toBe(2);
    await clearPlan();
  });

  it("CLI tokens: the person's own, with their role's rights, expiring, revocable", async () => {
    const made = await call("/admin-api/tokens", { name: "my laptop", days: 30 });
    expect(made.status).toBe(200); // the sign-up's passkey check is still fresh
    const token = String(made.json.token);
    expect(token).toMatch(/^bongsu_cli_[A-Za-z0-9]{32}$/);
    expect((await call("/admin-api/tokens", { name: "x", days: 7 })).status).toBe(400); // 30, 90 or 365 days
    const listed = await call("/admin-api/tokens");
    expect(listed.json.rights).toEqual([
      "read",
      "draft",
      "plan",
      "pause",
      "reschedule",
      "metrics",
      "approve",
      "resume",
    ]);
    expect(listed.json.tokens).toEqual([expect.objectContaining({ name: "my laptop", revoked_at: null })]);
    expect(JSON.stringify(listed.json)).not.toContain(token);
    // not an agent key: it isn't listed or counted with them
    expect((await call("/admin-api/keys")).json.keys).toEqual([]);
    expect((await call("/admin-api/overview")).json.keys).toBe(0);

    // it acts as its person, with the owner's rights (approve and resume included)
    const now = Math.floor(Date.now() / 1000);
    const caller = await authenticate(env.DB, `Bearer ${token}`, now);
    expect(caller).toMatchObject({ userId: me, workspaceId: "default" });
    expect(caller?.scopes).toContain("approve");
    const v1 = (t: string) =>
      exports.default.fetch("https://scheduler.test/v1/status", { headers: { Authorization: `Bearer ${t}` } });
    expect((await v1(token)).status).toBe(200);
    // a smaller role, smaller rights: an editor's token edits but never approves, pauses or resumes; a creator's
    // approves. An instance admin's is an admin's whatever the role, so the owner stops being one meanwhile.
    await env.DB.prepare("UPDATE users SET instance_admin = 0 WHERE id = ?1").bind(me).run();
    try {
      await env.DB.prepare("UPDATE memberships SET role = 'editor' WHERE user_id = ?1").bind(me).run();
      expect((await authenticate(env.DB, `Bearer ${token}`, now))?.scopes).toEqual([
        "read",
        "draft",
        "plan",
        "reschedule",
        "metrics",
      ]);
      await env.DB.prepare("UPDATE memberships SET role = 'creator' WHERE user_id = ?1").bind(me).run();
      expect((await authenticate(env.DB, `Bearer ${token}`, now))?.scopes).toEqual(listed.json.rights);
      // no membership, no access
      await env.DB.prepare("DELETE FROM memberships WHERE user_id = ?1").bind(me).run();
      expect(await authenticate(env.DB, `Bearer ${token}`, now)).toBeNull();
    } finally {
      await joinDefault();
      await env.DB.prepare("UPDATE users SET instance_admin = 1 WHERE id = ?1").bind(me).run();
    }
    // expired
    expect(await authenticate(env.DB, `Bearer ${token}`, now + 31 * 86400)).toBeNull();
    // revoked: only by its person
    expect((await call(`/admin-api/keys/${made.json.id}/revoke`, {})).status).toBe(404); // not an agent key
    expect((await call(`/admin-api/tokens/${made.json.id}/revoke`, {})).status).toBe(200);
    expect((await v1(token)).status).toBe(401);
  });

  it("agent keys: created after a fresh passkey check, shown once, usable on /v1, revocable", async () => {
    // the session's passkey check is older than FRESH_S
    await env.DB.prepare("UPDATE sessions SET verified_at = verified_at - ?1")
      .bind(FRESH_S + 5)
      .run();
    const refused = await call("/admin-api/keys", { name: "laptop agent", scopes: ["read", "plan"] });
    expect([refused.status, refused.json.verify]).toEqual([403, true]);
    const o = await call("/admin-api/verify/options", {});
    expect(
      (await call("/admin-api/verify/verify", { challengeId: o.json.challengeId, response: { id: "laptop-key" } }))
        .status,
    ).toBe(200);
    expect(((await call("/admin-api/keys")).json.scopes as string[]).includes("reschedule")).toBe(true);
    const resched = await call("/admin-api/keys", { name: "mover", scopes: ["read", "reschedule"] });
    expect(resched.status).toBe(200);
    expect((await call(`/admin-api/keys/${resched.json.id}/revoke`, {})).status).toBe(200);
    const made = await call("/admin-api/keys", { name: "laptop agent", scopes: ["read", "plan"] });
    expect(made.status).toBe(200);
    const key = String(made.json.key);
    expect(key).toMatch(/^bongsu_[A-Za-z0-9]{32}$/);
    const listed = ((await call("/admin-api/keys")).json.keys as Record<string, unknown>[]).filter(
      (k) => k.name === "laptop agent",
    );
    expect(listed).toEqual([
      expect.objectContaining({ name: "laptop agent", scopes: ["read", "plan"], created_by: me }),
    ]);
    expect(JSON.stringify(listed)).not.toContain(key); // never shown again
    const status = await exports.default.fetch("https://scheduler.test/v1/status", {
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(status.status).toBe(200);
    expect((await call(`/admin-api/keys/${made.json.id}/revoke`, {})).status).toBe(200);
    const after = await exports.default.fetch("https://scheduler.test/v1/status", {
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(after.status).toBe(401);
    expect((await call("/admin-api/keys", { name: "bad", scopes: ["approve"] })).status).toBe(400); // keys can't approve
  });

  it("adds a device: a one-time code the PWA turns into the user's passkey and a PWA session", async () => {
    const p = await call("/admin-api/devices", {});
    expect(p.json.link).toBe(`https://bongsu.test/#/setup?code=${encodeURIComponent(String(p.json.code))}`);
    expect((await call(`/admin-api/devices/${p.json.id}`)).json).toEqual({ used: false, expired: false });
    // the device, in the PWA
    const o = await call("/app-api/setup/options", { code: p.json.code }, "pwa");
    expect(o.status).toBe(200);
    const v = await call(
      "/app-api/setup/verify",
      { challengeId: o.json.challengeId, response: { id: "phone-key" }, name: "Phone" },
      "pwa",
    );
    expect(v.status).toBe(200);
    expect(jar.bongsu_session).toBeTruthy(); // signed in to the PWA
    expect(await env.DB.prepare("SELECT user_id FROM passkeys WHERE id = 'phone-key'").first("user_id")).toBe(me);
    expect((await call(`/admin-api/devices/${p.json.id}`)).json).toEqual({ used: true, expired: false });
    const keys = (await call("/admin-api/passkeys")).json.passkeys as { name: string }[];
    expect(keys.map((k) => k.name)).toEqual(["laptop", "Phone"]);
  });

  it("passkeys: rename, revoke, but never the last one", async () => {
    expect((await call("/admin-api/passkeys/laptop-key/revoke", {})).status).toBe(409);
    const o = await call("/admin-api/passkeys/options", {});
    expect(
      (
        await call("/admin-api/passkeys/verify", {
          challengeId: o.json.challengeId,
          response: { id: "yubikey" },
          name: "Security key",
        })
      ).status,
    ).toBe(200);
    expect((await call("/admin-api/passkeys/yubikey/rename", { name: "Blue key" })).status).toBe(200);
    expect((await call("/admin-api/passkeys/laptop-key/revoke", {})).status).toBe(200);
    expect(((await call("/admin-api/passkeys")).json.passkeys as { name: string }[]).map((k) => k.name)).toEqual([
      "Blue key",
    ]);
  });

  it("accounts, settings, connections and the audit log", async () => {
    const a = (await call("/admin-api/accounts")).json.accounts as { id: string; trialReels: unknown }[];
    expect(a.find((x) => x.id === "demo_running")?.trialReels).toEqual({ capable: true, on: true });
    expect((await call("/admin-api/accounts/demo_running", { trialReels: false, name: "Running" })).status).toBe(200);
    expect(
      ((await call("/admin-api/accounts")).json.accounts as { id: string; trialReels: unknown; name: string }[]).find(
        (x) => x.id === "demo_running",
      ),
    ).toMatchObject({
      trialReels: { capable: true, on: false },
      name: "Running",
    });
    expect((await call("/admin-api/accounts/demo_travel", { trialReels: true })).status).toBe(409); // not possible there
    expect((await call("/admin-api/settings", { timezone: "Mars/Base" })).status).toBe(400);
    expect((await call("/admin-api/settings", { timezone: "Europe/Madrid", digestHour: 7 })).status).toBe(200);
    expect((await call("/admin-api/settings")).json).toMatchObject({ timezone: "Europe/Madrid", digestHour: 7 });
    await call("/admin-api/settings", { timezone: "Asia/Seoul", digestHour: 8 });
    const conns = (await call("/admin-api/connections")).json as {
      connections: { id: string; accounts: string[] }[];
      kinds: { provider: string }[];
    };
    expect(conns.connections.find((x) => x.id === "c_demo_travel")?.accounts).toEqual(["demo_travel"]);
    expect(conns.kinds.map((k) => k.provider)).toEqual(expect.arrayContaining(["instagram", "composio", "youtube"]));
    const audit = (await call("/admin-api/audit")).json.entries as { action: string; actor: string }[];
    expect(audit.map((x) => x.action)).toEqual(expect.arrayContaining(["account_update", "settings"]));
    expect(audit[0].actor).toBe(`user:${me}`);
    // the bootstrap is the instance's, read by its instance admins on their own
    expect(audit.map((x) => x.action)).not.toContain("bootstrap");
    const instance = (await call("/admin-api/audit?instance=1")).json.entries as { action: string }[];
    expect(instance.map((x) => x.action)).toContain("bootstrap");
  });

  it("caption rules per account: the defaults shown, an override stored, bad values refused, editors read-only", async () => {
    type Rules = { hashtagMax: number; foldChars: number; languageChecks: boolean };
    type Acc = { id: string; captionRules: (Rules & { defaults: Rules }) | null };
    const rules = async (id: string) =>
      ((await call("/admin-api/accounts")).json.accounts as Acc[]).find((x) => x.id === id)?.captionRules;
    const defaults = { hashtagMax: 5, foldChars: 125, languageChecks: true };
    expect(await rules("demo_travel")).toEqual({ ...defaults, defaults });
    // YouTube publishes now, so its rules show too, with the "checks nothing" defaults
    const none = { hashtagMax: 0, foldChars: 0, languageChecks: false };
    expect(await rules("main")).toEqual({ ...none, defaults: none });
    expect((await call("/admin-api/accounts/demo_travel", { captionRules: { hashtagMax: 10 } })).status).toBe(200);
    expect(await rules("demo_travel")).toEqual({ ...defaults, hashtagMax: 10, defaults }); // foldChars still 125
    // one field at a time: a later change keeps the earlier one, null puts a field back to the default
    expect((await call("/admin-api/accounts/demo_travel", { captionRules: { foldChars: 100 } })).status).toBe(200);
    expect(await rules("demo_travel")).toEqual({ ...defaults, hashtagMax: 10, foldChars: 100, defaults });
    expect((await call("/admin-api/accounts/demo_travel", { captionRules: { foldChars: null } })).status).toBe(200);
    expect(await rules("demo_travel")).toEqual({ ...defaults, hashtagMax: 10, defaults });
    for (const bad of [
      { hashtagMax: "7" },
      { hashtagMax: 31 },
      { hashtagMax: 2.5 },
      { foldChars: 10 },
      { languageChecks: "no" },
    ]) {
      const r = await call("/admin-api/accounts/demo_travel", { captionRules: bad });
      expect([r.status, r.json.error]).toEqual([
        400,
        "caption rules: hashtagMax 0–30, foldChars 50–500, languageChecks true/false",
      ]);
    }
    expect((await rules("demo_travel"))?.hashtagMax).toBe(10); // nothing of the refused ones stored
    const stored = await env.DB.prepare("SELECT settings FROM accounts WHERE id = 'demo_travel'").first<{
      settings: string;
    }>();
    expect(JSON.parse(stored?.settings ?? "")).toEqual({ captionRules: { hashtagMax: 10 } });
    const audit = (await call("/admin-api/audit")).json.entries as { action: string; target: string }[];
    expect(audit.find((x) => x.action === "account_update")?.target).toBe("demo_travel");
    // an editor reads them; changing them is an admin's (and an instance admin's: the owner stops being one meanwhile)
    await env.DB.prepare("UPDATE users SET instance_admin = 0 WHERE id = ?1").bind(me).run();
    await env.DB.prepare("UPDATE memberships SET role = 'editor' WHERE user_id = ?1").bind(me).run();
    try {
      expect((await call("/admin-api/accounts/demo_travel", { captionRules: { hashtagMax: 3 } })).status).toBe(403);
      expect((await call("/admin-api/accounts")).status).toBe(200);
    } finally {
      await env.DB.prepare("UPDATE memberships SET role = 'admin' WHERE user_id = ?1").bind(me).run();
      await env.DB.prepare("UPDATE users SET instance_admin = 1 WHERE id = ?1").bind(me).run();
    }
  });

  it("removing an account: disabled first, nothing left to publish, history kept", async () => {
    expect((await call("/admin-api/accounts/demo_running/remove", {})).status).toBe(409); // still active
    await call("/admin-api/accounts/demo_running", { status: "disabled" });
    await env.DB.batch(
      [
        `INSERT INTO plan_items (item_key, format, account, folder, name, due_at, workspace_id, created_at, updated_at)
         VALUES ('reel:run/a', 'video', 'demo_running', 'run', 'a', 2000000000, 'default', 0, 0)`,
        `INSERT INTO plan_items (item_key, format, account, folder, name, due_at, workspace_id, created_at, updated_at)
         VALUES ('reel:run/b', 'video', 'demo_running', 'run', 'b', 1000, 'default', 0, 0)`,
        "INSERT INTO posted (item_key, account, media_id, source, published_at) VALUES ('reel:run/b', 'demo_running', 'm1', 'scheduler', 1000)",
      ].map((s) => env.DB.prepare(s)),
    );
    const left = await call("/admin-api/accounts/demo_running/remove", {});
    expect([left.status, left.json.error]).toEqual([409, expect.stringMatching(/1 item/)]); // reel:run/a, not the posted one
    await env.DB.prepare("DELETE FROM plan_items WHERE item_key = 'reel:run/a'").run();
    expect((await call("/admin-api/accounts/demo_running/remove", {})).status).toBe(200);
    const ids = ((await call("/admin-api/accounts")).json.accounts as { id: string }[]).map((x) => x.id);
    expect(ids).not.toContain("demo_running");
    expect(await env.DB.prepare("SELECT 1 FROM posted WHERE item_key = 'reel:run/b'").first()).not.toBeNull();
  });

  it("signing out ends only the dashboard session", async () => {
    jar.bongsu_session = "kept";
    await call("/admin-api/signout", {});
    expect(jar.bongsu_admin).toBeUndefined();
    expect(jar.bongsu_session).toBe("kept");
    expect((await call("/admin-api/overview")).status).toBe(401);
  });
});
