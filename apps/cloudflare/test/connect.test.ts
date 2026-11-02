// The dashboard's connect flows (Phase 4b): the owner's OAuth apps, Connect Instagram (Instagram Login) and Connect
// YouTube (Google, with PKCE) through the callback, pasting a token or a Composio id, reconnecting and removing.
import { env } from "cloudflare:workers";
import { adminRoutes } from "@bongsu/api/dashboard/routes";
import type { Verifiers } from "@bongsu/api/pwa/webauthn";
import { connectionSecret, listAccounts } from "@bongsu/core/accounts";
import type { Env } from "@bongsu/core/env";
import { beforeEach, describe, expect, it } from "vitest";
import { testEnv, World } from "./world";

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
let w: World;
let cookie = "";
async function call(path: string, body?: unknown, withCookie = true) {
  const r = await adminRoutes(w.fetch, fake).request(
    `https://bongsu.test${path}`,
    {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json", ...(cookie && withCookie ? { Cookie: cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    e,
  );
  const set = r.headers.get("Set-Cookie");
  if (set && !set.includes("Max-Age=0")) cookie = set.split(";")[0];
  const text = await r.text();
  return {
    status: r.status,
    location: r.headers.get("Location"),
    json: (text.startsWith("{") ? JSON.parse(text) : {}) as Record<string, unknown>,
  };
}

/** The provider sending the browser back: no dashboard cookie (it's SameSite=Strict). */
const callback = (provider: string, q: Record<string, string>) =>
  call(`/admin-api/connect/${provider}/callback?${new URLSearchParams(q)}`, undefined, false);
const backParams = (location: string | null) => Object.fromEntries(new URL(location ?? "https://x/").searchParams);

const META = { clientId: "meta-app-id", clientSecret: "meta-app-secret" };
const GOOGLE = { clientId: "google-app.apps.googleusercontent.com", clientSecret: "google-secret" };

beforeEach(async () => {
  cookie = "";
  w = new World();
  await env.DB.batch(
    [
      "DELETE FROM passkeys",
      "DELETE FROM sessions",
      "DELETE FROM challenges",
      "DELETE FROM recovery_codes",
      "DELETE FROM audit",
      "DELETE FROM oauth_apps",
      "DELETE FROM oauth_states",
      "DELETE FROM settings WHERE key = 'bootstrap_done'",
      "UPDATE users SET email = NULL WHERE id = 'owner'",
      // what earlier tests connected (testEnv seeds the demo accounts and connections again)
      "DELETE FROM accounts WHERE id NOT IN ('demo_travel', 'demo_running', 'demo_cycling', 'main', 'vlogs')",
      "UPDATE accounts SET connection_id = NULL",
      "DELETE FROM connections",
    ].map((s) => env.DB.prepare(s)),
  );
  e = await testEnv(env, {
    SETUP_TOKEN: "setup-token-123",
    PUBLIC_URL: "https://bongsu.test",
    RP_ID: "bongsu.test",
    ENCRYPTION_KEY: "an-encryption-key-for-tests",
  } as Partial<Env>);
  const o = await call("/admin-api/bootstrap/options", { token: "setup-token-123", email: "owner@example.com" });
  await call("/admin-api/bootstrap/verify", { challengeId: o.json.challengeId, response: { id: "laptop-key" } });
});

describe("OAuth apps", () => {
  it("lists the apps the providers use with the redirect URLs to register, and keeps the secret encrypted", async () => {
    const r = await call("/admin-api/oauth-apps");
    const apps = r.json.apps as { id: string; clientId: string | null; providers: { redirectUri: string }[] }[];
    expect(apps.map((a) => a.id).sort()).toEqual(["google", "meta"]);
    expect(apps.find((a) => a.id === "meta")?.providers[0].redirectUri).toBe(
      "https://bongsu.test/admin-api/connect/instagram/callback",
    );
    expect(apps.find((a) => a.id === "google")?.providers[0].redirectUri).toBe(
      "https://bongsu.test/admin-api/connect/youtube/callback",
    );
    expect(apps.every((a) => a.clientId === null)).toBe(true);

    expect((await call("/admin-api/oauth-apps/meta", META)).status).toBe(200);
    expect((await call("/admin-api/oauth-apps/nope", META)).status).toBe(400);
    const row = await env.DB.prepare("SELECT client_id, client_secret FROM oauth_apps WHERE id = 'meta'").first<{
      client_id: string;
      client_secret: string;
    }>();
    expect(row?.client_id).toBe("meta-app-id");
    expect(row?.client_secret).toMatch(/^v1:/);
    expect(row?.client_secret).not.toContain("meta-app-secret");
    const after = (await call("/admin-api/oauth-apps")).json.apps as { id: string; clientId: string | null }[];
    expect(after.find((a) => a.id === "meta")?.clientId).toBe("meta-app-id");
    expect(JSON.stringify(after)).not.toContain("meta-app-secret");
  });

  it("changing them needs a recent passkey check", async () => {
    await env.DB.prepare("UPDATE sessions SET verified_at = 0").run();
    const r = await call("/admin-api/oauth-apps/meta", META);
    expect(r.status).toBe(403);
    expect(r.json.verify).toBe(true);
    expect((await call("/admin-api/connect/instagram/start", {})).status).toBe(403);
  });
});

describe("Connect Instagram (Instagram Login)", () => {
  it("needs the Meta app first", async () => {
    const r = await call("/admin-api/connect/instagram/start", {});
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/Meta app/);
  });

  it("authorizes, exchanges the code for a long-lived token and connects the account it reaches", async () => {
    await call("/admin-api/oauth-apps/meta", META);
    const start = await call("/admin-api/connect/instagram/start", {});
    const url = new URL(start.json.url as string);
    expect(url.origin + url.pathname).toBe("https://www.instagram.com/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("meta-app-id");
    expect(url.searchParams.get("redirect_uri")).toBe("https://bongsu.test/admin-api/connect/instagram/callback");
    expect(url.searchParams.get("scope")).toContain("instagram_business_basic,instagram_business_content_publish");
    expect(url.searchParams.get("code_challenge")).toBeNull(); // Instagram takes no PKCE
    const state = url.searchParams.get("state")!;

    const back = await callback("instagram", { code: "ig-code#_", state });
    expect(back.status).toBe(302);
    expect(back.location).toMatch(/^https:\/\/bongsu\.test\/dashboard\/connections\?/);
    expect(backParams(back.location)).toEqual({ connected: "@demo_cycling", accounts: "1" });
    expect(w.igCodes[0]).toMatchObject({
      code: "ig-code",
      client_secret: "meta-app-secret",
      redirect_uri: "https://bongsu.test/admin-api/connect/instagram/callback",
    });

    // demo_cycling (same Instagram user id) is the same row, now reached through the new connection
    const a = (await listAccounts(env.DB, { all: true })).find((x) => x.id === "demo_cycling")!;
    expect(a.connection?.provider).toBe("instagram");
    expect(a.capabilities.trialReels).toBe(true); // 1200 followers
    const creds = JSON.parse((await connectionSecret(e, a.connection))!);
    expect(creds.access_token).toBe("ig-long");
    const c = await env.DB.prepare("SELECT credentials, expires_at, status FROM connections WHERE id = ?1")
      .bind(a.connection!.id)
      .first<{ credentials: string; expires_at: number; status: string }>();
    expect(c?.credentials).not.toContain("ig-long");
    expect(c?.expires_at).toBeGreaterThan(Date.now() / 1000 + 59 * 86400);
    expect(c?.status).toBe("ok");
    const audit = await env.DB.prepare("SELECT actor, action FROM audit WHERE action = 'connect'").first();
    expect(audit).toEqual({ actor: "user:owner", action: "connect" });

    // the state works once
    const again = await callback("instagram", { code: "ig-code", state });
    expect(backParams(again.location).error).toMatch(/isn't valid|used already/);
  });

  it("refuses a made-up state, a state from another provider, a denied grant and a bad code", async () => {
    await call("/admin-api/oauth-apps/meta", META);
    await call("/admin-api/oauth-apps/google", GOOGLE);
    expect(backParams((await callback("instagram", { code: "ig-code", state: "made-up" })).location).error).toMatch(
      /isn't valid/,
    );
    const yt = new URL((await call("/admin-api/connect/youtube/start", {})).json.url as string).searchParams.get(
      "state",
    )!;
    expect(backParams((await callback("instagram", { code: "ig-code", state: yt })).location).error).toMatch(
      /isn't valid/,
    );

    const s1 = new URL((await call("/admin-api/connect/instagram/start", {})).json.url as string).searchParams.get(
      "state",
    )!;
    const denied = await callback("instagram", { error: "access_denied", error_reason: "user_denied", state: s1 });
    expect(backParams(denied.location).error).toMatch(/cancelled/);

    const s2 = new URL((await call("/admin-api/connect/instagram/start", {})).json.url as string).searchParams.get(
      "state",
    )!;
    const bad = await callback("instagram", { code: "wrong", state: s2 });
    expect(backParams(bad.location).error).toMatch(/Invalid authorization code/);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM connections WHERE provider = 'instagram'").first()).toEqual({
      n: 0,
    });
  });

  it("a state runs out after 15 minutes", async () => {
    await call("/admin-api/oauth-apps/meta", META);
    const s = new URL((await call("/admin-api/connect/instagram/start", {})).json.url as string).searchParams.get(
      "state",
    )!;
    await env.DB.prepare("UPDATE oauth_states SET expires_at = 1").run();
    expect(backParams((await callback("instagram", { code: "ig-code", state: s })).location).error).toMatch(/too long/);
  });

  it("a pasted long-lived token connects too", async () => {
    const bad = await call("/admin-api/connect/instagram/paste", { value: "not-a-token" });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toMatch(/Invalid OAuth access token/);
    const r = await call("/admin-api/connect/instagram/paste", { value: "ig-token-1" });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ label: "@demo_cycling", accounts: [{ id: "demo_cycling", created: false }] });
  });
});

