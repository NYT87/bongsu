import { env, exports } from "cloudflare:workers";
import { adminRoutes, FRESH_S } from "@bongsu/api/dashboard/routes";
import { appRoutes } from "@bongsu/api/pwa/routes";
import type { Verifiers } from "@bongsu/api/pwa/webauthn";
import { calendar } from "@bongsu/core/calendar";
import { ReleaseError, YouTube } from "@bongsu/core/clients/youtube";
import type { Env } from "@bongsu/core/env";
import { sha256Hex } from "@bongsu/core/formats/approved";
import { zoneToUnix } from "@bongsu/core/formats/time";
import { moveRelease, releaseStatus } from "@bongsu/core/release";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearPlan, joinDefault, testEnv, UNBOOTSTRAP, World } from "./world";

let w: World;
let yt: YouTube;

beforeEach(async () => {
  await clearPlan();
  w = new World();
  await testEnv(env);
  w.ytUploads = [
    {
      id: "v-sched",
      title: "Lisbon Short",
      privacy: "private",
      publishedAt: "2026-10-01T10:00:00Z",
      publishAt: "2099-11-05T09:00:00Z",
      duration: "PT45S",
    },
    { id: "v-pub", title: "Old Video", privacy: "public", publishedAt: "2026-10-01T10:00:00Z", duration: "PT5M" },
    { id: "v-draft", title: "Draft", privacy: "private", publishedAt: "2026-10-02T10:00:00Z", duration: "PT5M" },
    {
      id: "v-unlisted",
      title: "Link Only",
      privacy: "unlisted",
      publishedAt: "2026-10-03T10:00:00Z",
      duration: "PT5M",
    },
  ];
  yt = new YouTube(
    JSON.stringify({
      client_id: "c",
      client_secret: "s",
      refresh_token: "r",
      token_uri: "https://oauth2.googleapis.com/token",
    }),
    (i, r) => w.fetch(i, r),
  );
});

describe("YouTube.setReleaseDate", () => {
  it("moves a scheduled video's publishAt and sends the rest of its status back unchanged", async () => {
    expect(await yt.setReleaseDate("v-sched", "2099-11-06T10:00:00Z")).toEqual({ from: "2099-11-05T09:00:00Z" });
    expect(w.ytUpdates[0].status).toEqual({
      privacyStatus: "private",
      publishAt: "2099-11-06T10:00:00Z",
      license: "youtube",
      embeddable: true,
      publicStatsViewable: true,
      madeForKids: false,
    });
    expect(w.ytUploads[0].publishAt).toBe("2099-11-06T10:00:00Z");
  });

  it("refuses a public video, an unknown one and a past time without calling videos.update", async () => {
    await expect(yt.setReleaseDate("v-pub", "2099-11-06T10:00:00Z")).rejects.toMatchObject({ reason: "not_scheduled" });
    await expect(yt.setReleaseDate("v-none", "2099-11-06T10:00:00Z")).rejects.toMatchObject({ reason: "missing" });
    await expect(yt.setReleaseDate("v-sched", "2020-01-01T00:00:00Z")).rejects.toMatchObject({ reason: "past" });
    expect(w.ytUpdates).toEqual([]);
  });
});

