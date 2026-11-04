// Web Push (core/push.ts): a subscription is one device of the user who made it; a notification about a workspace
// reaches the devices of its members whose setting for the note's group is on, and nobody else's; its links open that
// workspace and its title names it for people in several; endpoints are the browsers' push services only, requested
// without following redirects.
import { env } from "cloudflare:workers";
import { appRoutes } from "@bongsu/api/pwa/routes";
import { createSession, setSessionWorkspace } from "@bongsu/api/pwa/session";
import type { Env } from "@bongsu/core/env";
import { removeMember } from "@bongsu/core/invites";
import { notifier } from "@bongsu/core/notify";
import { setPref } from "@bongsu/core/notify-prefs";
import { addMember } from "@bongsu/core/people";
import { isPushEndpoint, type PushNote, sendPush } from "@bongsu/core/push";
import type { Note } from "@bongsu/core/texts/notifications";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
  const clientPublic = new Uint8Array((await crypto.subtle.exportKey("raw", client.publicKey)) as ArrayBuffer);
  const authSecret = crypto.getRandomValues(new Uint8Array(16));
  return {
    VAPID_PUBLIC_KEY: b64url((await crypto.subtle.exportKey("raw", vapid.publicKey)) as ArrayBuffer),
    VAPID_PRIVATE_KEY: jwk.d!,
    p256dh: b64url(clientPublic),
    auth: b64url(authSecret),
    client,
    clientPublic,
    authSecret,
  };
}

/** What the browser reads from a push: the body decrypted as RFC 8291 says (aes128gcm, one record), as JSON. */
async function decrypt(body: Uint8Array): Promise<PushNote> {
  const salt = body.slice(0, 16);
  const idLen = body[20];
  const serverPublic = body.slice(21, 21 + idLen);
  const server = await crypto.subtle.importKey("raw", serverPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = await crypto.subtle.deriveBits(
    // the Workers types spell `public` as `$public`; the runtime takes the standard name
    { name: "ECDH", public: server } as unknown as SubtleCryptoDeriveKeyAlgorithm,
    k.client.privateKey,
    256,
  );
  const hkdf = async (salt: Uint8Array, ikm: ArrayBuffer | Uint8Array, info: Uint8Array, bytes: number) =>
    new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: "HKDF", hash: "SHA-256", salt, info },
        await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]),
        bytes * 8,
      ),
    );
  const text = (s: string) => new TextEncoder().encode(s);
  const keyInfo = new Uint8Array([...text("WebPush: info\0"), ...k.clientPublic, ...serverPublic]);
  const ikm = await hkdf(k.authSecret, shared, keyInfo, 32);
  const cek = await hkdf(salt, ikm, text("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, text("Content-Encoding: nonce\0"), 12);
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const padded = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, aes, body.slice(21 + idLen)),
  );
  // the last record ends with 0x02, then zeroes
  return JSON.parse(new TextDecoder().decode(padded.slice(0, padded.lastIndexOf(2))));
}

let e: Env;
let k: Awaited<ReturnType<typeof keys>>;
/** Every request the push code makes, with how it was asked for. */
let sent: { url: string; redirect?: RequestInit["redirect"]; signal: boolean }[];
/** The encrypted body of each request, by endpoint. */
let bodies: Map<string, Uint8Array>;
const pushService: typeof fetch = async (input, init) => {
  sent.push({ url: String(input), redirect: init?.redirect, signal: !!init?.signal });
  bodies.set(String(input), new Uint8Array(init?.body as Uint8Array));
  return new Response(null, { status: 201 });
};
/** The note as the device at `endpoint` got it. */
const received = (endpoint: string) => decrypt(bodies.get(endpoint)!);

const FCM = (id: string) => `https://fcm.googleapis.com/fcm/send/${id}`;
const subscribe = (endpoint: string, userId: string) =>
  env.DB.prepare("INSERT INTO push_subs (endpoint, p256dh, auth, created_at, user_id) VALUES (?1, ?2, ?3, 0, ?4)")
    .bind(endpoint, k.p256dh, k.auth, userId)
    .run();
/** The app as a signed-in user, working in `workspaceId` when given. */
const asUser = async (userId: string, workspaceId?: string) => {
  const token = await createSession(env.DB, Math.floor(Date.now() / 1000), { userId });
  if (workspaceId) await setSessionWorkspace(env.DB, token, workspaceId);
  const cookie = `bongsu_session=${token}`;
  return (path: string, body: unknown) =>
    appRoutes(pushService).request(
      `https://bongsu.test${path}`,
      { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify(body) },
      e,
    );
};

