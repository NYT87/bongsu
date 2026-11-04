// Each workspace's ntfy topic (core/ntfy.ts): set in the dashboard, stored encrypted, shown by host only; a
// notification goes to the topic of the workspace it's about, posted without following redirects.
import { env } from "cloudflare:workers";
import { adminRoutes } from "@bongsu/api/dashboard/routes";
import type { Verifiers } from "@bongsu/api/pwa/webauthn";
import type { Env } from "@bongsu/core/env";
import { notifier } from "@bongsu/core/notify";
import { checkNtfyUrl, setWorkspaceNtfy, workspaceNtfy } from "@bongsu/core/ntfy";
import { beforeEach, describe, expect, it } from "vitest";
import { joinDefault, testEnv, UNBOOTSTRAP } from "./world";

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
/** What was posted to a topic, and how. */
let posted: { url: string; title: string | null; body: string; redirect?: RequestInit["redirect"]; signal: boolean }[];
const topics: typeof fetch = async (input, init) => {
  const req = new Request(input, init);
  posted.push({
    url: req.url,
    title: req.headers.get("Title"),
    body: await req.text(),
    redirect: init?.redirect,
    signal: !!init?.signal,
  });
  return new Response("{}", { status: 200 });
};
let cookie = "";
async function call(path: string, body?: unknown) {
  const r = await adminRoutes(topics, fake).request(
    `https://bongsu.test${path}`,
    {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    e,
  );
  const set = r.headers.get("Set-Cookie");
  if (set && !set.includes("Max-Age=0")) cookie = set.split(";")[0];
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
}

const TOPIC = "https://ntfy.sh/bongsu-demo-topic-4f9a2c";

beforeEach(async () => {
  cookie = "";
  posted = [];
  await env.DB.batch([...UNBOOTSTRAP].map((s) => env.DB.prepare(s)));
  await env.DB.prepare(
    "INSERT INTO workspaces (id, name, created_at) VALUES ('b', 'Workspace B', 0) ON CONFLICT (id) DO NOTHING",
  ).run();
  await env.DB.prepare(
    "INSERT INTO workspace_settings (workspace_id, timezone, digest_hour, locale, updated_at) VALUES ('b', 'UTC', 8, 'en', 0) ON CONFLICT (workspace_id) DO NOTHING",
  ).run();
  e = await testEnv(env, {
    SETUP_TOKEN: "setup-token-123",
    PUBLIC_URL: "https://bongsu.test",
    RP_ID: "bongsu.test",
    NOTIFY_URL: undefined,
  } as Partial<Env>);
  await setWorkspaceNtfy(e, "b", null, 0);
  const o = await call("/admin-api/bootstrap/options", { token: "setup-token-123", email: "owner@example.com" });
  await call("/admin-api/bootstrap/verify", { challengeId: o.json.challengeId, response: { id: "laptop-key" } });
  await joinDefault(); // the bootstrap makes an instance admin in no workspace
});

describe("a workspace's ntfy topic", () => {
  it("takes an https address with a topic, no user info", () => {
    for (const ok of [TOPIC, "https://ntfy.example.com:8443/alerts?auth=dGVzdA"])
      expect(() => checkNtfyUrl(ok)).not.toThrow();
    for (const bad of [
      "http://ntfy.sh/topic",
      "https://ntfy.sh/",
      "https://user:pass@ntfy.sh/topic",
      "https://ntfy.sh/topic#x",
      "not a url",
    ])
      expect(() => checkNtfyUrl(bad), bad).toThrow();
  });

  it("is set in the dashboard, kept encrypted, shown by its host only, tested and removed", async () => {
    expect((await call("/admin-api/settings")).json.ntfy).toEqual({ set: false, host: null });
    expect((await call("/admin-api/settings/ntfy", { url: "http://ntfy.sh/x" })).status).toBe(400);
    expect((await call("/admin-api/settings/ntfy", { url: TOPIC })).json).toEqual({ set: true, host: "ntfy.sh" });
    const row = await env.DB.prepare("SELECT notify_url FROM workspace_settings WHERE workspace_id = 'default'").first<{
      notify_url: string;
    }>();
    expect(row?.notify_url).not.toContain("bongsu-demo-topic");
    const shown = await call("/admin-api/settings");
    expect(shown.json.ntfy).toEqual({ set: true, host: "ntfy.sh" });
    expect(JSON.stringify(shown.json)).not.toContain("bongsu-demo-topic");
    expect((await call("/admin-api/settings/ntfy/test", {})).json).toEqual({ sent: true });
    expect(posted.map((p) => p.url)).toEqual([TOPIC]);
    expect((await call("/admin-api/settings/ntfy", { url: null })).json).toEqual({ set: false, host: null });
    expect(await workspaceNtfy(e, "default")).toBeNull();
    expect((await call("/admin-api/settings/ntfy/test", {})).status).toBe(400);
  });

  it("asks for a fresh passkey to change it", async () => {
    await env.DB.prepare("UPDATE sessions SET verified_at = 0").run();
    expect((await call("/admin-api/settings/ntfy", { url: TOPIC })).json).toMatchObject({ verify: true });
  });
});

describe("notifications to the topics", () => {
  it("go to the topic of the workspace they're about, and nowhere without one", async () => {
    await setWorkspaceNtfy(e, "default", TOPIC, 0);
    await setWorkspaceNtfy(e, "b", "https://ntfy.example.com/b-topic", 0);
    const note = notifier(e, topics, 0);
    await note.send({ group: "published", title: "Published", text: "default's item" }, "default");
    await note.send({ group: "digest", title: "Digest", text: "B's day" }, "b");
    expect(posted.map((p) => [p.url, p.title, p.body])).toEqual([
      [TOPIC, "Published", "default's item"],
      ["https://ntfy.example.com/b-topic", "Digest", "B's day"],
    ]);
    expect(posted.every((p) => p.redirect === "manual" && p.signal)).toBe(true);
    posted = [];
    await setWorkspaceNtfy(e, "b", null, 0);
    await notifier(e, topics, 0).send({ group: "digest", title: "Digest", text: "B's day" }, "b");
    expect(posted).toEqual([]);
  });
});
