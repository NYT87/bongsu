// Members and invites (docs/superpowers/specs/2026-11-04-phase13-people-roles-design.md, section 3): an admin invites
// by email with a role (a one-time link, 7 days), the invitee joins with a new passkey or their own, admins change
// roles and remove members, a workspace keeps one admin, and a removed member is cut off at once.
import { env } from "cloudflare:workers";
import { authenticate } from "@bongsu/api/agent/auth";
import { adminRoutes } from "@bongsu/api/dashboard/routes";
import { NEW_FAILED } from "@bongsu/api/pwa/invite";
import { appRoutes } from "@bongsu/api/pwa/routes";
import { createSession, setSessionWorkspace } from "@bongsu/api/pwa/session";
import type { Verifiers } from "@bongsu/api/pwa/webauthn";
import type { Env } from "@bongsu/core/env";
import { sha256Hex } from "@bongsu/core/formats/approved";
import { createInvite, MemberError, removeMember, setRole } from "@bongsu/core/invites";
import { setPref } from "@bongsu/core/notify-prefs";
import { setDisplayName } from "@bongsu/core/workspaces";
import { beforeEach, describe, expect, it } from "vitest";
import { testEnv, World } from "./world";

const nowS = () => Math.floor(Date.now() / 1000);
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

let w: World;
let e: Env;
type Res = { status: number; json: Record<string, unknown>; cookie: string | null };
/** A request to the dashboard's or the app's routes, with a cookie (or none: signed out). */
async function req(routes: "dashboard" | "pwa", cookie: string | null, path: string, body?: unknown): Promise<Res> {
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
  const set = r.headers.get("Set-Cookie");
  return {
    status: r.status,
    json: (await r.json().catch(() => ({}))) as Record<string, unknown>,
    cookie: set ? set.split(";")[0] : null,
  };
}
/** A dashboard session of `userId`, working in `workspaceId` when given (else their first workspace). */
const dash = async (userId: string, workspaceId?: string) => {
  const token = await createSession(env.DB, nowS(), { app: "dashboard", userId });
  if (workspaceId) await setSessionWorkspace(env.DB, token, workspaceId);
  const cookie = `bongsu_admin=${token}`;
  return (path: string, body?: unknown) => req("dashboard", cookie, path, body);
};
const out = (routes: "dashboard" | "pwa") => (path: string, body?: unknown) => req(routes, null, path, body);
const tokenOf = (url: unknown) => /\/invite\/([A-Za-z0-9_-]+)$/.exec(String(url))?.[1] ?? "";
const member = (workspaceId: string, userId: string) =>
  env.DB.prepare("SELECT role FROM memberships WHERE workspace_id = ?1 AND user_id = ?2")
    .bind(workspaceId, userId)
    .first<string>("role");

