// A workspace's own media folder, stores and OAuth apps in the dashboard's Settings (/admin-api/settings/media,
// /settings/oauth-apps) and the instance's Scheduler page (/admin-api/scheduler): who reaches them, what they answer.
import { env } from "cloudflare:workers";
import { adminRoutes } from "@bongsu/api/dashboard/routes";
import { createSession, markVerified } from "@bongsu/api/pwa/session";
import type { Verifiers } from "@bongsu/api/pwa/webauthn";
import { CRON_INBOX, CRON_INSTAGRAM, CRON_SHORTS } from "@bongsu/core/constants";
import type { Env } from "@bongsu/core/env";
import { scanInbox } from "@bongsu/core/inbox";
import { saveStore } from "@bongsu/core/media/manage";
import { createWorkspace } from "@bongsu/core/people";
import { tick } from "@bongsu/core/tick";
import { beforeEach, describe, expect, it } from "vitest";
import { seedMediaStore, TEST_S3_KEYS, TEST_S3_SETTINGS, testEnv, World } from "./world";

const nowS = () => Math.floor(Date.now() / 1000);
const fake: Verifiers = {
  registration: (async () => ({ verified: true })) as unknown as Verifiers["registration"],
  authentication: (async () => ({
    verified: true,
    authenticationInfo: { newCounter: 1 },
  })) as unknown as Verifiers["authentication"],
};
const S3_FORM = { ...TEST_S3_SETTINGS, ...TEST_S3_KEYS };

let w: World;
let e: Env;
let otherId: string;

