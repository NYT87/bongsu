// The security review's findings, each kept closed: approvals bind the account and the comments' texts, the plan is
// asked again before a container is published, dry run stops a job under way, a Shorts comment waits for the owner's
// approval, workspaces don't see each other's comments or posted records, and roles gate what a member can change.
import { env } from "cloudflare:workers";
import { planAdd, planRemove, planUpdate, recordManualPost, shortsAdd } from "@bongsu/api/agent/ops";
import { adminRoutes } from "@bongsu/api/dashboard/routes";
import { appRoutes } from "@bongsu/api/pwa/routes";
import { createSession } from "@bongsu/api/pwa/session";
import type { Verifiers } from "@bongsu/api/pwa/webauthn";
import { pollComments } from "@bongsu/core/comments";
import { saveGrant } from "@bongsu/core/connections";
import { addApproval } from "@bongsu/core/data";
import type { Env } from "@bongsu/core/env";
import { sha256Hex } from "@bongsu/core/formats/approved";
import { tick } from "@bongsu/core/tick";
import { beforeEach, describe, expect, it } from "vitest";
import { clearPlan, igHappyPath, seedReel, testEnv, World } from "./world";

const AT = new Date("2026-10-20T09:32:00Z"); // 18:32 in Seoul: short1_x is due
const later = (min: number) => new Date(AT.getTime() + min * 60_000);
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
const opctx = (workspaceId = "default") => ({
  env: e,
  fetch: w.fetch,
  now: AT,
  caller: { id: "agent", name: "agent", workspaceId, scopes: ["plan" as const] },
});
const job = (key: string) =>
  env.DB.prepare("SELECT state, last_error FROM jobs WHERE item_key = ?1")
    .bind(key)
    .first<{ state: string; last_error: string | null }>();
const published = () => w.calls.filter((c) => c.slug === "INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH");
const comments = () => w.calls.filter((c) => c.slug === "INSTAGRAM_POST_IG_MEDIA_COMMENTS").map((c) => c.args.message);

beforeEach(async () => {
  await clearPlan();
  await env.DB.batch(
    ["jobs", "locks", "audit", "comments", "comment_polls", "sessions", "trial_posts", "shorts_commented"].map((t) =>
      env.DB.prepare(`DELETE FROM ${t}`),
    ),
  );
  w = new World();
  e = await testEnv(env);
  igHappyPath(w);
  // the tests move accounts between workspaces: back to the default one
  await env.DB.prepare("UPDATE accounts SET workspace_id = 'default'").run();
  await env.DB.prepare("UPDATE connections SET workspace_id = 'default'").run();
  // a second workspace with its own member
  await env.DB.prepare(
    "INSERT INTO workspaces (id, name, created_at) VALUES ('b', 'Workspace B', 0) ON CONFLICT (id) DO NOTHING",
  ).run();
  await env.DB.prepare(
    "INSERT INTO users (id, name, created_at) VALUES ('bea', 'Bea', 0) ON CONFLICT (id) DO NOTHING",
  ).run();
  await env.DB.prepare(
    "INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES ('b', 'bea', 'admin', 0) ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = 'admin'",
  ).run();
  await env.DB.prepare("UPDATE memberships SET role = 'admin' WHERE user_id = 'owner'").run();
});

