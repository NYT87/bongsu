// The app's content routes served to the dashboard (#145): /admin-api/content/* behind the dashboard session, the same
// handlers and role rules as /app-api/*. Each session works only on its own side; a creator is sent to the app; an
// editor plans but never approves, pauses or resumes; the app's own routes (sign-in, push, its settings) aren't there.
import { env } from "cloudflare:workers";
import { adminRoutes } from "@bongsu/api/dashboard/routes";
import { appRoutes } from "@bongsu/api/pwa/routes";
import { createSession } from "@bongsu/api/pwa/session";
import type { Verifiers } from "@bongsu/api/pwa/webauthn";
import type { Env } from "@bongsu/core/env";
import { beforeEach, describe, expect, it } from "vitest";
import { clearPlan, MD5, seedMediaStore, seedReel, testEnv, World } from "./world";

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

type Answer = { status: number; json: Record<string, unknown> };
/** A request to the dashboard's router or the app's, with this cookie. */
const send = async (routes: "dashboard" | "pwa", cookie: string, path: string, body?: unknown): Promise<Answer> => {
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
/** Bea's dashboard session (`bongsu_admin`) with `role` in the default workspace, made `at`. */
const dashboard = async (role: string, at = nowS()) => {
  await setRole("bea", role);
  return `bongsu_admin=${await createSession(env.DB, at, { app: "dashboard", userId: "bea" })}`;
};
/** Bea's app session (`bongsu_session`). */
const phone = async (role: string) => {
  await setRole("bea", role);
  return `bongsu_session=${await createSession(env.DB, nowS(), { userId: "bea" })}`;
};

beforeEach(async () => {
  w = new World();
  e = await testEnv(env, { PUBLIC_URL: "https://bongsu.test", RP_ID: "bongsu.test" } as Partial<Env>);
  await env.DB.batch(
    [
      "DELETE FROM sessions",
      "DELETE FROM approvals",
      "UPDATE workspace_settings SET paused = NULL",
      "UPDATE workspaces SET archived_at = NULL",
      "DELETE FROM memberships WHERE user_id IN ('bea', 'ina')",
      "DELETE FROM passkeys WHERE user_id = 'bea'",
      "INSERT INTO users (id, name, created_at, instance_admin) VALUES ('bea', 'Bea', 0, 0) ON CONFLICT (id) DO UPDATE SET instance_admin = 0",
      "INSERT INTO users (id, name, created_at, instance_admin) VALUES ('ina', 'Ina', 0, 1) ON CONFLICT (id) DO UPDATE SET instance_admin = 1",
      // Bea's passkey on her computer: any of a person's passkeys approves
      "INSERT INTO passkeys (id, user_id, public_key, counter, created_at) VALUES ('cred-bea', 'bea', 'AQID', 0, 0)",
    ].map((s) => env.DB.prepare(s)),
  );
  await clearPlan();
  await seedMediaStore();
});

describe("the dashboard's content routes", () => {
  it("a dashboard session reads the queue the app reads", async () => {
    await seedReel(w, { approve: false });
    const fromDashboard = await send("dashboard", await dashboard("admin"), "/admin-api/content/queue");
    const fromPhone = await send("pwa", await phone("admin"), "/app-api/queue");
    expect(fromDashboard.status).toBe(200);
    expect(fromDashboard.json).toEqual(fromPhone.json);
  });

  it("each session works only on its own side", async () => {
    const admin = await dashboard("admin");
    const app = await phone("admin");
    expect((await send("pwa", admin, "/app-api/queue")).status).toBe(401);
    expect((await send("dashboard", app, "/admin-api/content/queue")).status).toBe(401);
  });

  it("a creator is sent to the app", async () => {
    const r = await send("dashboard", await dashboard("creator"), "/admin-api/content/queue");
    expect([r.status, r.json.app]).toEqual([403, true]);
  });

  it("an editor plans but doesn't approve, pause or resume", async () => {
    const { key } = await seedReel(w, { approve: false });
    const editor = await dashboard("editor");
    for (const [path, scope] of [
      ["/admin-api/content/approve/options", "approve"],
      ["/admin-api/content/%61pprove/options", "approve"],
      ["/admin-api/content/pause", "pause"],
      ["/admin-api/content/resume/options", "resume"],
    ]) {
      const r = await send("dashboard", editor, path, { key });
      expect([r.status, r.json.error], path).toEqual([403, expect.stringContaining(`"${scope}"`)]);
    }
    expect((await send("dashboard", editor, "/admin-api/content/item/hold", { key, hold: true })).status).toBe(200);
  });

  it("an admin approves from the dashboard with any of their passkeys", async () => {
    const { key, folder, base } = await seedReel(w, { approve: false });
    w.drivePut(`UPLOADS/${folder}/exports/shorts/instagram/${base}.mp4`, { md5: MD5, mimeType: "video/mp4" });
    const admin = await dashboard("admin");
    const o = await send("dashboard", admin, "/admin-api/content/approve/options", { key });
    expect(o.status).toBe(200);
    const v = await send("dashboard", admin, "/admin-api/content/approve/verify", {
      challengeId: o.json.challengeId,
      response: { id: "cred-bea" },
    });
    expect(v.json).toMatchObject({ approved: true, key });
    // Bea approved it, through the dashboard
    const a = await env.DB.prepare("SELECT user_id, approved_by FROM approvals WHERE item_key = ?1").bind(key).first();
    expect(a).toEqual({ user_id: "bea", approved_by: "owner@dashboard" });
  });

  it("the app's own routes aren't there", async () => {
    const admin = await dashboard("admin");
    for (const path of [
      "/admin-api/content/push/subscribe",
      "/admin-api/content/notify-prefs",
      "/admin-api/content/me/timezone",
      "/admin-api/content/login/options",
      "/admin-api/content/session/workspace",
      "/admin-api/content/connect/youtube/start",
    ])
      expect((await send("dashboard", admin, path, {})).status, path).toBe(404);
    // the person and the platforms are the screens', so they are there
    expect((await send("dashboard", admin, "/admin-api/content/me")).status).toBe(200);
    expect((await send("dashboard", admin, "/admin-api/content/platforms")).status).toBe(200);
  });

  it("is refused like the rest of /admin-api", async () => {
    // an instance admin in no workspace
    const ina = `bongsu_admin=${await createSession(env.DB, nowS(), { app: "dashboard", userId: "ina" })}`;
    const none = await send("dashboard", ina, "/admin-api/content/queue");
    expect([none.status, none.json.noWorkspace]).toEqual([403, true]);
    // a session older than the dashboard's 12 hours
    expect(
      (await send("dashboard", await dashboard("admin", nowS() - 13 * 3600), "/admin-api/content/queue")).status,
    ).toBe(401);
    // the workspace archived
    const admin = await dashboard("admin");
    await env.DB.prepare("UPDATE workspaces SET archived_at = 1 WHERE id = 'default'").run();
    expect((await send("dashboard", admin, "/admin-api/content/queue")).status).toBe(403);
  });
});