describe("moveRelease", () => {
  const nowS = Date.parse("2099-11-01T00:00:00Z") / 1000;
  const owner = { kind: "owner", userId: "owner" } as const;
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM audit WHERE action = 'release_move'").run();
  });
  const req = (over: object = {}) => ({
    workspaceId: "default",
    videoId: "v-sched",
    at: zoneToUnix("2099-11-06", "19:00", "Asia/Seoul") as number,
    nowS,
    tz: "Asia/Seoul",
    actor: owner,
    ...over,
  });

  it("moves the video, patches the calendar cache, audits and notifies", async () => {
    const e = await testEnv(env, { NOTIFY_URL: "https://ntfy.test/t" });
    const f = (i: RequestInfo | URL, r?: RequestInit) => w.fetch(i, r);
    expect(await moveRelease(e, f, req())).toEqual({
      video: "v-sched",
      title: "Lisbon Short",
      account: "main",
      due: "2099-11-06 19:00 Asia/Seoul",
      due_at: "2099-11-06T10:00:00Z",
      from: "2099-11-05 18:00 Asia/Seoul",
      from_at: "2099-11-05T09:00:00Z",
    });
    w.ytUploads = [];
    const cal = await calendar(e, f, { id: "default", tz: "Asia/Seoul" }, "2099-11-01", "2099-11-30");
    const ev = cal.events.find((x) => x.url === "https://youtu.be/v-sched");
    expect(ev).toMatchObject({ date: "2099-11-06", time: "19:00" });
    const row = await env.DB.prepare("SELECT * FROM audit WHERE action = 'release_move'").first<{
      actor: string;
      target: string;
      detail: string;
    }>();
    expect(row).toMatchObject({ actor: "user:owner", target: "youtube:v-sched" });
    expect(JSON.parse(row?.detail ?? "")).toEqual({
      account: "main",
      title: "Lisbon Short",
      from: "2099-11-05T09:00:00Z",
      to: "2099-11-06T10:00:00Z",
    });
    expect(w.notifications[0].title).toBe("Release moved: Lisbon Short");
    expect(w.notifications[0].body).toMatch(/by you$/);
  });

  it("a key needs an hour of lead; the owner doesn't", async () => {
    const e = await testEnv(env, { NOTIFY_URL: "https://ntfy.test/t" });
    const f = (i: RequestInfo | URL, r?: RequestInit) => w.fetch(i, r);
    const key = { kind: "key", id: "k1", name: "planner" } as const;
    await expect(moveRelease(e, f, req({ at: nowS + 1800, actor: key }))).rejects.toMatchObject({ reason: "lead" });
    expect(w.ytUpdates).toEqual([]);
    expect(
      (await env.DB.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'release_move'").first<{ n: number }>())?.n,
    ).toBe(0);
    await expect(moveRelease(e, f, req({ at: nowS + 1800 }))).resolves.toMatchObject({ video: "v-sched" });
  });

  it("another workspace's video is not found", async () => {
    const e = await testEnv(env);
    const f = (i: RequestInfo | URL, r?: RequestInit) => w.fetch(i, r);
    await expect(moveRelease(e, f, req({ workspaceId: "b" }))).rejects.toMatchObject({ reason: "missing" });
  });

  it("releaseStatus", () => {
    const st = (r: ReleaseError["reason"]) => releaseStatus(new ReleaseError(r, "x"));
    expect([st("missing"), st("lead"), st("past"), st("not_scheduled")]).toEqual([404, 400, 409, 409]);
  });
});