describe("what an approval allows", () => {
  it("is only good for the account it was given for", async () => {
    const { key, folder, base } = await seedReel(w);
    await planRemove(opctx(), key);
    await planAdd(opctx(), {
      kind: "reel",
      account: "demo_running",
      folder,
      name: base,
      date: "2026-10-20",
      time: "18:00",
      caption: "A caption\n\nWhere next?\n\n#travel",
      comment: "📍 Somewhere. Have you been?",
    });
    await tick(e, { fetch: w.fetch, now: AT });
    await tick(e, { fetch: w.fetch, now: later(5) });
    expect(published()).toEqual([]);
    expect(await job(key)).toMatchObject({
      state: "refused",
      last_error: expect.stringContaining("approved for demo_travel"),
    });
  });

  it("posts the comments exactly as approved, even when they change after the post went live", async () => {
    const { key } = await seedReel(w, { comment2: "Approved second comment" });
    await tick(e, { fetch: w.fetch, now: AT });
    await tick(e, { fetch: w.fetch, now: later(5) }); // published; the comments follow on the next run
    await planUpdate(opctx(), { key, comment: "Unapproved comment", comment2: "Unapproved second comment" });
    await tick(e, { fetch: w.fetch, now: later(10) });
    expect(comments()).toEqual([]);
    expect(await job(key)).toMatchObject({
      state: "done",
      last_error: expect.stringMatching(/self-comment changed after approval.*second comment changed after approval/),
    });
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM posted").first<{ n: number }>())?.n).toBe(1);
  });

  it.each(["hold", "reschedule", "remove", "disable"])(
    "asks the plan again before publishing a container: %s",
    async (action) => {
      const { key } = await seedReel(w);
      await tick(e, { fetch: w.fetch, now: AT });
      expect(await job(key)).toMatchObject({ state: "container_created" });
      if (action === "hold") await planUpdate(opctx(), { key, hold: true });
      if (action === "reschedule") await planUpdate(opctx(), { key, date: "2026-11-01" });
      if (action === "remove") await env.DB.prepare("DELETE FROM plan_items WHERE item_key = ?1").bind(key).run();
      if (action === "disable")
        await env.DB.prepare("UPDATE accounts SET status = 'disabled' WHERE id = 'demo_travel'").run();
      await tick(e, { fetch: w.fetch, now: later(5) });
      expect(published()).toEqual([]);
      const j = await job(key);
      if (action === "hold") expect(j).toMatchObject({ state: "held", last_error: expect.stringContaining("on hold") });
      else expect(j).toMatchObject({ state: "refused" });
      if (action === "reschedule") expect(j?.last_error).toContain("rescheduled");
      if (action === "remove") expect(j?.last_error).toContain("removed");
      if (action === "disable") expect(j?.last_error).toContain("disabled");
    },
  );

  it("holds a job whose item is on hold without taking a slot, and goes on once released", async () => {
    // four held containers, then a fifth Reel due later: with JOBS_PER_TICK slots it must still advance
    for (let i = 0; i < 4; i++) await seedReel(w, { base: `short${i}_held` });
    await tick(e, { fetch: w.fetch, now: AT });
    await planUpdate(opctx(), { key: "reel:20260823_LISBON/short0_held", hold: true });
    await env.DB.prepare("UPDATE plan_items SET hold = 1").run();
    const next = await seedReel(w, { base: "short5_next", time: "18:30" });
    await tick(e, { fetch: w.fetch, now: later(5) });
    expect(
      (await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs WHERE state = 'held'").first<{ n: number }>())?.n,
    ).toBe(4);
    await tick(e, { fetch: w.fetch, now: later(10) });
    expect(await job(next.key)).toMatchObject({ state: "container_created" });
    expect(published()).toEqual([]);
    // released: the held job comes back with a fresh container and goes out
    await env.DB.prepare("UPDATE plan_items SET hold = 0 WHERE item_key = ?1")
      .bind("reel:20260823_LISBON/short0_held")
      .run();
    await tick(e, { fetch: w.fetch, now: later(15) });
    expect(await job("reel:20260823_LISBON/short0_held")).toMatchObject({ state: "container_created" });
    await tick(e, { fetch: w.fetch, now: later(20) });
    expect(published().length).toBeGreaterThanOrEqual(1);
    expect(
      (await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs WHERE state = 'held'").first<{ n: number }>())?.n,
    ).toBe(3);
  });

  it("advances JOBS_PER_TICK jobs a tick when it is set, the oldest due first", async () => {
    const a = await seedReel(w, { base: "short1_first", time: "18:00" });
    const b = await seedReel(w, { base: "short2_second", time: "18:10" });
    const c = await seedReel(w, { base: "short3_third", time: "18:20" });
    await tick({ ...e, JOBS_PER_TICK: "1" }, { fetch: w.fetch, now: AT });
    expect((await job(a.key))?.state).toBe("container_created");
    for (const k of [b.key, c.key]) expect((await job(k))?.state).toBe("pending");
    // the first one takes a slot again (its container is checked, then published): with two, only the second starts
    await tick({ ...e, JOBS_PER_TICK: "2" }, { fetch: w.fetch, now: later(5) });
    expect((await job(a.key))?.state).not.toBe("container_created");
    expect((await job(b.key))?.state).not.toBe("pending");
    expect((await job(c.key))?.state).toBe("pending");
  });

  it("publishes nothing once dry run is switched on, even with a container waiting", async () => {
    const { key } = await seedReel(w);
    await tick(e, { fetch: w.fetch, now: AT });
    await tick({ ...e, DRY_RUN: "1" }, { fetch: w.fetch, now: later(5) });
    expect(published()).toEqual([]);
    expect(await job(key)).toMatchObject({ state: "done", last_error: expect.stringContaining("dry run") });
  });

  it("keeps a failed job failed whatever an agent does to its item: only a new approval reopens it", async () => {
    const { key } = await seedReel(w);
    w.composio.INSTAGRAM_POST_IG_USER_MEDIA = () => {
      throw new Error("Instagram busy");
    };
    for (const m of [0, 5, 10]) await tick(e, { fetch: w.fetch, now: later(m) });
    expect(await job(key)).toMatchObject({ state: "failed" });
    igHappyPath(w);
    w.calls.length = 0;
    await planUpdate(opctx(), { key, hold: true });
    await tick(e, { fetch: w.fetch, now: later(15) });
    await planUpdate(opctx(), { key, hold: false, caption: "An agent's new caption" });
    await tick(e, { fetch: w.fetch, now: later(20) });
    await planUpdate(opctx(), { key, date: "2026-10-20", time: "18:30" });
    await tick(e, { fetch: w.fetch, now: later(25) });
    expect(await job(key)).toMatchObject({ state: "failed" });
    expect(w.calls.filter((c) => c.slug === "INSTAGRAM_POST_IG_USER_MEDIA")).toEqual([]);
  });
});

describe("Shorts comments need the owner's approval", () => {
  const approveShort = (video: string, text: string, account = "main") =>
    sha256Hex(text).then((sha) =>
      addApproval(env.DB, {
        key: `comment:${video}`,
        account,
        dueAt: 0,
        captionSha256: sha,
        commentSha256: null,
        altSha256: null,
        media: [],
        approvedAt: "2026-10-20T00:00:00Z",
        approvedBy: "owner@app",
      }),
    );

  it("posts an agent's text only once the owner approved exactly it, for that channel", async () => {
    w.ytPrivacy.set("vidPUBLIC01", "public");
    const r = await shortsAdd(opctx(), { video_id: "vidPUBLIC01", channel: "main", text: "Agent text" });
    expect(r.note).toMatch(/approve/);
    await tick(e, { fetch: w.fetch, now: AT }, "shorts");
    expect(w.ytComments).toEqual([]);
    expect(await job("comment:vidPUBLIC01")).toMatchObject({
      state: "refused",
      last_error: expect.stringContaining("not approved"),
    });

    await approveShort("vidPUBLIC01", "Another text");
    await tick(e, { fetch: w.fetch, now: later(5) }, "shorts");
    expect(w.ytComments).toEqual([]);

    await approveShort("vidPUBLIC01", "Agent text", "vlogs");
    await tick(e, { fetch: w.fetch, now: later(10) }, "shorts");
    expect(w.ytComments).toEqual([]);

    await approveShort("vidPUBLIC01", "Agent text");
    await tick(e, { fetch: w.fetch, now: later(15) }, "shorts");
    expect(w.ytComments).toEqual([{ video: "vidPUBLIC01", text: "Agent text" }]);
    expect(await job("comment:vidPUBLIC01")).toMatchObject({ state: "done" });
    await tick(e, { fetch: w.fetch, now: later(20) }, "shorts");
    expect(w.ytComments).toHaveLength(1);
  });

  it("is approved from the app like a post, with a passkey, and refuses a changed text", async () => {
    await shortsAdd(opctx(), { video_id: "vidPUBLIC01", channel: "main", text: "Agent text", label: "s1" });
    const app = appRoutes(w.fetch, fake);
    await env.DB.prepare(
      "INSERT INTO passkeys (id, public_key, counter, transports, name, created_at, user_id) VALUES ('cred1', 'AQID', 0, NULL, 'phone', 0, 'owner') ON CONFLICT (id) DO NOTHING",
    ).run();
    const headers = {
      Cookie: `bongsu_session=${await createSession(env.DB, nowS(), { userId: "owner" })}`,
      "Content-Type": "application/json",
    };
    const post = (path: string, body: unknown) =>
      app.request(`https://bongsu.test${path}`, { method: "POST", headers, body: JSON.stringify(body) }, e);
    const item = (await (
      await app.request("https://bongsu.test/app-api/item?key=comment:vidPUBLIC01", { headers }, e)
    ).json()) as Record<string, unknown>;
    expect(item).toMatchObject({
      key: "comment:vidPUBLIC01",
      account: "main",
      caption: "Agent text",
      label: "Shorts comment",
      approved: null,
      problems: [],
    });
    const o = (await (await post("/app-api/approve/options", { key: "comment:vidPUBLIC01" })).json()) as {
      challengeId: string;
    };
    await env.DB.prepare("UPDATE shorts_comments SET text = 'Edited meanwhile' WHERE video_id = 'vidPUBLIC01'").run();
    expect(
      (await post("/app-api/approve/verify", { challengeId: o.challengeId, response: { id: "cred1" } })).status,
    ).toBe(409);
    const o2 = (await (await post("/app-api/approve/options", { key: "comment:vidPUBLIC01" })).json()) as {
      challengeId: string;
    };
    expect(
      await (await post("/app-api/approve/verify", { challengeId: o2.challengeId, response: { id: "cred1" } })).json(),
    ).toMatchObject({ approved: true });
    const a = await env.DB.prepare(
      "SELECT account, caption_sha, due_at FROM approvals WHERE item_key = 'comment:vidPUBLIC01'",
    ).first();
    expect(a).toEqual({ account: "main", caption_sha: await sha256Hex("Edited meanwhile"), due_at: 0 });
    w.ytPrivacy.set("vidPUBLIC01", "public");
    await tick(e, { fetch: w.fetch, now: AT }, "shorts");
    expect(w.ytComments).toEqual([{ video: "vidPUBLIC01", text: "Edited meanwhile" }]);
  });
});

describe("a passkey confirms only its own user's action", () => {
  // Two members' passkeys on one device: the owner is signed in, and Bea's passkey must not stand in for theirs.
  const setup = async () => {
    await env.DB.batch(
      [
        "DELETE FROM passkeys",
        "DELETE FROM challenges",
        "INSERT INTO passkeys (id, public_key, counter, transports, name, created_at, user_id) VALUES ('cred-owner', 'AQID', 0, NULL, 'phone', 0, 'owner')",
        "INSERT INTO passkeys (id, public_key, counter, transports, name, created_at, user_id) VALUES ('cred-bea', 'AQID', 0, NULL, 'phone', 0, 'bea')",
      ].map((sql) => env.DB.prepare(sql)),
    );
    const app = appRoutes(w.fetch, fake);
    const headers = {
      Cookie: `bongsu_session=${await createSession(env.DB, nowS(), { userId: "owner" })}`,
      "Content-Type": "application/json",
    };
    return async (path: string, body?: unknown) => {
      const r = await app.request(
        `https://bongsu.test${path}`,
        body === undefined ? { headers } : { method: "POST", headers, body: JSON.stringify(body) },
        e,
      );
      return { status: r.status, json: (await r.json()) as Record<string, unknown> };
    };
  };
  const offered = (o: Record<string, unknown>) =>
    ((o.options as { allowCredentials?: { id: string }[] }).allowCredentials ?? []).map((c) => c.id);

  it("refuses another member's passkey for an approval", async () => {
    await shortsAdd(opctx(), { video_id: "vidPUBLIC01", channel: "main", text: "Agent text", label: "s1" });
    const call = await setup();
    const o = await call("/app-api/approve/options", { key: "comment:vidPUBLIC01" });
    expect(offered(o.json)).toEqual(["cred-owner"]);
    const r = await call("/app-api/approve/verify", { challengeId: o.json.challengeId, response: { id: "cred-bea" } });
    expect(r.status).toBe(401);
    expect(await env.DB.prepare("SELECT * FROM approvals WHERE item_key = 'comment:vidPUBLIC01'").first()).toBeNull();
    expect(await env.DB.prepare("SELECT last_used_at FROM passkeys WHERE id = 'cred-bea'").first()).toEqual({
      last_used_at: null,
    });
    // the challenge is used up; a new one with the owner's own passkey approves
    const again = await call("/app-api/approve/verify", {
      challengeId: o.json.challengeId,
      response: { id: "cred-owner" },
    });
    expect(again.status).toBe(401);
    const o2 = await call("/app-api/approve/options", { key: "comment:vidPUBLIC01" });
    const ok = await call("/app-api/approve/verify", {
      challengeId: o2.json.challengeId,
      response: { id: "cred-owner" },
    });
    expect(ok.json).toMatchObject({ approved: true });
  });

  it("refuses another member's passkey for resuming", async () => {
    const call = await setup();
    await call("/app-api/pause", { reason: "x" });
    const o = await call("/app-api/resume/options", {});
    expect(offered(o.json)).toEqual(["cred-owner"]);
    const r = await call("/app-api/resume/verify", { challengeId: o.json.challengeId, response: { id: "cred-bea" } });
    expect(r.status).toBe(401);
    expect((await call("/app-api/status")).json.paused).toBe(true);
    const o2 = await call("/app-api/resume/options", {});
    const ok = await call("/app-api/resume/verify", {
      challengeId: o2.json.challengeId,
      response: { id: "cred-owner" },
    });
    expect(ok.json).toMatchObject({ paused: false, wasPaused: true });
  });
});

describe("workspaces stay apart", () => {
  it("keeps another workspace's comments out of the inbox, the count, 'seen' and replies", async () => {
    await env.DB.prepare(
      "INSERT INTO comments (id, platform, account, media_id, author, text, at, own, seen, workspace_id) VALUES ('ig:private', 'ig', 'demo_travel', 'm', 'viewer', 'private comment', 1, 0, 0, 'default')",
    ).run();
    const app = appRoutes(w.fetch, fake);
    const headers = {
      Cookie: `bongsu_session=${await createSession(env.DB, nowS(), { userId: "bea" })}`,
      "Content-Type": "application/json",
    };
    const get = (p: string) => app.request(`https://bongsu.test${p}`, { headers }, e);
    expect(await (await get("/app-api/comments")).json()).toEqual({ comments: [] });
    expect(await (await get("/app-api/comments/unseen")).json()).toEqual({ n: 0 });
    await app.request("https://bongsu.test/app-api/comments/seen", { method: "POST", headers }, e);
    expect(await env.DB.prepare("SELECT seen FROM comments WHERE id = 'ig:private'").first()).toEqual({ seen: 0 });
    const r = await app.request(
      "https://bongsu.test/app-api/comments/ig:private/reply",
      { method: "POST", headers, body: JSON.stringify({ text: "hi" }) },
      e,
    );
    expect(r.status).toBe(502);
    expect(w.calls.filter((c) => c.slug.includes("REPLY") || c.slug.includes("COMMENT"))).toEqual([]);
  });

  it("files polled comments under their account's workspace", async () => {
    await env.DB.prepare("UPDATE accounts SET workspace_id = 'b' WHERE id = 'demo_running'").run();
    await env.DB.prepare(
      "INSERT INTO posted (item_key, account, media_id, source, published_at, workspace_id, at) VALUES ('reel:x/y', 'demo_running', 'media-9', 'manual', ?1, 'b', ?1)",
    )
      .bind(nowS())
      .run();
    w.composio.INSTAGRAM_GET_IG_MEDIA_COMMENTS = () => ({
      data: [{ id: "c9", text: "nice", username: "fan", timestamp: "2026-10-20T09:00:00+0000" }],
    });
    await pollComments(e, { fetch: w.fetch, now: new Date() });
    expect(await env.DB.prepare("SELECT workspace_id FROM comment_polls WHERE media_id = 'media-9'").first()).toEqual({
      workspace_id: "b",
    });
    const rows = (await env.DB.prepare("SELECT id, workspace_id FROM comments").all()).results;
    expect(rows).toEqual([{ id: "ig:c9", workspace_id: "b" }]);
  });

  it("records a Trial Reel copy, and polls its comments, under its workspace", async () => {
    const { key } = await seedReel(w);
    for (const sql of [
      "UPDATE accounts SET workspace_id = 'b' WHERE id = 'demo_travel'",
      "UPDATE connections SET workspace_id = 'b' WHERE id = (SELECT connection_id FROM accounts WHERE id = 'demo_travel')",
      `UPDATE plan_items SET workspace_id = 'b' WHERE item_key = '${key}'`,
    ])
      await env.DB.prepare(sql).run();
    await tick(e, { fetch: w.fetch, now: AT });
    const row = await env.DB.prepare("SELECT payload FROM jobs WHERE item_key = ?1")
      .bind(key)
      .first<{ payload: string }>();
    const payload = {
      ...JSON.parse(row!.payload),
      trial: true,
      mediaId: "trial-m",
      publishedAt: Math.floor(later(5).getTime() / 1000),
    };
    await env.DB.prepare("UPDATE jobs SET item_key = ?1, state = 'published', payload = ?2 WHERE item_key = ?3")
      .bind(`trial:${key}`, JSON.stringify(payload), key)
      .run();
    await tick(e, { fetch: w.fetch, now: later(5) });
    expect(await env.DB.prepare("SELECT workspace_id FROM trial_posts WHERE item_key = ?1").bind(key).first()).toEqual({
      workspace_id: "b",
    });
    w.composio.INSTAGRAM_GET_IG_MEDIA_COMMENTS = () => ({
      data: [{ id: "trial-c", text: "Demo comment", username: "demo_viewer", timestamp: "2026-10-20T09:40:00+0000" }],
    });
    await pollComments(e, { fetch: w.fetch, now: later(10) });
    expect(await env.DB.prepare("SELECT workspace_id FROM comments WHERE id = 'ig:trial-c'").first()).toEqual({
      workspace_id: "b",
    });
  });

  it("refuses to record a manual post for another workspace's item", async () => {
    const { key } = await seedReel(w);
    await env.DB.prepare("UPDATE accounts SET workspace_id = 'b' WHERE id = 'demo_running'").run();
    await expect(recordManualPost(opctx("b"), { key, account: "demo_running" })).rejects.toThrow(/isn't planned/);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM posted").first<{ n: number }>())?.n).toBe(0);
    await tick(e, { fetch: w.fetch, now: AT });
    expect(await job(key)).toMatchObject({ state: "container_created" });
  });

  it("gives an account connected in a second workspace its own id", async () => {
    const r = await saveGrant(
      e,
      "instagram",
      {
        label: "@demo_travel",
        credentials: null,
        accounts: [{ platform: "instagram", handle: "demo_travel", externalId: "17841400000000001" }],
      },
      1,
      null,
      "b",
    );
    expect(r.accounts[0]).toMatchObject({ created: true, handle: "demo_travel" });
    expect(r.accounts[0].id).not.toBe("demo_travel");
    const row = await env.DB.prepare("SELECT workspace_id FROM accounts WHERE id = ?1").bind(r.accounts[0].id).first();
    expect(row).toEqual({ workspace_id: "b" });
    await env.DB.prepare("DELETE FROM accounts WHERE id = ?1").bind(r.accounts[0].id).run();
    await env.DB.prepare("DELETE FROM connections WHERE id = ?1").bind(r.connectionId).run();
  });
});

describe("roles", () => {
  const admin = async (role: string) => {
    await env.DB.prepare("UPDATE memberships SET role = ?1 WHERE user_id = 'bea'").bind(role).run();
    const cookie = `bongsu_admin=${await createSession(env.DB, nowS(), { app: "dashboard", userId: "bea" })}`;
    return (path: string, body?: unknown) =>
      adminRoutes(w.fetch, fake).request(
        `https://bongsu.test${path}`,
        {
          method: body === undefined ? "GET" : "POST",
          headers: { Cookie: cookie, "Content-Type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
        e,
      );
  };
  const pwa = async (role: string) => {
    await env.DB.prepare("UPDATE memberships SET role = ?1 WHERE user_id = 'bea'").bind(role).run();
    const cookie = `bongsu_session=${await createSession(env.DB, nowS(), { userId: "bea" })}`;
    return (path: string, body?: unknown) =>
      appRoutes(w.fetch, fake).request(
        `https://bongsu.test${path}`,
        {
          method: body === undefined ? "GET" : "POST",
          headers: { Cookie: cookie, "Content-Type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
        e,
      );
  };

  it("lets only an admin manage the workspace, and only an instance admin the instance, in the dashboard", async () => {
    for (const role of ["editor", "creator"]) {
      const call = await admin(role);
      expect((await call("/admin-api/keys", { name: "k", scopes: ["plan", "pause"] })).status, role).toBe(403);
      expect((await call("/admin-api/settings", { timezone: "Europe/Madrid" })).status, role).toBe(403);
      expect((await call("/admin-api/settings/ntfy", { url: "https://ntfy.sh/x" })).status, role).toBe(403);
      expect((await call("/admin-api/settings/ntfy/test", {})).status, role).toBe(403);
    }
    // reading is an editor's too; a creator is pointed at the app
    expect((await (await admin("editor"))("/admin-api/keys")).status).toBe(200);
    const creator = await (await admin("creator"))("/admin-api/keys");
    expect([creator.status, await creator.json()]).toEqual([403, { error: "creators use the Bongsu app", app: true }]);
    // the instance's media stores: not even a workspace admin's, reading included
    for (const role of ["editor", "creator", "admin"]) {
      const call = await admin(role);
      expect((await call("/admin-api/media-stores/s3", { bucket: "x" })).status, role).toBe(403);
      expect((await call("/admin-api/media-stores/drive/remove", {})).status, role).toBe(403);
      expect((await call("/admin-api/media-stores/s3/default", {})).status, role).toBe(403);
      expect((await call("/admin-api/media-stores/drive/start", {})).status, role).toBe(403);
      expect((await call("/admin-api/media-stores")).status, role).toBe(403);
    }
    const call = await admin("admin");
    expect((await call("/admin-api/keys", { name: "k", scopes: ["plan"] })).status).toBe(200);
    expect(
      (await env.DB.prepare("SELECT COUNT(*) AS n FROM api_keys WHERE workspace_id = 'b'").first<{ n: number }>())?.n,
    ).toBe(1);
  });

  it("lets only a role with the right approve, resume or pause in the app; every role edits", async () => {
    // an editor edits but never approves: approval stays human, and not every human
    const editor = await pwa("editor");
    expect((await editor("/app-api/status")).status).toBe(200);
    expect((await editor("/app-api/approve/options", { key: "reel:x/y" })).status).toBe(403);
    expect((await editor("/app-api/approve/verify", {})).status).toBe(403);
    expect((await editor("/app-api/resume/options", {})).status).toBe(403);
    expect((await editor("/app-api/pause", { reason: "x" })).status).toBe(403);
    expect((await editor("/app-api/item/hold", { key: "reel:x/y", hold: true })).status).toBe(404); // allowed; no such item
    expect((await editor("/app-api/comments/seen", {})).status).toBe(200);
    for (const role of ["creator", "admin"]) {
      const call = await pwa(role);
      expect((await call("/app-api/approve/options", { key: "reel:x/y" })).status, role).toBe(404); // allowed; no item
      expect((await call("/app-api/resume/options", {})).status, role).toBe(200);
      expect((await call("/app-api/item/hold", { key: "reel:x/y", hold: true })).status, role).toBe(404);
    }
  });
});
