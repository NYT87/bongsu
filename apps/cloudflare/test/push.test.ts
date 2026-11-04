// Web Push (core/push.ts): a subscription belongs to the user who made it and their workspace; a notification about a
// workspace reaches only its members' devices; endpoints are the browsers' push services only, requested without
// following redirects.
import { env } from "cloudflare:workers";
import { appRoutes } from "@bongsu/api/pwa/routes";
import { createSession } from "@bongsu/api/pwa/session";
import type { Env } from "@bongsu/core/env";
import { notifier } from "@bongsu/core/notify";
import { isPushEndpoint, sendPush } from "@bongsu/core/push";
import { beforeEach, describe, expect, it } from "vitest";
import { testEnv } from "./world";

const b64url = (b: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(b)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

/** A VAPID pair as the Worker keeps it, and a browser subscription's keys (both real P-256 keys: the payload is really
 *  encrypted and signed). */
async function keys() {
  const vapid = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", vapid.privateKey)) as JsonWebKey;
  const client = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  return {
    VAPID_PUBLIC_KEY: b64url((await crypto.subtle.exportKey("raw", vapid.publicKey)) as ArrayBuffer),
    VAPID_PRIVATE_KEY: jwk.d!,
    p256dh: b64url((await crypto.subtle.exportKey("raw", client.publicKey)) as ArrayBuffer),
    auth: b64url(crypto.getRandomValues(new Uint8Array(16))),
  };
}

let e: Env;
let k: Awaited<ReturnType<typeof keys>>;
/** Every request the push code makes, with how it was asked for. */
let sent: { url: string; redirect?: RequestInit["redirect"]; signal: boolean }[];
const pushService: typeof fetch = async (input, init) => {
  sent.push({ url: String(input), redirect: init?.redirect, signal: !!init?.signal });
  return new Response(null, { status: 201 });
};

const FCM = (id: string) => `https://fcm.googleapis.com/fcm/send/${id}`;
const subscribe = (endpoint: string, userId: string, workspaceId: string) =>
  env.DB.prepare(
    "INSERT INTO push_subs (endpoint, p256dh, auth, created_at, user_id, workspace_id) VALUES (?1, ?2, ?3, 0, ?4, ?5)",
  )
    .bind(endpoint, k.p256dh, k.auth, userId, workspaceId)
    .run();
/** The app as a signed-in user. */
const asUser = async (userId: string) => {
  const cookie = `bongsu_session=${await createSession(env.DB, Math.floor(Date.now() / 1000), { userId })}`;
  return (path: string, body: unknown) =>
    appRoutes(pushService).request(
      `https://bongsu.test${path}`,
      { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify(body) },
      e,
    );
};

beforeEach(async () => {
  sent = [];
  k = await keys();
  await env.DB.batch(["push_subs", "sessions", "audit"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await env.DB.prepare(
    "INSERT INTO workspaces (id, name, created_at) VALUES ('b', 'Workspace B', 0) ON CONFLICT (id) DO NOTHING",
  ).run();
  await env.DB.prepare(
    "INSERT INTO users (id, name, created_at) VALUES ('bea', 'Bea', 0) ON CONFLICT (id) DO NOTHING",
  ).run();
  await env.DB.prepare(
    "INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES ('b', 'bea', 'viewer', 0) ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = 'viewer'",
  ).run();
  e = await testEnv(env, {
    VAPID_PUBLIC_KEY: k.VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY: k.VAPID_PRIVATE_KEY,
    VAPID_SUBJECT: "mailto:owner@example.com",
    NOTIFY_URL: undefined,
  });
});

describe("push subscriptions", () => {
  it("belong to the user who subscribed, in their workspace", async () => {
    const bea = await asUser("bea");
    const r = await bea("/app-api/push/subscribe", { endpoint: FCM("bea"), keys: { p256dh: k.p256dh, auth: k.auth } });
    expect(r.status).toBe(200);
    const row = await env.DB.prepare("SELECT user_id, workspace_id FROM push_subs").first();
    expect(row).toEqual({ user_id: "bea", workspace_id: "b" });
  });

  it("take only a browser push service's address", async () => {
    const bea = await asUser("bea");
    for (const endpoint of [
      "https://internal.example.com/hook",
      "http://fcm.googleapis.com/fcm/send/x",
      "https://fcm.googleapis.com:8443/fcm/send/x",
      "https://user@fcm.googleapis.com/fcm/send/x",
      "https://fcm.googleapis.com.example.com/x",
      "https://169.254.169.254/latest/meta-data",
    ])
      expect(
        (await bea("/app-api/push/subscribe", { endpoint, keys: { p256dh: k.p256dh, auth: k.auth } })).status,
        endpoint,
      ).toBe(400);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM push_subs").first<{ n: number }>())?.n).toBe(0);
    for (const ok of [
      FCM("a"),
      "https://updates.push.services.mozilla.com/wpush/v2/abc",
      "https://web.push.apple.com/QAbc",
      "https://wns2-par02p.notify.windows.com/w/?token=abc",
    ])
      expect(isPushEndpoint(ok), ok).toBe(true);
  });
});

describe("push delivery", () => {
  it("goes only to the devices of the workspace a notification is about", async () => {
    await subscribe(FCM("owner"), "owner", "default");
    await subscribe(FCM("bea"), "bea", "b");
    await notifier(e.DB, pushService, undefined, 0, e).send(
      { title: "Published", text: "an unpublished item's name and its comments" },
      "default",
    );
    expect(sent.map((s) => s.url)).toEqual([FCM("owner")]);
    sent = [];
    await notifier(e.DB, pushService, undefined, 0, e).send({ title: "Digest", text: "B's day" }, "b");
    expect(sent.map((s) => s.url)).toEqual([FCM("bea")]);
    // the audit row says which workspace it was about
    const audit = await env.DB.prepare("SELECT workspace_id FROM audit WHERE action = 'notify' ORDER BY id").all();
    expect(audit.results).toEqual([{ workspace_id: "default" }, { workspace_id: "b" }]);
  });

  it("stops at a user who left the workspace, even with an old subscription there", async () => {
    await subscribe(FCM("bea-in-default"), "bea", "default"); // made while bea was a member of default
    await sendPush(e, pushService, { title: "x", body: "y" }, 0, { workspaceId: "default" });
    expect(sent).toEqual([]);
  });

  it("asks without following redirects and with a time limit; an endpoint stored before the check is dropped", async () => {
    await subscribe(FCM("owner"), "owner", "default");
    await subscribe("https://internal.example.com/hook", "owner", "default");
    const r = await sendPush(e, pushService, { title: "x", body: "y" }, 0, { workspaceId: "default" });
    expect(sent).toEqual([{ url: FCM("owner"), redirect: "manual", signal: true }]);
    expect(r).toEqual({ sent: 1, removed: 1 });
    expect((await env.DB.prepare("SELECT endpoint FROM push_subs").all()).results).toEqual([
      { endpoint: FCM("owner") },
    ]);
  });

  it("sends the test to the caller's own devices only", async () => {
    await subscribe(FCM("owner"), "owner", "default");
    await subscribe(FCM("bea"), "bea", "b");
    await env.DB.prepare(
      "INSERT INTO users (id, name, created_at) VALUES ('cho', 'Cho', 0) ON CONFLICT (id) DO NOTHING",
    ).run();
    await env.DB.prepare(
      "INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES ('default', 'cho', 'viewer', 0) ON CONFLICT DO NOTHING",
    ).run();
    await subscribe(FCM("cho"), "cho", "default");
    const bea = await asUser("bea");
    expect(await (await bea("/app-api/push/test", {})).json()).toEqual({ sent: 1, removed: 0 });
    expect(sent.map((s) => s.url)).toEqual([FCM("bea")]);
  });
});