describe("Connect YouTube (Google, PKCE)", () => {
  it("sends a PKCE challenge, exchanges the code with its verifier and creates the channel's account", async () => {
    await call("/admin-api/oauth-apps/google", GOOGLE);
    const url = new URL((await call("/admin-api/connect/youtube/start", {})).json.url as string);
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("scope")).toBe(
      "https://www.googleapis.com/auth/youtube.force-ssl https://www.googleapis.com/auth/yt-analytics.readonly",
    );
    w.googleChallenge = url.searchParams.get("code_challenge")!;

    const back = await callback("youtube", { code: "g-code", state: url.searchParams.get("state")! });
    expect(backParams(back.location)).toEqual({ connected: "Our Channel", accounts: "1" });
    expect(w.googleCodes[0].code_verifier).toBeTruthy();

    const a = (await listAccounts(env.DB, { all: true })).find((x) => x.externalId === "UCours")!;
    expect(a).toMatchObject({
      id: "ourchannel",
      platform: "youtube",
      handle: "ourchannel",
      displayName: "Our Channel",
    });
    expect(JSON.parse((await connectionSecret(e, a.connection))!)).toEqual({
      client_id: GOOGLE.clientId,
      client_secret: GOOGLE.clientSecret,
      refresh_token: "g-refresh",
      token_uri: "https://oauth2.googleapis.com/token",
      scope: "https://www.googleapis.com/auth/youtube.force-ssl https://www.googleapis.com/auth/yt-analytics.readonly",
    });
  });

  it("refuses a code whose verifier doesn't match the challenge", async () => {
    await call("/admin-api/oauth-apps/google", GOOGLE);
    const url = new URL((await call("/admin-api/connect/youtube/start", {})).json.url as string);
    w.googleChallenge = "some-other-challenge";
    const back = await callback("youtube", { code: "g-code", state: url.searchParams.get("state")! });
    expect(backParams(back.location).error).toMatch(/Google refused the code/);
  });

  it("reconnecting keeps the connection and the account; removing revokes the grant and keeps the account", async () => {
    await call("/admin-api/oauth-apps/google", GOOGLE);
    const connect = async (reconnect?: string) => {
      const url = new URL(
        (await call("/admin-api/connect/youtube/start", reconnect ? { reconnect } : {})).json.url as string,
      );
      w.googleChallenge = url.searchParams.get("code_challenge")!;
      return callback("youtube", { code: "g-code", state: url.searchParams.get("state")! });
    };
    await connect();
    const first = (await listAccounts(env.DB, { all: true })).find((x) => x.id === "ourchannel")!;
    await env.DB.prepare("UPDATE connections SET status = 'broken', last_error = 'revoked' WHERE id = ?1")
      .bind(first.connection!.id)
      .run();
    await env.DB.prepare("UPDATE accounts SET settings = '{\"kept\":true}' WHERE id = 'ourchannel'").run();

    expect(backParams((await connect(first.connection!.id)).location).connected).toBe("Our Channel");
    const again = (await listAccounts(env.DB, { all: true })).filter((x) => x.externalId === "UCours");
    expect(again).toHaveLength(1);
    expect(again[0].connection).toMatchObject({ id: first.connection!.id, status: "ok" });
    expect(again[0].settings).toEqual({ kept: true });

    expect((await call("/admin-api/connect/youtube/start", { reconnect: "c_nope" })).status).toBe(400);

    const rm = await call(`/admin-api/connections/${first.connection!.id}/remove`, {});
    expect(rm.json).toEqual({ removed: true, revoked: true });
    expect(w.googleRevoked).toEqual(["g-refresh"]);
    const left = (await listAccounts(env.DB, { all: true })).find((x) => x.id === "ourchannel")!;
    expect(left.connection).toBeNull();
    expect((await call("/admin-api/connections")).json.connections).not.toContainEqual(
      expect.objectContaining({ id: first.connection!.id }),
    );
  });
});

