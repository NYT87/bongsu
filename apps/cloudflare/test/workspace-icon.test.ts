// Setting a workspace's icon in the dashboard (Phase 13 part 3b): admins only, in their own workspace, checked as a
// PNG, shown in the dashboard's state and settings and in the app's `me`. The push side is in push.test.ts.
import { env } from "cloudflare:workers";
import { adminRoutes } from "@bongsu/api/dashboard/routes";
import { appRoutes } from "@bongsu/api/pwa/routes";
import { createSession, setSessionWorkspace } from "@bongsu/api/pwa/session";
import type { Verifiers } from "@bongsu/api/pwa/webauthn";
import type { Env } from "@bongsu/core/env";
import { setIcon } from "@bongsu/core/icon";
import { addMember } from "@bongsu/core/people";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { png } from "./icon-png";
import { testEnv, World } from "./world";

const nowS = () => Math.floor(Date.now() / 1000);
const USERS = ["amy", "otto", "pat"];
const fake: Verifiers = {
  registration: (async () => ({ verified: true })) as unknown as Verifiers["registration"],
  authentication: (async () => ({ verified: true })) as unknown as Verifiers["authentication"],
};
let w: World;
let e: Env;

type Json = Record<string, any>;
/** A person's dashboard session, in `workspaceId` when given. */
const dash = async (userId: string, workspaceId?: string) => {
  const token = await createSession(env.DB, nowS(), { app: "dashboard", userId });
  if (workspaceId) await setSessionWorkspace(env.DB, token, workspaceId);
  return { Cookie: `bongsu_admin=${token}` };
};
const call = async (method: string, path: string, headers: Record<string, string>, body?: BodyInit) => {
  const r = await adminRoutes(w.fetch, fake).request(
    `https://bongsu.test${path}`,
    { method, headers, ...(body === undefined ? {} : { body }) },
    e,
  );
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Json };
};
const putIcon = (h: Record<string, string>, bytes: Uint8Array) =>
  call("PUT", "/admin-api/settings/icon", { ...h, "Content-Type": "image/png" }, bytes);
const me = async (userId: string, workspaceId: string) => {
  const token = await createSession(env.DB, nowS(), { userId });
  await setSessionWorkspace(env.DB, token, workspaceId);
  const r = await appRoutes(w.fetch, fake).request(
    "https://bongsu.test/app-api/me",
    { headers: { Cookie: `bongsu_session=${token}` } },
    e,
  );
  return (await r.json()) as Json;
};
const auditRows = (action: string) =>
  env.DB.prepare("SELECT workspace_id, user_id FROM audit WHERE action = ?1")
    .bind(action)
    .all<{ workspace_id: string; user_id: string }>();

beforeEach(async () => {
  w = new World();
  e = await testEnv(env, { PUBLIC_URL: "https://bongsu.test", RP_ID: "bongsu.test" } as Partial<Env>);
  const ids = USERS.map((u) => `'${u}'`).join(", ");
  await env.DB.batch(
    [
      "DELETE FROM sessions",
      "DELETE FROM workspace_icons",
      "DELETE FROM audit WHERE action IN ('workspace_icon_set', 'workspace_icon_remove')",
      `DELETE FROM memberships WHERE user_id IN (${ids})`,
      `DELETE FROM users WHERE id IN (${ids})`,
      "INSERT INTO workspaces (id, name, created_at) VALUES ('b', 'Workspace B', 0) ON CONFLICT (id) DO UPDATE SET archived_at = NULL",
      "INSERT INTO users (id, email, name, created_at) VALUES ('amy', 'amy@example.com', 'Amy', 0)",
      "INSERT INTO users (id, email, name, created_at) VALUES ('otto', 'otto@example.com', 'Otto', 0)",
      "INSERT INTO users (id, email, name, created_at) VALUES ('pat', 'pat@example.com', 'Pat', 0)",
    ].map((s) => env.DB.prepare(s)),
  );
  await addMember(env.DB, "default", "amy", "admin", 0);
  await addMember(env.DB, "default", "otto", "editor", 0);
  await addMember(env.DB, "b", "amy", "editor", 0);
  await addMember(env.DB, "b", "pat", "admin", 0);
});
afterEach(async () => {
  await env.DB.prepare("DELETE FROM workspace_icons").run();
});