beforeEach(async () => {
  w = new World();
  e = await testEnv(env, {
    PUBLIC_URL: "https://bongsu.test",
    RP_ID: "bongsu.test",
    MAILER: "resend",
    MAIL_FROM: "Bongsu <bongsu@example.com>",
    RESEND_API_KEY: "re_test",
  } as Partial<Env>);
  await env.DB.batch(
    [
      "DELETE FROM invites",
      "DELETE FROM sessions",
      "DELETE FROM api_keys",
      "DELETE FROM push_subs",
      "DELETE FROM notify_prefs",
      "DELETE FROM challenges",
      "DELETE FROM recovery_codes",
      "DELETE FROM passkeys WHERE user_id <> 'owner'",
      "DELETE FROM memberships WHERE user_id <> 'owner'",
      "DELETE FROM users WHERE id NOT IN ('owner') AND (email LIKE '%@example.com' OR id IN ('ada', 'eda', 'bob', 'ina'))",
      "INSERT INTO workspaces (id, name, created_at) VALUES ('b', 'Workspace B', 0) ON CONFLICT (id) DO UPDATE SET archived_at = NULL",
      "UPDATE workspaces SET archived_at = NULL",
      // ada: the default workspace's only admin; eda: an editor there; bob: workspace B's admin; ina: an instance admin
      "INSERT INTO users (id, email, name, created_at) VALUES ('ada', 'ada@example.com', 'Ada', 0)",
      "INSERT INTO users (id, email, name, created_at) VALUES ('eda', 'eda@example.com', 'Eda', 0)",
      "INSERT INTO users (id, email, name, created_at) VALUES ('bob', 'bob@example.com', 'Bob', 0)",
      "INSERT INTO users (id, email, name, created_at, instance_admin) VALUES ('ina', 'ina@example.com', 'Ina', 0, 1)",
      "DELETE FROM memberships WHERE workspace_id = 'default'",
      "INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES ('default', 'ada', 'admin', 0)",
      "INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES ('default', 'eda', 'editor', 1)",
      "INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES ('b', 'bob', 'admin', 0)",
      "INSERT INTO passkeys (id, public_key, counter, name, created_at, user_id) VALUES ('ada-key', 'AQID', 0, 'laptop', 0, 'ada')",
      "INSERT INTO passkeys (id, public_key, counter, name, created_at, user_id) VALUES ('bob-key', 'AQID', 0, 'laptop', 0, 'bob')",
    ].map((s) => env.DB.prepare(s)),
  );
});