describe("the agent API", () => {
  const KEY_READ = "bongsu_releaseReadreleaseReadreleas";
  const KEY_MOVE = "bongsu_releaseMovereleaseMovereleas";
  const origFetch = globalThis.fetch;
  beforeEach(async () => {
    globalThis.fetch = w.fetch;
    // the worker's own env has placeholder channel credentials: give it the fake world's
    const e = (await testEnv(env)) as unknown as Record<string, string>;
    Object.assign(env, { YT_MAIN_OAUTH: e.YT_MAIN_OAUTH, YT_VLOGS_OAUTH: e.YT_VLOGS_OAUTH });
    await env.DB.prepare("DELETE FROM api_keys").run();
    for (const [id, key, scopes] of [
      ["kr", KEY_READ, '["read"]'],
      ["km", KEY_MOVE, '["read","reschedule"]'],
    ]) {
      await env.DB.prepare(
        "INSERT INTO api_keys (id, name, key_hash, scopes, workspace_id) VALUES (?1, ?1, ?2, ?3, 'default')",
      )
        .bind(id, await sha256Hex(key), scopes)
        .run();
    }
    // the routes use the real clock: the scheduled video's release is a week ahead of it
    w.ytUploads[0].publishAt = new Date(Date.now() + 7 * 86400e3).toISOString();
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
  });
  const call = async (key: string, path: string, body: unknown) => {
    const r = await exports.default.fetch(`https://scheduler.test${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: r.status, json: (await r.json()) as Record<string, unknown> };
  };
  const day = (n: number) => new Date(Date.now() + n * 86400e3).toISOString().replace(/\.\d+Z$/, "Z");

  it("needs the reschedule scope", async () => {
    const r = await call(KEY_READ, "/v1/youtube/reschedule", { video: "v-sched", at: day(10) });
    expect([r.status, r.json.error]).toEqual([403, 'this key lacks the "reschedule" scope']);
    expect(w.ytUpdates).toEqual([]);
  });

  it("moves with at, or with date and time in the caller's zone", async () => {
    const r1 = await call(KEY_MOVE, "/v1/youtube/reschedule", { video: "v-sched", at: "2099-11-06T10:00:00Z" });
    expect(r1.status).toBe(200);
    expect(r1.json).toMatchObject({ due: "2099-11-06 19:00 Asia/Seoul", due_at: "2099-11-06T10:00:00Z" });
    const r2 = await call(KEY_MOVE, "/v1/youtube/reschedule", { video: "v-sched", date: "2099-11-07", time: "08:00" });
    expect(r2.status).toBe(200);
    expect(r2.json).toMatchObject({ due_at: "2099-11-06T23:00:00Z" });
  });

  it("refuses 30 minutes ahead (400), a public video (409), a past time (400: the lead check comes first), an unknown video (404) and no time (400)", async () => {
    const go = (b: object) => call(KEY_MOVE, "/v1/youtube/reschedule", b);
    const soon = new Date(Date.now() + 1800e3).toISOString();
    const out = [
      await go({ video: "v-sched", at: soon }),
      await go({ video: "v-pub", at: day(10) }),
      await go({ video: "v-sched", at: "2020-01-01T00:00:00Z" }),
      await go({ video: "v-none", at: day(10) }),
      await go({ video: "v-sched" }),
      await go({ at: day(10) }),
    ];
    expect(out.map((r) => r.status)).toEqual([400, 409, 400, 404, 400, 400]);
    expect(out[0].json.error).toBe("an agent must leave at least 1 hour: pick a later time");
    expect(out[4].json.error).toBe("give at, or date and time");
    expect(out[5].json.error).toBe("give the video id");
    expect(w.ytUpdates).toEqual([]);
  });

  it("the MCP tool lists youtube_reschedule", async () => {
    const r = await exports.default.fetch("https://scheduler.test/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY_MOVE}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const tools = ((await r.json()) as { result: { tools: { name: string; inputSchema: { required: string[] } }[] } })
      .result.tools;
    expect(tools.find((t) => t.name === "youtube_reschedule")?.inputSchema.required).toEqual(["video"]);
  });
});

describe("the PWA", () => {
  // Stand-in for a real authenticator, as in app.test.ts: the routes' own logic is what's tested.
  const fake: Verifiers = {
    registration: (async () => ({
      verified: true,
      registrationInfo: {
        credential: { id: "cred1", publicKey: new Uint8Array([1, 2, 3]), counter: 0, transports: ["internal"] },
      },
    })) as unknown as Verifiers["registration"],
    authentication: (async () => ({
      verified: true,
      authenticationInfo: { newCounter: 1 },
    })) as unknown as Verifiers["authentication"],
  };
  let cookie = "";
  const post = async (path: string, body: unknown = {}) => {
    const r = await appRoutes(w.fetch, fake).request(
      `https://bongsu.test${path}`,
      {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
      },
      env,
    );
    const set = r.headers.get("Set-Cookie");
    if (set) cookie = set.split(";")[0];
    return { status: r.status, json: (await r.json()) as Record<string, unknown> };
  };
  const verify = (challengeId: unknown) =>
    post("/app-api/youtube/release/verify", { challengeId, response: { id: "cred1" } });
  const when = { video: "v-sched", date: "2099-11-06", time: "19:00" };

  beforeEach(async () => {
    await env.DB.batch(
      ["passkeys", "sessions", "challenges", "setup_codes"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)),
    );
    await env.DB.prepare("DELETE FROM audit WHERE action = 'release_move'").run();
    Object.assign(env, { PUBLIC_URL: "https://bongsu.test", RP_ID: "bongsu.test" });
    // the routes use the real clock: the scheduled video's release is a week ahead of it
    const e = (await testEnv(env)) as unknown as Record<string, string>;
    Object.assign(env, { YT_MAIN_OAUTH: e.YT_MAIN_OAUTH, YT_VLOGS_OAUTH: e.YT_VLOGS_OAUTH });
    w.ytUploads[0].publishAt = new Date(Date.now() + 7 * 86400e3).toISOString();
    cookie = "";
    await env.DB.prepare("INSERT INTO setup_codes (code_hash, expires_at) VALUES (?1, ?2)")
      .bind(await sha256Hex("CODE-1234"), Math.floor(Date.now() / 1000) + 600)
      .run();
    const o = await post("/app-api/setup/options", { code: "CODE-1234" });
    await post("/app-api/setup/verify", { challengeId: o.json.challengeId, response: { id: "cred1" }, name: "phone" });
  });

  it("options bind the time; verify moves it", async () => {
    const o = await post("/app-api/youtube/release/options", when);
    expect(o.status).toBe(200);
    expect(o.json.challengeId).toEqual(expect.any(String));
    const r = await verify(o.json.challengeId);
    expect([r.status, r.json.due]).toEqual([200, "2099-11-06 19:00 Asia/Seoul"]);
    expect(w.ytUploads[0].publishAt).toBe("2099-11-06T10:00:00Z");
    const row = await env.DB.prepare("SELECT actor, user_id FROM audit WHERE action = 'release_move'").first<{
      actor: string;
      user_id: string | null;
    }>();
    const user = await env.DB.prepare("SELECT user_id FROM sessions").first<{ user_id: string }>();
    expect(row).toEqual({ actor: `user:${user?.user_id}`, user_id: user?.user_id });
    expect(row?.user_id).toBeTruthy();
  });

  it("a resume or approve challenge can't move a video", async () => {
    const o = await post("/app-api/resume/options");
    expect((await verify(o.json.challengeId)).status).toBe(401);
    expect(w.ytUpdates).toEqual([]);
  });

  it("an editor may move it too: release dates are the plan's, every role's (the reschedule scope)", async () => {
    const user = await env.DB.prepare("SELECT user_id FROM sessions").first<{ user_id: string }>();
    // not an instance admin meanwhile, whose rights are an admin's whatever the role
    await env.DB.prepare("UPDATE users SET instance_admin = 0 WHERE id = ?1").bind(user?.user_id).run();
    await env.DB.prepare("UPDATE memberships SET role = 'editor' WHERE user_id = ?1").bind(user?.user_id).run();
    try {
      expect((await post("/app-api/youtube/release/options", when)).status).toBe(200);
    } finally {
      await env.DB.prepare("UPDATE memberships SET role = 'admin' WHERE user_id = ?1").bind(user?.user_id).run();
      await env.DB.prepare("UPDATE users SET instance_admin = 1 WHERE id = ?1").bind(user?.user_id).run();
    }
    expect(w.ytUpdates).toEqual([]);
  });

  it("another member's passkey on the same device can't move it", async () => {
    await env.DB.prepare(
      "INSERT INTO passkeys (id, public_key, counter, transports, name, created_at, user_id) VALUES ('cred-bea', 'AQID', 0, NULL, 'phone', 0, 'bea')",
    ).run();
    const o = await post("/app-api/youtube/release/options", when);
    const ids = (o.json.options as { allowCredentials: { id: string }[] }).allowCredentials.map((c) => c.id);
    expect(ids).toEqual(["cred1"]);
    const r = await post("/app-api/youtube/release/verify", {
      challengeId: o.json.challengeId,
      response: { id: "cred-bea" },
    });
    expect(r.status).toBe(401);
    expect(w.ytUpdates).toEqual([]);
    expect((await verify((await post("/app-api/youtube/release/options", when)).json.challengeId)).status).toBe(200);
  });

  it("bad input", async () => {
    expect((await post("/app-api/youtube/release/options", { video: "v-sched" })).status).toBe(400);
    expect((await post("/app-api/youtube/release/options", { video: "v-sched", date: "nope" })).status).toBe(400);
    const o = await post("/app-api/youtube/release/options", { ...when, video: "v-pub" });
    expect((await verify(o.json.challengeId)).status).toBe(409);
    expect(w.ytUpdates).toEqual([]);
  });
});