describe("reconnecting a channel set up by hand", () => {
  it("takes over the account of that connection when it has no channel id yet", async () => {
    await call("/admin-api/oauth-apps/google", GOOGLE);
    // "main" comes from a secret (YT_MAIN_OAUTH) and has no external id
    const url = new URL((await call("/admin-api/connect/youtube/start", { reconnect: "c_main" })).json.url as string);
    w.googleChallenge = url.searchParams.get("code_challenge")!;
    const back = await callback("youtube", { code: "g-code", state: url.searchParams.get("state")! });
    expect(backParams(back.location).connected).toBe("Our Channel");
    const all = await listAccounts(env.DB, { all: true });
    expect(all.filter((a) => a.externalId === "UCours").map((a) => a.id)).toEqual(["main"]);
    const main = all.find((a) => a.id === "main")!;
    expect(main.connection).toMatchObject({ id: "c_main", secretName: null, status: "ok" });
    expect(JSON.parse((await connectionSecret(e, main.connection))!).refresh_token).toBe("g-refresh");
  });
});

describe("Connect through Composio", () => {
  it("checks the connected account and connects the Instagram account it posts as", async () => {
    w.composio.INSTAGRAM_GET_USER_INFO = (args, account) => {
      expect(account).toBe("ca_new");
      expect(args.ig_user_id).toBe("me");
      return { id: "17841400000000099", username: "new_account", followers_count: 40 };
    };
    const r = await call("/admin-api/connect/composio/paste", { value: "ca_new" });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      label: "@new_account (Composio)",
      accounts: [{ id: "new_account", created: true }],
    });
    const a = (await listAccounts(env.DB, { all: true })).find((x) => x.id === "new_account")!;
    expect(a.connection).toMatchObject({ provider: "composio", externalRef: "ca_new", credentials: null });
    expect(a.capabilities.trialReels).toBe(false);
  });
});

describe("the connections page", () => {
  it("lists what can be connected, which can be pasted and which OAuth apps are ready", async () => {
    await call("/admin-api/oauth-apps/meta", META);
    const r = (await call("/admin-api/connections")).json as {
      kinds: { provider: string; kind: string; app?: string; canPaste: boolean }[];
      appsReady: string[];
    };
    expect(r.appsReady).toEqual(["meta"]);
    expect(r.kinds.find((k) => k.provider === "instagram")).toMatchObject({
      kind: "oauth2",
      app: "meta",
      canPaste: true,
    });
    expect(r.kinds.find((k) => k.provider === "youtube")).toMatchObject({
      kind: "oauth2",
      app: "google",
      canPaste: false,
    });
    expect(r.kinds.find((k) => k.provider === "composio")).toMatchObject({ kind: "composio", canPaste: true });
  });
});