describe("invites", () => {
  it("invites a new person as creator, who signs up in the app and lands in the workspace", async () => {
    const ada = await dash("ada");
    const made = await ada("/admin-api/invites", { email: "Cleo@Example.com", role: "creator" });
    expect(made.status).toBe(200);
    // a creator finishes in the app
    expect(made.json.url).toMatch(/^https:\/\/bongsu\.test\/#\/invite\/[A-Za-z0-9_-]{43}$/);
    const token = tokenOf(made.json.url);
    // emailed too, since a Mailer is set
    expect(w.mails).toEqual([
      expect.objectContaining({ to: ["cleo@example.com"], text: expect.stringContaining(String(made.json.url)) }),
    ]);
    // listed as pending; the token itself isn't kept
    const list = await ada("/admin-api/members");
    expect(list.json.invites).toEqual([
      { id: expect.any(String), email: "cleo@example.com", role: "creator", expiresAt: expect.any(Number) },
    ]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM invites WHERE token_hash = ?1").bind(token).first("n")).toBe(
      0,
    );

    const app = out("pwa");
    const seen = await app(`/app-api/invite/${token}`);
    expect([seen.status, seen.json]).toEqual([200, { workspace: expect.any(String), role: "creator" }]);
    const o = await app(`/app-api/invite/${token}/options`, { name: "Cleo" });
    expect(o.status).toBe(200);
    const register = o.json.register as { challengeId: string };
    const v = await app(`/app-api/invite/${token}/verify`, {
      mode: "new",
      challengeId: register.challengeId,
      response: { id: "cleo-key" },
      device: "phone",
    });
    expect([v.status, v.json]).toEqual([200, { signedIn: true, role: "creator" }]);
    expect(v.cookie).toMatch(/^bongsu_session=/);

    const cleo = await env.DB.prepare("SELECT id, name FROM users WHERE email = 'cleo@example.com'").first<{
      id: string;
      name: string;
    }>();
    expect(cleo?.name).toBe("Cleo");
    expect(await member("default", cleo!.id)).toBe("creator");
    expect(await env.DB.prepare("SELECT user_id FROM passkeys WHERE id = 'cleo-key'").first("user_id")).toBe(cleo?.id);
    // signed in to the app, working in the workspace: a creator approves
    const me = await req("pwa", v.cookie, "/app-api/me");
    expect(me.json).toMatchObject({ signedIn: true, noWorkspace: false, scopes: expect.arrayContaining(["approve"]) });
    expect((await req("pwa", v.cookie, "/app-api/status")).status).toBe(200);
    // used up: the link works once, and the list no longer shows it
    expect((await app(`/app-api/invite/${token}`)).status).toBe(404);
    expect((await ada("/admin-api/members")).json.invites).toEqual([]);
    expect(
      await env.DB.prepare("SELECT action, workspace_id FROM audit WHERE action LIKE 'invite_%' ORDER BY id").all(),
    ).toMatchObject({
      results: [
        { action: "invite_create", workspace_id: "default" },
        { action: "invite_accept", workspace_id: "default" },
      ],
    });
  });

  it("the mail names the inviter as the invited workspace names them", async () => {
    await env.DB.prepare(
      "INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES ('b', 'ada', 'admin', 0)",
    ).run();
    await setDisplayName(env.DB, "default", "ada", "Ana");
    expect(
      (await (await dash("ada", "default"))("/admin-api/invites", { email: "x1@example.com", role: "editor" })).status,
    ).toBe(200);
    expect(
      (await (await dash("ada", "b"))("/admin-api/invites", { email: "x2@example.com", role: "editor" })).status,
    ).toBe(200);
    expect(w.mails.map((m) => m.text.split(" invites you to the workspace ")[0])).toEqual(["Ana", "Ada"]);
  });

  it("invites admins and editors to the dashboard, and refuses a bad email, a bad role or a member", async () => {
    const ada = await dash("ada");
    const ed = await ada("/admin-api/invites", { email: "new@example.com", role: "editor" });
    expect(ed.json.url).toMatch(/^https:\/\/bongsu\.test\/dashboard\/invite\/[A-Za-z0-9_-]{43}$/);
    const token = tokenOf(ed.json.url);
    // the app takes creators' invites only: an editor's answers there like any unusable invite, saying nothing more
    const app = out("pwa");
    const none = await app("/app-api/invite/unknown-token-unknown-token-unknown-token-x");
    expect(none.status).toBe(404);
    for (const r of [
      await app(`/app-api/invite/${token}`),
      await app(`/app-api/invite/${token}/options`, {}),
      await app(`/app-api/invite/${token}/verify`, { mode: "new", challengeId: "x", response: { id: "k" } }),
      await app(`/app-api/invite/${token}/verify`, { mode: "existing", challengeId: "x", response: { id: "k" } }),
    ])
      expect([r.status, r.json]).toEqual([404, none.json]);
    const site = out("dashboard");
    expect((await site(`/admin-api/invite/${token}`)).json).toEqual({ workspace: expect.any(String), role: "editor" });
    const o = await site(`/admin-api/invite/${token}/options`, { name: "Nev" });
    const v = await site(`/admin-api/invite/${token}/verify`, {
      mode: "new",
      challengeId: (o.json.register as { challengeId: string }).challengeId,
      response: { id: "nev-key" },
    });
    expect(v.status).toBe(200);
    expect(v.cookie).toMatch(/^bongsu_admin=/);
    // a new dashboard user gets recovery codes, like the first one
    expect(v.json.recoveryCodes).toHaveLength(10);
    expect((await req("dashboard", v.cookie, "/admin-api/state")).json).toMatchObject({ role: "editor" });

    for (const b of [
      { email: "nope", role: "editor" },
      { email: "x@example.com", role: "owner" },
      { email: "x@example.com" },
    ])
      expect((await ada("/admin-api/invites", b)).status, JSON.stringify(b)).toBe(400);
    expect((await ada("/admin-api/invites", { email: "EDA@example.com", role: "admin" })).status).toBe(409);
  });

  it("lets an existing user join with their passkey, without saying the email exists", async () => {
    const bob = await dash("bob");
    const known = await bob("/admin-api/invites", { email: "ada@example.com", role: "editor" });
    const unknown = await bob("/admin-api/invites", { email: "zed@example.com", role: "editor" });
    const kt = tokenOf(known.json.url);
    const ut = tokenOf(unknown.json.url);
    const site = out("dashboard");
    // the same answers for a known and an unknown email: the preview, and the options (no passkeys listed in either)
    expect((await site(`/admin-api/invite/${kt}`)).json).toEqual((await site(`/admin-api/invite/${ut}`)).json);
    const ko = await site(`/admin-api/invite/${kt}/options`, {});
    const uo = await site(`/admin-api/invite/${ut}/options`, {});
    const shape = (v: unknown): unknown =>
      Array.isArray(v)
        ? v.map(shape)
        : v && typeof v === "object"
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x)]))
          : typeof v;
    expect([ko.status, shape(ko.json)]).toEqual([uo.status, shape(uo.json)]);
    expect(ko.json).toMatchObject({
      register: { options: { excludeCredentials: [] } },
      signIn: { options: { allowCredentials: [] } },
    });

    // a new passkey for an email with an account doesn't join (nor touch the account): the same answer as any failure
    const asNew = await site(`/admin-api/invite/${kt}/verify`, {
      mode: "new",
      challengeId: (ko.json.register as { challengeId: string }).challengeId,
      response: { id: "intruder-key" },
    });
    expect(asNew.status).toBe(400);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM passkeys WHERE id = 'intruder-key'").first("n")).toBe(0);
    const failed = await site(`/admin-api/invite/${ut}/verify`, {
      mode: "new",
      challengeId: "no-such-challenge",
      response: { id: "x" },
    });
    expect([failed.status, failed.json]).toEqual([asNew.status, asNew.json]);

    // someone else's passkey, on the known and on the unknown email's invite: one answer
    const wrong = async (t: string) => {
      const o = await site(`/admin-api/invite/${t}/options`, {});
      return site(`/admin-api/invite/${t}/verify`, {
        mode: "existing",
        challengeId: (o.json.signIn as { challengeId: string }).challengeId,
        response: { id: "bob-key" },
      });
    };
    const wk = await wrong(kt);
    const wu = await wrong(ut);
    expect(wk.status).toBe(401);
    expect([wk.status, wk.json]).toEqual([wu.status, wu.json]);

    // Ada signs in with her own passkey and joins workspace B as an editor, signed in there
    const o = await site(`/admin-api/invite/${kt}/options`, {});
    const v = await site(`/admin-api/invite/${kt}/verify`, {
      mode: "existing",
      challengeId: (o.json.signIn as { challengeId: string }).challengeId,
      response: { id: "ada-key" },
    });
    expect([v.status, v.json]).toEqual([200, { signedIn: true, role: "editor" }]);
    expect(await member("b", "ada")).toBe("editor");
    expect(await member("default", "ada")).toBe("admin");
    expect((await req("dashboard", v.cookie, "/admin-api/state")).json).toMatchObject({ role: "editor" });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE email = 'ada@example.com'").first("n")).toBe(1);
  });

  it("two sign-ups racing for one email: the second gets the usual refusal, not an error", async () => {
    const ada = await dash("ada");
    const token = tokenOf((await ada("/admin-api/invites", { email: "race@example.com", role: "editor" })).json.url);
    const site = out("dashboard");
    const o = await site(`/admin-api/invite/${token}/options`, { name: "Race" });
    // the other sign-up's user lands between this one's "is the email free?" and its own user
    const db = e.DB;
    let armed = true;
    const racing = new Proxy(db, {
      get(t, p) {
        if (p === "prepare")
          return (sql: string) => {
            const st = t.prepare(sql);
            if (!armed || !sql.startsWith("SELECT 1 FROM users WHERE email")) return st;
            armed = false;
            return {
              bind: () => ({
                first: async () => {
                  await t
                    .prepare(
                      "INSERT INTO users (id, email, name, created_at) VALUES ('other', 'race@example.com', 'Other', 0)",
                    )
                    .run();
                  return null;
                },
              }),
            };
          };
        const v = Reflect.get(t, p);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    e = { ...e, DB: racing };
    const v = await site(`/admin-api/invite/${token}/verify`, {
      mode: "new",
      challengeId: (o.json.register as { challengeId: string }).challengeId,
      response: { id: "race-key" },
    });
    e = { ...e, DB: db };
    expect(armed).toBe(false);
    expect([v.status, v.json]).toEqual([400, NEW_FAILED]);
    expect(await env.DB.prepare("SELECT id FROM users WHERE email = 'race@example.com'").all()).toMatchObject({
      results: [{ id: "other" }],
    });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM passkeys WHERE id = 'race-key'").first("n")).toBe(0);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM memberships WHERE workspace_id = 'default'").first("n"),
    ).toBe(2);
  });

  it("refuses an invite used, revoked or older than 7 days", async () => {
    const ada = await dash("ada");
    const site = out("dashboard");
    const make = async (email: string) =>
      tokenOf((await ada("/admin-api/invites", { email, role: "editor" })).json.url);
    // used
    const used = await make("used@example.com");
    const o = await site(`/admin-api/invite/${used}/options`, {});
    await site(`/admin-api/invite/${used}/verify`, {
      mode: "new",
      challengeId: (o.json.register as { challengeId: string }).challengeId,
      response: { id: "used-key" },
    });
    // revoked
    const revoked = await make("revoked@example.com");
    const pending = (await ada("/admin-api/members")).json.invites as { id: string; email: string }[];
    const id = pending.find((i) => i.email === "revoked@example.com")?.id;
    expect((await ada(`/admin-api/invites/${id}/revoke`, {})).status).toBe(200);
    expect((await ada(`/admin-api/invites/${id}/revoke`, {})).status).toBe(404);
    // older than 7 days
    const old = tokenOf(
      (
        await createInvite(
          e,
          w.fetch,
          { workspaceId: "default", email: "old@example.com", role: "editor", invitedBy: "ada" },
          nowS() - 7 * 86400 - 1,
        )
      ).url,
    );
    const answers = [];
    for (const t of [used, revoked, old, "unknown-token-unknown-token-unknown-token-x"]) {
      answers.push(await site(`/admin-api/invite/${t}`));
      answers.push(await out("pwa")(`/app-api/invite/${t}`));
      answers.push(await site(`/admin-api/invite/${t}/options`, {}));
      answers.push(await site(`/admin-api/invite/${t}/verify`, { mode: "new", challengeId: "x", response: {} }));
      answers.push(await site(`/admin-api/invite/${t}/verify`, { mode: "existing", challengeId: "x", response: {} }));
    }
    // one answer for every reason
    expect(new Set(answers.map((a) => JSON.stringify([a.status, a.json])))).toEqual(
      new Set([JSON.stringify([404, answers[0].json])]),
    );
    // an archived workspace's invites stop working too
    const live = await make("live@example.com");
    expect((await site(`/admin-api/invite/${live}`)).status).toBe(200);
    await env.DB.prepare("UPDATE workspaces SET archived_at = 1 WHERE id = 'default'").run();
    expect((await site(`/admin-api/invite/${live}`)).status).toBe(404);
  });
});