describe("the dashboard", () => {
  // The same stand-in authenticator as dashboard.test.ts: the credential id is whatever the "browser" says.
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
  let me = "";
  const jar: Record<string, string> = {};
  const call = async (path: string, body?: unknown) => {
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
      const [k, v] = set.split(";")[0].split("=");
      jar[k] = v;
    }
    return { status: r.status, json: (await r.json()) as Record<string, unknown> };
  };

  beforeEach(async () => {
    for (const k of Object.keys(jar)) delete jar[k];
    await env.DB.batch(UNBOOTSTRAP.map((s) => env.DB.prepare(s)));
    e = await testEnv(env, {
      SETUP_TOKEN: "setup-token-123",
      PUBLIC_URL: "https://bongsu.test",
      RP_ID: "bongsu.test",
    } as Partial<Env>);
    const o = await call("/admin-api/bootstrap/options", {
      token: "setup-token-123",
      email: "owner@example.com",
      name: "Owner",
    });
    const b = await call("/admin-api/bootstrap/verify", {
      challengeId: o.json.challengeId,
      response: { id: "laptop-key" },
      device: "laptop",
    });
    expect(b.status).toBe(200);
    me = await joinDefault(); // the bootstrap makes an instance admin in no workspace
  });

  it("lists each channel's uploads in the user's zone", async () => {
    const r = await call("/admin-api/videos");
    expect(r.status).toBe(200);
    const channels = r.json.channels as { id: string; name: string; videos: Record<string, unknown>[] }[];
    expect(channels[0]).toMatchObject({ id: "main", name: "Main" });
    expect(channels[0].videos.find((v) => v.id === "v-sched")).toMatchObject({
      title: "Lisbon Short",
      status: "scheduled",
      when: "2099-11-05 18:00",
      when_at: "2099-11-05T09:00:00Z",
      short: true,
      url: "https://youtu.be/v-sched",
    });
    expect(channels[0].videos.find((v) => v.id === "v-pub")).toMatchObject({ status: "public", short: false });
    // only a private video with a release time is scheduled (and offered Change date)
    const state = (id: string) => channels[0].videos.find((v) => v.id === id)?.status;
    expect([state("v-draft"), state("v-unlisted"), state("v-sched")]).toEqual(["private", "unlisted", "scheduled"]);
    // newest first
    expect(channels[0].videos[0].id).toBe("v-sched");
    expect(r.json.warnings).toEqual([]);
  });

  it("doesn't take another user's passkey as the fresh check", async () => {
    await env.DB.prepare(
      "INSERT INTO passkeys (id, public_key, counter, transports, name, created_at, user_id) VALUES ('other-key', 'AQID', 0, NULL, 'phone', 0, 'bea')",
    ).run();
    await env.DB.prepare("UPDATE sessions SET verified_at = verified_at - ?1")
      .bind(FRESH_S + 5)
      .run();
    const o = await call("/admin-api/verify/options", {});
    const v = await call("/admin-api/verify/verify", {
      challengeId: o.json.challengeId,
      response: { id: "other-key" },
    });
    expect(v.status).toBe(401);
    const refused = await call("/admin-api/videos/v-sched/release", { date: "2099-11-06", time: "19:00" });
    expect([refused.status, refused.json.verify]).toEqual([403, true]);
    expect(w.ytUpdates).toEqual([]);
  });

  it("moves a release after a fresh passkey check, an editor's too", async () => {
    const move = { date: "2099-11-06", time: "19:00" };
    await env.DB.prepare("UPDATE sessions SET verified_at = verified_at - ?1")
      .bind(FRESH_S + 5)
      .run();
    const refused = await call("/admin-api/videos/v-sched/release", move);
    expect([refused.status, refused.json.verify]).toEqual([403, true]);
    expect(w.ytUpdates).toEqual([]);
    const o = await call("/admin-api/verify/options", {});
    await call("/admin-api/verify/verify", { challengeId: o.json.challengeId, response: { id: "laptop-key" } });
    const bad = await call("/admin-api/videos/v-sched/release", { date: "soon", time: "19:00" });
    expect(bad.status).toBe(400);
    const ok = await call("/admin-api/videos/v-sched/release", move);
    expect([ok.status, ok.json.due]).toEqual([200, "2099-11-06 19:00 Asia/Seoul"]);
    expect(w.ytUploads[0].publishAt).toBe("2099-11-06T10:00:00Z");
    expect((await call("/admin-api/videos/v-pub/release", move)).status).toBe(409);
    expect((await call("/admin-api/videos/v-none/release", move)).status).toBe(404);
    // an editor too (not an instance admin meanwhile, whose rights are an admin's whatever the role)
    await env.DB.prepare("UPDATE users SET instance_admin = 0 WHERE id = ?1").bind(me).run();
    await env.DB.prepare("UPDATE memberships SET role = 'editor' WHERE user_id = ?1").bind(me).run();
    try {
      expect((await call("/admin-api/videos/v-sched/release", { date: "2099-11-07", time: "19:00" })).status).toBe(200);
    } finally {
      await env.DB.prepare("UPDATE memberships SET role = 'admin' WHERE user_id = ?1").bind(me).run();
      await env.DB.prepare("UPDATE users SET instance_admin = 1 WHERE id = ?1").bind(me).run();
    }
  });
});