const USERS = ["bea", "cho", "dan", "ina"];
beforeEach(async () => {
  sent = [];
  bodies = new Map();
  k = await keys();
  const ids = USERS.map((u) => `'${u}'`).join(", ");
  await env.DB.batch(
    [
      "DELETE FROM push_subs",
      "DELETE FROM sessions",
      "DELETE FROM audit",
      "DELETE FROM notify_prefs",
      `DELETE FROM memberships WHERE user_id IN (${ids})`,
      `DELETE FROM users WHERE id IN (${ids})`,
      "INSERT INTO workspaces (id, name, created_at) VALUES ('b', 'Workspace B', 0) ON CONFLICT (id) DO NOTHING",
      "UPDATE workspaces SET name = 'Demo Studio' WHERE id = 'default'",
      // bea: B's editor only; cho: the default workspace's editor only; dan: the default workspace's admin and B's
      // creator; ina: an instance admin in neither. The owner (seeded) is the default workspace's admin and an
      // instance admin.
      "INSERT INTO users (id, name, created_at) VALUES ('bea', 'Bea', 0)",
      "INSERT INTO users (id, name, created_at) VALUES ('cho', 'Cho', 0)",
      "INSERT INTO users (id, name, created_at) VALUES ('dan', 'Dan', 0)",
      "INSERT INTO users (id, name, created_at, instance_admin) VALUES ('ina', 'Ina', 0, 1)",
    ].map((q) => env.DB.prepare(q)),
  );
  await addMember(env.DB, "b", "bea", "editor", 0);
  await addMember(env.DB, "default", "cho", "editor", 0);
  await addMember(env.DB, "default", "dan", "admin", 0);
  await addMember(env.DB, "b", "dan", "creator", 0);
  e = await testEnv(env, {
    VAPID_PUBLIC_KEY: k.VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY: k.VAPID_PRIVATE_KEY,
    VAPID_SUBJECT: "mailto:owner@example.com",
    NOTIFY_URL: undefined,
  });
});
afterEach(async () => {
  await env.DB.prepare("UPDATE workspaces SET name = 'Default' WHERE id = 'default'").run();
});