describe("members", () => {
  it("keeps the last admin", async () => {
    const ada = await dash("ada");
    expect((await ada("/admin-api/members/ada/remove", {})).status).toBe(409);
    expect((await ada("/admin-api/members/ada", { role: "editor" })).status).toBe(409);
    expect(await member("default", "ada")).toBe("admin");
    // with a second admin, the first may step down
    expect((await ada("/admin-api/members/eda", { role: "admin" })).status).toBe(200);
    expect((await ada("/admin-api/members/ada", { role: "editor" })).status).toBe(200);
    expect(await member("default", "ada")).toBe("editor");
    // the instance admin may leave a workspace without one
    const ina = await dash("ina", "default");
    expect((await ina("/admin-api/members/eda/remove", {})).status).toBe(200);
    expect(await member("default", "eda")).toBeNull();
    const list = (await ina("/admin-api/members")).json.members as { userId: string; role: string }[];
    expect(list.map((m) => [m.userId, m.role])).toEqual([["ada", "editor"]]);
    expect(
      (await env.DB.prepare("SELECT action FROM audit WHERE action LIKE 'member_%' ORDER BY id").all()).results,
    ).toEqual([{ action: "member_role" }, { action: "member_role" }, { action: "member_remove" }]);
    const audits = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit").first("n");
    expect((await ina("/admin-api/members/nobody", { role: "editor" })).status).toBe(404);
    expect((await ina("/admin-api/members/nobody", { role: "admin" })).status).toBe(404);
    expect((await ina("/admin-api/members/nobody/remove", {})).status).toBe(404);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit").first("n")).toBe(audits);
    expect((await ina("/admin-api/members/eda", { role: "owner" })).status).toBe(400);
  });

  it("keeps an admin when two admins demote or remove each other at once", async () => {
    const admins = () =>
      env.DB.prepare("SELECT COUNT(*) AS n FROM memberships WHERE workspace_id = 'default' AND role = 'admin'").first(
        "n",
      );
    await env.DB.prepare("UPDATE memberships SET role = 'admin' WHERE user_id = 'eda'").run();
    // started together: a check made before the change would let both through
    const demoted = await Promise.allSettled([
      setRole(env.DB, "default", "ada", "editor", { instanceAdmin: false }, nowS()),
      setRole(env.DB, "default", "eda", "editor", { instanceAdmin: false }, nowS()),
    ]);
    expect(demoted.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    const no = demoted.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect([no.reason instanceof MemberError, (no.reason as MemberError).status]).toEqual([true, 409]);
    expect(await admins()).toBe(1);

    await env.DB.prepare("UPDATE memberships SET role = 'admin' WHERE workspace_id = 'default'").run();
    const removed = await Promise.allSettled([
      removeMember(env.DB, "default", "ada", { instanceAdmin: false }, nowS()),
      removeMember(env.DB, "default", "eda", { instanceAdmin: false }, nowS()),
    ]);
    expect(removed.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(await admins()).toBe(1);
  });

  it("cuts a removed member off at once", async () => {
    // Eda: an editor in the default workspace, also a member of B
    await env.DB.prepare(
      "INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES ('b', 'eda', 'creator', 5)",
    ).run();
    const dashToken = await createSession(env.DB, nowS(), { app: "dashboard", userId: "eda" });
    const inDefault = await createSession(env.DB, nowS(), { app: "dashboard", userId: "eda" });
    await setSessionWorkspace(env.DB, inDefault, "default");
    const appToken = await createSession(env.DB, nowS(), { userId: "eda" });
    await setSessionWorkspace(env.DB, appToken, "default");
    const cli = "bongsu_cli_edaedaedaedaedaedaedaedaedaedaed";
    const cliB = "bongsu_cli_edaBedaBedaBedaBedaBedaBedaBedaB";
    for (const [id, t, ws] of [
      ["t_eda", cli, "default"],
      ["t_edaB", cliB, "b"],
    ])
      await env.DB.prepare(
        "INSERT INTO api_keys (id, name, key_hash, scopes, workspace_id, user_id, expires_at) VALUES (?1, 'cli', ?2, '[]', ?3, 'eda', ?4)",
      )
        .bind(id, await sha256Hex(t), ws, nowS() + 86400)
        .run();
    await env.DB.prepare(
      "INSERT INTO push_subs (endpoint, p256dh, auth, created_at, user_id) VALUES ('https://fcm.googleapis.com/fcm/send/eda', 'p', 'a', 0, 'eda')",
    ).run();
    for (const ws of ["default", "b"]) await setPref(env.DB, ws, "eda", "editor", "digest", false, 0);
    expect((await authenticate(env.DB, `Bearer ${cli}`, nowS()))?.workspaceId).toBe("default");

    const ada = await dash("ada");
    expect((await ada("/admin-api/members/eda/remove", {})).status).toBe(200);
    expect(await member("default", "eda")).toBeNull();
    // the session working in the default workspace is gone; the one in no particular workspace moves to B
    expect((await req("dashboard", `bongsu_admin=${inDefault}`, "/admin-api/overview")).status).toBe(401);
    expect((await req("pwa", `bongsu_session=${appToken}`, "/app-api/status")).status).toBe(401);
    expect((await req("dashboard", `bongsu_admin=${dashToken}`, "/admin-api/state")).json).toMatchObject({
      role: "creator",
    });
    // their CLI token there is revoked (kept, marked) and stops; the one for B still works
    expect(await authenticate(env.DB, `Bearer ${cli}`, nowS())).toBeNull();
    expect(
      await env.DB.prepare("SELECT revoked_at FROM api_keys WHERE id = 't_eda'").first("revoked_at"),
    ).toBeGreaterThan(0);
    expect(await env.DB.prepare("SELECT revoked_at FROM api_keys WHERE id = 't_edaB'").first("revoked_at")).toBeNull();
    expect((await authenticate(env.DB, `Bearer ${cliB}`, nowS()))?.workspaceId).toBe("b");
    // their notification settings there go; their device stays theirs (push.ts sends a workspace's notes to members only)
    expect((await env.DB.prepare("SELECT workspace_id FROM notify_prefs WHERE user_id = 'eda'").all()).results).toEqual(
      [{ workspace_id: "b" }],
    );
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM push_subs WHERE user_id = 'eda'").first("n")).toBe(1);

    // invited back later, their token list there shows it revoked (and it stays so)
    await env.DB.prepare(
      "INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES ('default', 'eda', 'editor', 9)",
    ).run();
    const back = await (await dash("eda", "default"))("/admin-api/tokens");
    expect(back.json.tokens).toEqual([expect.objectContaining({ id: "t_eda", revoked_at: expect.any(Number) })]);
    expect(await authenticate(env.DB, `Bearer ${cli}`, nowS())).toBeNull();
    await env.DB.prepare("DELETE FROM memberships WHERE workspace_id = 'default' AND user_id = 'eda'").run();

    // removed from their only workspace: the dashboard says so
    await (await dash("bob"))("/admin-api/members/eda/remove", {});
    const r = await req("dashboard", `bongsu_admin=${dashToken}`, "/admin-api/overview");
    expect([r.status, r.json.noWorkspace]).toEqual([403, true]);
  });

  it("an admin demoted or removed loses the invites they sent: no way back in through their own link", async () => {
    await env.DB.prepare("UPDATE memberships SET role = 'admin' WHERE user_id = 'eda'").run();
    const eda = await dash("eda");
    const ada = await dash("ada");
    const sent = async (email: string) =>
      tokenOf((await eda("/admin-api/invites", { email, role: "admin" })).json.url as string);
    const pending = async () =>
      ((await ada("/admin-api/members")).json.invites as { email: string }[]).map((i) => i.email).sort();
    // Ada's own invite stays through all of it
    expect((await ada("/admin-api/invites", { email: "ada-guest@example.com", role: "editor" })).status).toBe(200);
    // demoted: her pending invites are revoked
    const friend = await sent("friend@example.com");
    expect((await ada("/admin-api/members/eda", { role: "editor" })).status).toBe(200);
    expect(await pending()).toEqual(["ada-guest@example.com"]);
    expect((await out("dashboard")(`/admin-api/invite/${friend}`)).status).toBe(404);
    // removed: the admin invite she sent herself (a second address) no longer lets her back in
    expect((await ada("/admin-api/members/eda", { role: "admin" })).status).toBe(200);
    const self = await sent("eda.second@example.com");
    expect((await ada("/admin-api/members/eda/remove", {})).status).toBe(200);
    expect(await pending()).toEqual(["ada-guest@example.com"]);
    expect((await out("dashboard")(`/admin-api/invite/${self}`)).status).toBe(404);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM invites WHERE invited_by = 'eda' AND revoked_at IS NULL").first(
        "n",
      ),
    ).toBe(0);
  });

  it("the dashboard turns a creator's invite away like any unusable one: creators finish in the app", async () => {
    const ada = await dash("ada");
    const token = tokenOf((await ada("/admin-api/invites", { email: "cleo@example.com", role: "creator" })).json.url);
    const site = out("dashboard");
    const none = await site("/admin-api/invite/unknown-token-unknown-token-unknown-token-x");
    expect(none.status).toBe(404);
    for (const r of [
      await site(`/admin-api/invite/${token}`),
      await site(`/admin-api/invite/${token}/options`, {}),
      await site(`/admin-api/invite/${token}/verify`, { mode: "new", challengeId: "x", response: { id: "k" } }),
      await site(`/admin-api/invite/${token}/verify`, { mode: "existing", challengeId: "x", response: { id: "k" } }),
    ])
      expect([r.status, r.json]).toEqual([404, none.json]);
    // still usable in the app
    expect((await out("pwa")(`/app-api/invite/${token}`)).status).toBe(200);
  });

  it("is for the workspace's admins: editors get 403 on every member route", async () => {
    const eda = await dash("eda");
    for (const [path, body] of [
      ["/admin-api/members", undefined],
      ["/admin-api/invites", { email: "x@example.com", role: "editor" }],
      ["/admin-api/invites/abcd/revoke", {}],
      ["/admin-api/members/ada", { role: "editor" }],
      ["/admin-api/members/ada/remove", {}],
    ] as const)
      expect((await eda(path, body)).status, path).toBe(403);
    expect(await member("default", "ada")).toBe("admin");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM invites").first("n")).toBe(0);
  });

  it("an admin of one workspace can't see or touch another's members or invites", async () => {
    const ada = await dash("ada");
    await ada("/admin-api/invites", { email: "pending@example.com", role: "editor" });
    const id = ((await ada("/admin-api/members")).json.invites as { id: string }[])[0].id;
    const bob = await dash("bob");
    const list = await bob("/admin-api/members");
    expect((list.json.members as { userId: string }[]).map((m) => m.userId)).toEqual(["bob"]);
    expect(list.json.invites).toEqual([]);
    expect((await bob("/admin-api/members/eda/remove", {})).status).toBe(404);
    expect((await bob("/admin-api/members/ada", { role: "creator" })).status).toBe(404);
    expect((await bob("/admin-api/members/eda", { role: "admin" })).status).toBe(404);
    expect(await member("b", "eda")).toBeNull();
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'member_role' AND workspace_id = 'b'").first(
        "n",
      ),
    ).toBe(0);
    expect((await bob(`/admin-api/invites/${id}/revoke`, {})).status).toBe(404);
    expect(await member("default", "eda")).toBe("editor");
    expect(await member("default", "ada")).toBe("admin");
    // inviting someone who's a member elsewhere is just an invite: nothing about the other workspace is said
    expect((await bob("/admin-api/invites", { email: "eda@example.com", role: "editor" })).status).toBe(200);
  });

  it("asks for a fresh passkey to invite, change a role, revoke or remove", async () => {
    const token = await createSession(env.DB, nowS(), { app: "dashboard", userId: "ada" });
    await env.DB.prepare("UPDATE sessions SET verified_at = 0").run();
    const ada = (path: string, body?: unknown) => req("dashboard", `bongsu_admin=${token}`, path, body);
    for (const [path, body] of [
      ["/admin-api/invites", { email: "x@example.com", role: "editor" }],
      ["/admin-api/invites/abcd/revoke", {}],
      ["/admin-api/members/eda", { role: "admin" }],
      ["/admin-api/members/eda/remove", {}],
    ] as const) {
      const r = await ada(path, body);
      expect([r.status, r.json.verify], path).toEqual([403, true]);
    }
    expect((await ada("/admin-api/members")).status).toBe(200);
  });
});