describe("PUT and DELETE /admin-api/settings/icon", () => {
  it("an admin sets the icon: the URL answered serves it, and settings and state show it", async () => {
    const h = await dash("amy", "default");
    const bytes = png(256);
    const put = await putIcon(h, bytes);
    expect(put.status).toBe(200);
    expect(put.json.iconUrl).toMatch(/^https:\/\/bongsu\.test\/icon\/[0-9a-f]{64}\.png$/);
    const res = await createAppFetch(put.json.iconUrl);
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
    expect((await call("GET", "/admin-api/settings", h)).json.iconUrl).toBe(put.json.iconUrl);
    const state = (await call("GET", "/admin-api/state", h)).json;
    expect(state.workspace.iconUrl).toBe(put.json.iconUrl);
    expect(state.workspaces.find((x: Json) => x.id === "default").iconUrl).toBe(put.json.iconUrl);
    expect(state.workspaces.find((x: Json) => x.id === "b").iconUrl).toBeNull();
    expect((await auditRows("workspace_icon_set")).results).toEqual([{ workspace_id: "default", user_id: "amy" }]);
  });

  it("refuses a PNG that isn't square, and a body over 200 KB", async () => {
    const h = await dash("amy", "default");
    const wide = await putIcon(h, png(300, 0, 200));
    expect(wide.status).toBe(400);
    expect(wide.json.error).toBe("the icon must be square (it's 300×200)");
    const big = await putIcon(h, png(256, 0, 256, 204_801));
    expect(big.status).toBe(400);
    expect(big.json.error).toBe("the icon is over 200 KB");
    expect((await auditRows("workspace_icon_set")).results).toEqual([]);
  });

  it("an editor can't set or remove it", async () => {
    const h = await dash("otto", "default");
    expect((await putIcon(h, png(256))).status).toBe(403);
    expect((await call("DELETE", "/admin-api/settings/icon", h)).status).toBe(403);
  });

  it("an agent key doesn't reach it", async () => {
    const r = await putIcon({ Authorization: "Bearer bongsu_notadashboardsessionnotadashboa" }, png(256));
    expect(r.status).toBe(401);
  });

  it("removing it answers iconUrl null and is audited", async () => {
    const h = await dash("amy", "default");
    await putIcon(h, png(256));
    const del = await call("DELETE", "/admin-api/settings/icon", h);
    expect(del.status).toBe(200);
    expect(del.json.iconUrl).toBeNull();
    expect((await call("GET", "/admin-api/settings", h)).json.iconUrl).toBeNull();
    expect((await auditRows("workspace_icon_remove")).results).toEqual([{ workspace_id: "default", user_id: "amy" }]);
  });

  it("acts only on the session's workspace", async () => {
    await setIcon(env.DB, "b", png(256, 3), 1);
    const h = await dash("amy", "default");
    await putIcon(h, png(256));
    await call("DELETE", "/admin-api/settings/icon", h);
    const b = await dash("pat", "b");
    expect((await call("GET", "/admin-api/settings", b)).json.iconUrl).toMatch(/\/icon\/[0-9a-f]{64}\.png$/);
  });
});

describe("the app's me", () => {
  it("shows the workspace's icon, and each listed workspace's (null without one)", async () => {
    const a = await setIcon(env.DB, "default", png(256), 1);
    const m = await me("amy", "default");
    expect(m.workspace.iconUrl).toBe(`https://bongsu.test/icon/${a}.png`);
    const list = Object.fromEntries(m.workspaces.map((x: Json) => [x.id, x.iconUrl]));
    expect(list).toEqual({ default: `https://bongsu.test/icon/${a}.png`, b: null });
    const b = await setIcon(env.DB, "b", png(256, 5), 2);
    const inB = await me("amy", "b");
    expect(inB.workspace.iconUrl).toBe(`https://bongsu.test/icon/${b}.png`);
    expect(inB.workspaces.find((x: Json) => x.id === "b").iconUrl).toBe(`https://bongsu.test/icon/${b}.png`);
  });
});

/** GETs a URL the API answered, through the whole app (the route is public). */
async function createAppFetch(url: string) {
  const { createApp } = await import("@bongsu/api/app");
  return createApp(w.fetch).request(url, {}, e);
}