describe("push subscriptions", () => {
  it("belong to the user who subscribed, in no particular workspace", async () => {
    const bea = await asUser("bea");
    const r = await bea("/app-api/push/subscribe", { endpoint: FCM("bea"), keys: { p256dh: k.p256dh, auth: k.auth } });
    expect(r.status).toBe(200);
    const row = await env.DB.prepare("SELECT * FROM push_subs").first();
    expect(row).toMatchObject({ endpoint: FCM("bea"), user_id: "bea" });
    expect(row).not.toHaveProperty("workspace_id");
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

const note = (group: Note["group"], target?: string): Note => ({
  group,
  title: "demo_travel: published",
  text: "t",
  target,
});
const send = (n: Note, workspaceId: string) => notifier(e, pushService, 0).send(n, workspaceId);
const reached = () => sent.map((s) => s.url).sort();

describe("push delivery", () => {
  it("goes to the members of the note's workspace, wherever their device subscribed", async () => {
    await subscribe(FCM("owner"), "owner");
    await subscribe(FCM("bea"), "bea");
    await subscribe(FCM("cho"), "cho");
    // dan's device subscribed while he worked in B
    const dan = await asUser("dan", "b");
    expect(
      (await dan("/app-api/push/subscribe", { endpoint: FCM("dan"), keys: { p256dh: k.p256dh, auth: k.auth } })).status,
    ).toBe(200);
    await send(note("published", "reel:x"), "default");
    expect(reached()).toEqual([FCM("cho"), FCM("dan"), FCM("owner")]);
    sent = [];
    await send({ group: "digest", title: "Digest", text: "B's day" }, "b");
    expect(reached()).toEqual([FCM("bea"), FCM("dan")]);
    // the audit row says which workspace it was about
    const audit = await env.DB.prepare("SELECT workspace_id FROM audit WHERE action = 'notify' ORDER BY id").all();
    expect(audit.results).toEqual([{ workspace_id: "default" }, { workspace_id: "b" }]);
  });

  it("skips a group the person turned off, in that workspace only", async () => {
    await subscribe(FCM("dan"), "dan");
    await setPref(env.DB, "default", "dan", "admin", "published", false, 0);
    await send(note("published"), "default");
    expect(sent).toEqual([]);
    await send(note("problems"), "default");
    expect(reached()).toEqual([FCM("dan")]);
    sent = [];
    await send(note("published"), "b");
    expect(reached()).toEqual([FCM("dan")]);
  });

  it("follows the role's defaults: an editor gets no needs_you, unless they turn it on", async () => {
    await subscribe(FCM("cho"), "cho");
    await send(note("needs_you", "drafts"), "default");
    expect(sent).toEqual([]);
    await send(note("problems"), "default");
    expect(reached()).toEqual([FCM("cho")]);
    sent = [];
    await setPref(env.DB, "default", "cho", "editor", "needs_you", true, 0);
    await send(note("needs_you", "drafts"), "default");
    expect(reached()).toEqual([FCM("cho")]);
  });

  it("never reaches an instance admin who isn't a member", async () => {
    await subscribe(FCM("ina"), "ina");
    for (const g of ["needs_you", "problems", "published", "inbox", "digest"] as const) await send(note(g), "default");
    expect(sent).toEqual([]);
  });

  it("stops at someone removed from the workspace, and forgets their settings there", async () => {
    await subscribe(FCM("dan"), "dan");
    await setPref(env.DB, "default", "dan", "admin", "digest", false, 0);
    await setPref(env.DB, "b", "dan", "creator", "digest", false, 0);
    await removeMember(env.DB, "default", "dan", { instanceAdmin: true }, 0);
    await send(note("problems"), "default");
    expect(sent).toEqual([]);
    expect((await env.DB.prepare("SELECT workspace_id FROM notify_prefs WHERE user_id = 'dan'").all()).results).toEqual(
      [{ workspace_id: "b" }],
    );
    // the device stays theirs, for the workspace they're still in
    await send(note("problems"), "b");
    expect(reached()).toEqual([FCM("dan")]);
  });

  it("opens its workspace, tags it, and names it for people in several", async () => {
    await subscribe(FCM("cho"), "cho");
    await subscribe(FCM("dan"), "dan");
    await send(note("published", "reel:x"), "default");
    const toDan = await received(FCM("dan"));
    const toCho = await received(FCM("cho"));
    expect(toDan.url).toBe("/?w=default#/item/reel%3Ax");
    expect(toDan.actions?.map((a) => a.url)).toEqual(["/?w=default#/item/reel%3Ax"]);
    expect(toDan.tag).toBe("default:reel:x");
    expect(toDan.title).toBe("Demo Studio · demo_travel: published");
    expect(toCho.title).toBe("demo_travel: published");
    expect(toCho.url).toBe("/?w=default#/item/reel%3Ax");
  });

  it("keeps two workspaces' notes about the same key apart", async () => {
    await subscribe(FCM("dan"), "dan");
    await send(note("published", "reel:x"), "default");
    const a = await received(FCM("dan"));
    await send(note("published", "reel:x"), "b");
    const b = await received(FCM("dan"));
    expect([a.tag, b.tag]).toEqual(["default:reel:x", "b:reel:x"]);
    expect(b.url).toBe("/?w=b#/item/reel%3Ax");
    expect(b.title).toBe("Workspace B · demo_travel: published");
  });

  it("asks without following redirects and with a time limit; an endpoint stored before the check is dropped", async () => {
    await subscribe(FCM("owner"), "owner");
    await subscribe("https://internal.example.com/hook", "owner");
    const r = await sendPush(e, pushService, { title: "x", body: "y" }, 0, {
      workspaceId: "default",
      group: "problems",
    });
    expect(sent).toEqual([{ url: FCM("owner"), redirect: "manual", signal: true }]);
    expect(r).toEqual({ sent: 1, removed: 1 });
    expect((await env.DB.prepare("SELECT endpoint FROM push_subs").all()).results).toEqual([
      { endpoint: FCM("owner") },
    ]);
  });

  it("sends the test to the caller's own devices only", async () => {
    await subscribe(FCM("owner"), "owner");
    await subscribe(FCM("bea"), "bea");
    await subscribe(FCM("cho"), "cho");
    const bea = await asUser("bea");
    expect(await (await bea("/app-api/push/test", {})).json()).toEqual({ sent: 1, removed: 0 });
    expect(sent.map((s) => s.url)).toEqual([FCM("bea")]);
    expect((await received(FCM("bea"))).title).toBe("Bongsu");
  });
});