type Answer = { status: number; json: Record<string, any>; location: string | null; setCookies: string[] };
type Call = (path: string, body?: unknown, o?: { method?: string; cookie?: string }) => Promise<Answer>;
const caller =
  (token: string): Call =>
  async (path, body, o) => {
    const r = await adminRoutes(w.fetch, fake).request(
      `https://bongsu.test${path}`,
      {
        method: o?.method ?? (body === undefined ? "GET" : "POST"),
        headers: {
          Cookie: [`bongsu_admin=${token}`, o?.cookie ?? ""].filter(Boolean).join("; "),
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      e,
    );
    const text = await r.text();
    return {
      status: r.status,
      location: r.headers.get("Location"),
      setCookies: r.headers.getSetCookie(),
      json: text.startsWith("{") ? JSON.parse(text) : {},
    };
  };
/** A dashboard session of `userId` in the default workspace (workspace A), with `role` there: its passkey check fresh. */
const as = async (userId: string, role?: string): Promise<Call> => {
  if (role)
    await env.DB.prepare(
      "INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES ('default', ?1, ?2, 0) ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = ?2",
    )
      .bind(userId, role)
      .run();
  const token = await createSession(env.DB, nowS(), { app: "dashboard", userId });
  await markVerified(env.DB, token, nowS());
  return caller(token);
};

beforeEach(async () => {
  w = new World();
  e = await testEnv(env, { PUBLIC_URL: "https://bongsu.test", RP_ID: "bongsu.test" } as Partial<Env>);
  await env.DB.batch(
    [
      "DELETE FROM sessions",
      "DELETE FROM audit",
      "DELETE FROM oauth_apps",
      "DELETE FROM workspace_oauth_apps",
      "DELETE FROM oauth_states",
      "DELETE FROM memberships WHERE user_id IN ('amy', 'ed', 'cy', 'ina')",
      "DELETE FROM settings WHERE key LIKE 'tick_last:%' OR key IN ('inbox_last', 'inbox_cursor')",
      "UPDATE workspace_settings SET media_folder = 'UPLOADS' WHERE workspace_id = 'default'",
      "INSERT INTO users (id, name, created_at, instance_admin) VALUES ('amy', 'Amy', 0, 0) ON CONFLICT (id) DO UPDATE SET instance_admin = 0",
      "INSERT INTO users (id, name, created_at, instance_admin) VALUES ('ed', 'Ed', 0, 0) ON CONFLICT (id) DO UPDATE SET instance_admin = 0",
      "INSERT INTO users (id, name, created_at, instance_admin) VALUES ('cy', 'Cy', 0, 0) ON CONFLICT (id) DO UPDATE SET instance_admin = 0",
      "INSERT INTO users (id, name, created_at, instance_admin) VALUES ('ina', 'Ina', 0, 1) ON CONFLICT (id) DO UPDATE SET instance_admin = 1",
    ].map((s) => env.DB.prepare(s)),
  );
  await seedMediaStore(); // the instance's Drive, its default
  // the workspaces earlier tests made, with everything that points at them
  const mine = "SELECT id FROM workspaces WHERE name IN ('Demo Studio', 'Demo Two')";
  await env.DB.batch(
    ["media_store", "memberships", "invites", "audit", "workspace_oauth_apps", "workspace_settings"]
      .map((t) => `DELETE FROM ${t} WHERE workspace_id IN (${mine})`)
      .concat(`DELETE FROM workspaces WHERE id IN (${mine})`)
      .map((q) => env.DB.prepare(q)),
  );
  otherId = await createWorkspace(
    env.DB,
    { name: "Demo Studio", timezone: "UTC", createdBy: "ina", mediaFolder: "demo-studio" },
    0,
  );
  await saveStore(
    e,
    w.fetch,
    { workspaceId: otherId },
    "s3",
    { ...TEST_S3_SETTINGS },
    JSON.stringify(TEST_S3_KEYS),
    "ina",
    0,
  );
});

describe("a workspace's media settings", () => {
  it("an admin sets the folder, adds a bucket, makes it the default, goes back to the instance's, removes it", async () => {
    const amy = await as("amy", "admin");
    expect((await amy("/admin-api/settings/media")).json).toMatchObject({
      folder: "UPLOADS",
      stores: [{ id: "drive", kind: "drive", own: false, default: true, status: "ok", waitingApprovals: 0 }],
      googleApp: false,
    });

    const put = (folder: unknown) => amy("/admin-api/settings/media/folder", { folder }, { method: "PUT" });
    expect((await put("demo-a")).json).toEqual({ folder: "demo-a" });
    expect((await amy("/admin-api/settings/media")).json.folder).toBe("demo-a");
    const taken = await put("demo-studio"); // the other workspace's
    expect(taken.status).toBe(400);
    expect(taken.json.error).toMatch(/another workspace uses demo-studio/);
    expect((await put("..")).status).toBe(400);
    expect((await amy("/admin-api/settings/media/folder", { folder: "x" }, { method: "POST" })).status).toBe(404);
    expect(await env.DB.prepare("SELECT action FROM audit WHERE action = 'media_folder'").first()).toEqual({
      action: "media_folder",
    });

    expect((await amy("/admin-api/settings/media/stores/s3/test", S3_FORM)).json).toEqual({ ok: true, error: null });
    expect((await amy("/admin-api/settings/media/stores/s3/test", { ...S3_FORM, accessKeyId: "WRONG" })).json.ok).toBe(
      false,
    );
    expect((await amy("/admin-api/settings/media/stores/s3", S3_FORM)).json).toEqual({ saved: true });
    const listed = (await amy("/admin-api/settings/media")).json.stores as Record<string, any>[];
    expect(listed.map((s) => [s.id, s.own, s.default])).toEqual([
      ["drive", false, false],
      ["s3-default", true, true], // the first of its own is its default
    ]);
    expect(JSON.stringify(listed)).not.toContain(TEST_S3_KEYS.secretAccessKey);
    expect(listed[1].settings).toMatchObject({ bucket: "media" });
    expect(listed[0].settings).toEqual({}); // the instance's settings aren't a workspace admin's to read

    expect((await amy("/admin-api/settings/media/default-instance", {})).json).toEqual({ default: null });
    expect(
      ((await amy("/admin-api/settings/media")).json.stores as { id: string; default: boolean }[]).map(
        (s) => s.default,
      ),
    ).toEqual([true, false]);
    expect((await amy("/admin-api/settings/media/stores/s3/default", {})).json).toEqual({ default: "s3" });
    expect(
      ((await amy("/admin-api/settings/media")).json.stores as { id: string; default: boolean }[]).map(
        (s) => s.default,
      ),
    ).toEqual([false, true]);

    expect((await amy("/admin-api/settings/media/stores/s3/remove", {})).json).toEqual({ removed: true });
    expect(((await amy("/admin-api/settings/media")).json.stores as unknown[]).length).toBe(1);
    expect((await amy("/admin-api/settings/media/stores/s3/remove", {})).status).toBe(400); // gone already
    expect((await amy("/admin-api/settings/media/stores/local", {})).status).toBe(404); // a bucket or a Drive only
    expect((await amy("/admin-api/settings/media/stores/local/default", {})).status).toBe(404);
    const actions = (
      await env.DB.prepare(
        "SELECT action, workspace_id FROM audit WHERE action LIKE 'workspace_store_%' ORDER BY id",
      ).all()
    ).results;
    expect(actions).toEqual([
      { action: "workspace_store_set", workspace_id: "default" },
      { action: "workspace_store_set", workspace_id: "default" },
      { action: "workspace_store_set", workspace_id: "default" },
      { action: "workspace_store_remove", workspace_id: "default" },
    ]);
  });

  it("a workspace's bucket is only reached at a public https address; the instance's endpoints aren't limited", async () => {
    const amy = await as("amy", "admin");
    const refused: [string, RegExp][] = [
      ["http://s3.test", /https:/],
      ["https://127.0.0.1", /not an IP address/],
      ["https://2130706433", /not an IP address/], // 127.0.0.1 written as one number
      ["https://[::1]", /not an IP address/],
      ["https://[::ffff:10.0.0.5]", /not an IP address/],
      ["https://10.0.0.5:9000", /not an IP address/],
      ["https://169.254.169.254", /not an IP address/],
      ["https://localhost", /public address/],
      ["https://minio.localhost", /public address/],
      ["https://minio", /public address/],
      ["https://bucket.internal", /public address/],
      ["https://nas.local.", /public address/],
    ];
    for (const [endpoint, why] of refused)
      for (const p of ["stores/s3/test", "stores/s3"]) {
        const r = await amy(`/admin-api/settings/media/${p}`, { ...S3_FORM, endpoint });
        expect(r.status, `${p} ${endpoint}`).toBe(400);
        expect(r.json.error, `${p} ${endpoint}`).toMatch(why);
      }
    expect(await env.DB.prepare("SELECT 1 FROM media_store WHERE id = 's3-default'").first()).toBeNull();
    // the core refuses it too, whoever calls
    await expect(
      saveStore(
        e,
        w.fetch,
        { workspaceId: "default" },
        "s3",
        { ...TEST_S3_SETTINGS, endpoint: "https://127.0.0.1" },
        JSON.stringify(TEST_S3_KEYS),
        "amy",
        0,
      ),
    ).rejects.toThrow(/not an IP address/);
    // a public name over https still works
    expect((await amy("/admin-api/settings/media/stores/s3/test", S3_FORM)).json).toEqual({ ok: true, error: null });
    // the instance's: http and addresses are the instance admins' call (their server, their network)
    const ina = await as("ina");
    expect((await ina("/admin-api/media-stores/s3/test", { ...S3_FORM, endpoint: "http://s3.test" })).json).toEqual({
      ok: true,
      error: null,
    });
    const local = await ina("/admin-api/media-stores/s3/test", { ...S3_FORM, endpoint: "http://127.0.0.1:9000" });
    expect(local.status).toBe(200);
  });

  it("changes that ask for a fresh passkey check refuse without one", async () => {
    await env.DB.prepare(
      "INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES ('default', 'amy', 'admin', 0) ON CONFLICT (workspace_id, user_id) DO NOTHING",
    ).run();
    const stale = caller(await createSession(env.DB, nowS() - 11 * 60, { app: "dashboard", userId: "amy" }));
    for (const p of ["stores/s3", "stores/s3/test", "stores/drive/start", "stores/s3/remove"])
      expect((await stale(`/admin-api/settings/media/${p}`, S3_FORM)).json, p).toMatchObject({ verify: true });
    expect(
      (await stale("/admin-api/settings/oauth-apps/google", { clientId: "c", clientSecret: "s" })).json,
    ).toMatchObject({ verify: true });
    expect((await stale("/admin-api/settings/oauth-apps/google/remove", {})).json).toMatchObject({ verify: true });
  });

  it("an editor and a creator are refused every route; an agent key never reaches /admin-api", async () => {
    const routes: [string, unknown?, string?][] = [
      ["/admin-api/settings/media"],
      ["/admin-api/settings/media/folder", { folder: "x" }, "PUT"],
      ["/admin-api/settings/media/stores/s3/test", S3_FORM],
      ["/admin-api/settings/media/stores/s3", S3_FORM],
      ["/admin-api/settings/media/stores/drive/start", {}],
      ["/admin-api/settings/media/stores/s3/default", {}],
      ["/admin-api/settings/media/default-instance", {}],
      ["/admin-api/settings/media/stores/s3/remove", {}],
      ["/admin-api/settings/oauth-apps"],
      ["/admin-api/settings/oauth-apps/google", { clientId: "c", clientSecret: "s" }],
      ["/admin-api/settings/oauth-apps/google/remove", {}],
    ];
    for (const [who, role] of [
      ["ed", "editor"],
      ["cy", "creator"],
    ] as const) {
      const call = await as(who, role);
      for (const [p, b, method] of routes) expect((await call(p, b, { method })).status, `${role} ${p}`).toBe(403);
    }
    expect(await env.DB.prepare("SELECT 1 FROM media_store WHERE id = 's3-default'").first()).toBeNull();
    const key = "bongsu_workspaceAworkspaceAworksp";
    const r = await adminRoutes(w.fetch, fake).request(
      "https://bongsu.test/admin-api/settings/media",
      { headers: { Authorization: `Bearer ${key}` } },
      e,
    );
    expect(r.status).toBe(401);
  });

  it("never shows another workspace's own store, and can't touch it", async () => {
    const amy = await as("amy", "admin");
    const ids = ((await amy("/admin-api/settings/media")).json.stores as { id: string }[]).map((s) => s.id);
    expect(ids).toEqual(["drive"]); // not s3-<other>
    expect((await amy("/admin-api/settings/media/stores/s3/default", {})).status).toBe(400);
    expect((await amy("/admin-api/settings/media/stores/s3/remove", {})).status).toBe(400);
    expect(await env.DB.prepare("SELECT 1 FROM media_store WHERE id = ?1").bind(`s3-${otherId}`).first()).toBeTruthy();
  });

  it("a workspace's own OAuth apps: listed with the instance's as the fallback, saved and removed", async () => {
    const amy = await as("amy", "admin");
    await env.DB.prepare(
      "INSERT INTO oauth_apps (id, client_id, client_secret, updated_at, updated_by) VALUES ('google', 'instance-client', 'x', 0, 'ina')",
    ).run();
    const first = (await amy("/admin-api/settings/oauth-apps")).json as {
      apps: Record<string, any>[];
      encryptionKeySet: boolean;
    };
    expect(first.encryptionKeySet).toBe(true);
    expect(first.apps.find((a) => a.id === "google")).toMatchObject({ clientId: null, instance: true });
    expect(
      (await amy("/admin-api/settings/oauth-apps/google", { clientId: " own-client ", clientSecret: "own-secret" }))
        .json,
    ).toEqual({ saved: true });
    const after = (await amy("/admin-api/settings/oauth-apps")).json as { apps: Record<string, any>[] };
    expect(after.apps.find((a) => a.id === "google")).toMatchObject({ clientId: "own-client", instance: true });
    expect(JSON.stringify(after)).not.toContain("own-secret");
    expect((await amy("/admin-api/settings/oauth-apps/nope", { clientId: "c", clientSecret: "s" })).status).toBe(400);
    expect((await amy("/admin-api/settings/oauth-apps/google", { clientId: "c" })).status).toBe(400);
    // the other workspace sees none of it
    expect(await env.DB.prepare("SELECT workspace_id FROM workspace_oauth_apps").all()).toMatchObject({
      results: [{ workspace_id: "default" }],
    });
    expect((await amy("/admin-api/settings/oauth-apps/google/remove", {})).json).toEqual({ removed: true });
    expect(await env.DB.prepare("SELECT 1 FROM workspace_oauth_apps").first()).toBeNull();
    expect(
      (
        await env.DB.prepare(
          "SELECT action, workspace_id FROM audit WHERE action LIKE 'workspace_oauth_app_%' ORDER BY id",
        ).all()
      ).results,
    ).toEqual([
      { action: "workspace_oauth_app_set", workspace_id: "default" },
      { action: "workspace_oauth_app_remove", workspace_id: "default" },
    ]);
  });

  it("a workspace's Connect Google Drive comes back to its Settings, audited in the workspace", async () => {
    const amy = await as("amy", "admin");
    expect((await amy("/admin-api/settings/media/stores/drive/start", {})).status).toBe(400); // no Google app yet
    await amy("/admin-api/settings/oauth-apps/google", { clientId: "own-g", clientSecret: "own-secret" });
    const start = await amy("/admin-api/settings/media/stores/drive/start", {});
    const flowCookie = start.setCookies.find((c) => c.startsWith("bongsu_oauth="))!.split(";")[0];
    const url = new URL(start.json.url as string);
    expect(url.searchParams.get("client_id")).toBe("own-g");
    w.googleChallenge = url.searchParams.get("code_challenge")!;
    w.googleGrantScope = "https://www.googleapis.com/auth/drive";
    w.drivePut("UPLOADS/inbox/keep.txt", { md5: "k", mimeType: "text/plain" });
    const back = await amy(
      `/admin-api/media-stores/drive/callback?code=g-code&state=${url.searchParams.get("state")}`,
      undefined,
      {
        cookie: flowCookie,
      },
    );
    expect(back.location).toBe("https://bongsu.test/dashboard/settings/media?connected=drive");
    expect(
      await env.DB.prepare("SELECT workspace_id, is_default FROM media_store WHERE id = 'drive-default'").first(),
    ).toEqual({ workspace_id: "default", is_default: 1 });
    expect(
      await env.DB.prepare(
        "SELECT action, workspace_id FROM audit WHERE action LIKE '%store%' ORDER BY id DESC LIMIT 1",
      ).first(),
    ).toEqual({
      action: "workspace_store_set",
      workspace_id: "default",
    });
  });

  it("the Workspaces page's create takes a folder, and refuses one in use", async () => {
    const ina = await as("ina");
    const make = (folder?: string) =>
      ina("/admin-api/workspaces", {
        name: "Demo Two",
        timezone: "UTC",
        admin: "me",
        ...(folder === undefined ? {} : { folder }),
      });
    expect((await make("demo-studio")).status).toBe(400);
    const ok = await make("demo-two-files");
    expect(ok.status).toBe(200);
    expect(
      await env.DB.prepare("SELECT media_folder FROM workspace_settings WHERE workspace_id = ?1")
        .bind(ok.json.id)
        .first("media_folder"),
    ).toBe("demo-two-files");
  });
});

describe("the Scheduler page", () => {
  it("an instance admin gets the runs, and what the last tick and inbox run recorded", async () => {
    const ina = await as("ina");
    expect((await ina("/admin-api/scheduler")).json).toEqual({
      runs: [
        { name: "instagram", cron: CRON_INSTAGRAM },
        { name: "shorts", cron: CRON_SHORTS },
        { name: "inbox", cron: CRON_INBOX },
      ],
      jobsPerTick: null,
      inboxWorkspacesPerRun: null,
      inboxLast: null,
      variables: { jobsPerTick: "JOBS_PER_TICK", inboxWorkspacesPerRun: "INBOX_WORKSPACES_PER_RUN" },
    });
    const cron = await testEnv(env, { JOBS_PER_TICK: "3", INBOX_WORKSPACES_PER_RUN: "1" });
    const now = new Date("2026-10-20T09:00:00Z");
    await tick(cron, { fetch: w.fetch, now }, "instagram");
    await scanInbox(cron, { fetch: w.fetch, now });
    const at = "2026-10-20T09:00:00Z";
    const j = (await ina("/admin-api/scheduler")).json;
    expect(j.jobsPerTick).toEqual({ value: 3, at });
    expect(j.inboxWorkspacesPerRun).toEqual({ value: 1, at });
    expect(j.inboxLast).toMatchObject({ at, reached: 1, limit: 1 });
    expect(j.inboxLast.total).toBeGreaterThanOrEqual(2);
  });

  it("a workspace admin, an editor and a creator are refused", async () => {
    for (const [who, role] of [
      ["amy", "admin"],
      ["ed", "editor"],
      ["cy", "creator"],
    ] as const) {
      const call = await as(who, role);
      expect((await call("/admin-api/scheduler")).status, role).toBe(403);
    }
  });
});
