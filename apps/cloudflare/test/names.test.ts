// People's names (Phase 13 part 3b): the fallback rule in core (a display name in the workspace, else the person's
// name, else the email's start) on real SQL, and the three routes that edit them.
import { env } from "cloudflare:workers";
import { adminRoutes } from "@bongsu/api/dashboard/routes";
import { appRoutes } from "@bongsu/api/pwa/routes";
import { createSession, setSessionWorkspace } from "@bongsu/api/pwa/session";
import type { Env } from "@bongsu/core/env";
import { addMember } from "@bongsu/core/people";
import { memberName, memberNames, setDisplayName, setUserName } from "@bongsu/core/workspaces";
import { beforeEach, describe, expect, it } from "vitest";
import { testEnv, World } from "./world";

const nowS = () => Math.floor(Date.now() / 1000);
const USERS = ["amy", "otto", "ina", "pat", "nix", "zed"];
const LONG = "a".repeat(61);
let w: World;
let e: Env;

type Json = Record<string, any>;
const send = async (
  routes: "app" | "admin",
  path: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<{ status: number; json: Json }> => {
  const app = routes === "app" ? appRoutes(w.fetch) : adminRoutes(w.fetch);
  const r = await app.request(
    `https://bongsu.test${path}`,
    {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    e,
  );
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Json };
};
/** A person's app session, in `workspaceId` when given. */
const as = async (userId: string, workspaceId?: string) => {
  const token = await createSession(env.DB, nowS(), { userId });
  if (workspaceId) await setSessionWorkspace(env.DB, token, workspaceId);
  const h = { Cookie: `bongsu_session=${token}` };
  return {
    me: () => send("app", "/app-api/me", h),
    post: (path: string, body: unknown) => send("app", path, h, body),
  };
};
/** The same person's dashboard session. */
const dash = async (userId: string, workspaceId?: string) => {
  const token = await createSession(env.DB, nowS(), { app: "dashboard", userId });
  if (workspaceId) await setSessionWorkspace(env.DB, token, workspaceId);
  const h = { Cookie: `bongsu_admin=${token}` };
  return (path: string, body: unknown) => send("admin", path, h, body);
};
const auditRows = (action: string) =>
  env.DB.prepare("SELECT target, workspace_id, user_id, detail FROM audit WHERE action = ?1 ORDER BY id")
    .bind(action)
    .all<{ target: string; workspace_id: string | null; user_id: string; detail: string }>();

beforeEach(async () => {
  w = new World();
  e = await testEnv(env, { PUBLIC_URL: "https://bongsu.test", RP_ID: "bongsu.test" } as Partial<Env>);
  const ids = USERS.map((u) => `'${u}'`).join(", ");
  await env.DB.batch(
    [
      "DELETE FROM sessions",
      "DELETE FROM api_keys",
      "DELETE FROM audit WHERE action IN ('user_name', 'member_name')",
      `DELETE FROM memberships WHERE user_id IN (${ids})`,
      `DELETE FROM users WHERE id IN (${ids})`,
      "INSERT INTO workspaces (id, name, created_at) VALUES ('b', 'Workspace B', 0) ON CONFLICT (id) DO UPDATE SET archived_at = NULL",
      "INSERT INTO users (id, email, name, created_at) VALUES ('amy', 'amy@example.com', 'Amy', 0)",
      "INSERT INTO users (id, email, name, created_at) VALUES ('otto', 'otto@example.com', NULL, 0)",
      "INSERT INTO users (id, email, name, created_at, instance_admin) VALUES ('ina', 'ina@example.com', 'Ina', 0, 1)",
      "INSERT INTO users (id, email, name, created_at) VALUES ('pat', 'pat@example.com', 'Pat', 0)",
      "INSERT INTO users (id, email, name, created_at) VALUES ('nix', NULL, NULL, 0)",
      "INSERT INTO users (id, email, name, created_at) VALUES ('zed', 'zed@example.com', 'Zed', 0)",
    ].map((s) => env.DB.prepare(s)),
  );
  await addMember(env.DB, "default", "amy", "admin", 0);
  await addMember(env.DB, "default", "otto", "editor", 0);
  await addMember(env.DB, "b", "amy", "editor", 0);
  await addMember(env.DB, "b", "pat", "admin", 0);
});

describe("memberName and memberNames", () => {
  it("a display name wins, then the name, then the email's start", async () => {
    await setDisplayName(env.DB, "default", "amy", "A. Lee");
    expect(await memberName(env.DB, "amy", "default")).toBe("A. Lee");
    await setDisplayName(env.DB, "default", "amy", null);
    expect(await memberName(env.DB, "amy", "default")).toBe("Amy");
    expect(await memberName(env.DB, "otto", "default")).toBe("otto");
  });

  it("an unknown user, or one with no name and no email, is null", async () => {
    expect(await memberName(env.DB, "nobody", "default")).toBeNull();
    expect(await memberName(env.DB, "nix", "default")).toBeNull();
  });

  it("a display name belongs to its workspace", async () => {
    await setDisplayName(env.DB, "default", "amy", "A. Lee");
    expect(await memberName(env.DB, "amy", "b")).toBe("Amy");
  });

  it("someone who isn't a member is named by name, else email", async () => {
    expect(await memberName(env.DB, "zed", "default")).toBe("Zed");
    await setUserName(env.DB, "zed", null);
    expect(await memberName(env.DB, "zed", "default")).toBe("zed");
  });

  it("setDisplayName says false for a non-member", async () => {
    expect(await setDisplayName(env.DB, "default", "pat", "P")).toBe(false);
    expect(await setDisplayName(env.DB, "b", "pat", "P")).toBe(true);
  });

  it("the list gives what one at a time gives", async () => {
    await setDisplayName(env.DB, "default", "amy", "A. Lee");
    const ids = ["amy", "otto", "zed", "nix", "nobody"];
    const map = await memberNames(env.DB, ids, "default");
    for (const id of ids) expect(map.get(id) ?? null, id).toBe(await memberName(env.DB, id, "default"));
    expect([...map.keys()].sort()).toEqual(["amy", "otto", "zed"]);
    expect((await memberNames(env.DB, [], "default")).size).toBe(0);
  });
});

describe("POST /app-api/me/name", () => {
  it("sets the name, an empty one clears it, too long is a 400", async () => {
    const amy = await as("amy", "default");
    const r = await amy.post("/app-api/me/name", { name: "  Jo " });
    expect(r.status).toBe(200);
    expect((await amy.me()).json.you).toEqual({ name: "Jo", displayName: null, shownAs: "Jo" });
    expect((await amy.post("/app-api/me/name", { name: "" })).status).toBe(200);
    expect((await amy.me()).json.you).toEqual({ name: null, displayName: null, shownAs: "amy" });
    const bad = await amy.post("/app-api/me/name", { name: LONG });
    expect([bad.status, bad.json.error]).toEqual([400, "a name is 1 to 60 characters"]);
  });

  it("is audited", async () => {
    await (await as("amy", "default")).post("/app-api/me/name", { name: "Jo" });
    const rows = (await auditRows("user_name")).results;
    expect(rows.map((r) => [r.target, r.user_id])).toEqual([["amy", "amy"]]);
  });
});

describe("POST /app-api/me/display-name", () => {
  it("shows in that workspace only, and is audited with its workspace", async () => {
    const inA = await as("amy", "default");
    expect((await inA.post("/app-api/me/display-name", { name: "J. Park" })).status).toBe(200);
    expect((await inA.me()).json.you).toEqual({ name: "Amy", displayName: "J. Park", shownAs: "J. Park" });
    expect(((await (await as("amy", "b")).me()).json.you as Json).shownAs).toBe("Amy");
    const rows = (await auditRows("member_name")).results;
    expect(rows.map((r) => [r.target, r.workspace_id, r.user_id])).toEqual([["amy", "default", "amy"]]);
    expect((await inA.post("/app-api/me/display-name", { name: "" })).status).toBe(200);
    expect(((await inA.me()).json.you as Json).displayName).toBeNull();
    const bad = await inA.post("/app-api/me/display-name", { name: LONG });
    expect([bad.status, bad.json.error]).toEqual([400, "a name is 1 to 60 characters"]);
  });

  it("is 403 for a visiting instance admin who isn't a member", async () => {
    const ina = await as("ina", "default");
    expect((await ina.post("/app-api/me/display-name", { name: "X" })).status).toBe(403);
    expect((await auditRows("member_name")).results).toEqual([]);
  });
});

describe("POST /admin-api/members/:userId/name", () => {
  it("an admin names a member of their workspace", async () => {
    const admin = await dash("amy", "default");
    const r = await admin("/admin-api/members/otto/name", { name: "Otto K." });
    expect([r.status, r.json]).toEqual([200, { userId: "otto", displayName: "Otto K." }]);
    expect(await memberName(env.DB, "otto", "default")).toBe("Otto K.");
    const rows = (await auditRows("member_name")).results;
    expect(rows.map((x) => [x.target, x.workspace_id, x.user_id])).toEqual([["user:otto", "default", "amy"]]);
    expect((await admin("/admin-api/members/otto/name", { name: "" })).status).toBe(200);
    expect(await memberName(env.DB, "otto", "default")).toBe("otto");
    expect((await admin("/admin-api/members/otto/name", { name: LONG })).status).toBe(400);
  });

  it("an editor is refused (the members area)", async () => {
    const editor = await dash("otto", "default");
    expect((await editor("/admin-api/members/amy/name", { name: "X" })).status).toBe(403);
    expect(await memberName(env.DB, "amy", "default")).toBe("Amy");
  });

  it("a user who isn't a member of the workspace is a 404", async () => {
    const admin = await dash("amy", "default");
    expect((await admin("/admin-api/members/pat/name", { name: "X" })).status).toBe(404);
    expect((await admin("/admin-api/members/nobody/name", { name: "X" })).status).toBe(404);
  });

  it("an admin of B can't rename A's member", async () => {
    const adminB = await dash("pat", "b");
    expect((await adminB("/admin-api/members/otto/name", { name: "X" })).status).toBe(404);
    expect(await memberName(env.DB, "otto", "default")).toBe("otto");
  });
});

describe("agent keys", () => {
  it("reach none of the routes", async () => {
    const h = { Authorization: "Bearer bongsu_notarealkey0123456789abcdef" };
    for (const [routes, path] of [
      ["app", "/app-api/me/name"],
      ["app", "/app-api/me/display-name"],
      ["admin", "/admin-api/members/otto/name"],
    ] as const) {
      const r = await send(routes, path, h, { name: "X" });
      expect([401, 403], path).toContain(r.status);
    }
    expect(await memberName(env.DB, "otto", "default")).toBe("otto");
  });
});
