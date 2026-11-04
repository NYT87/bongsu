// The dashboard's connect flows (Phase 4b): the owner's OAuth apps, Connect Instagram (Instagram Login) and Connect
// YouTube (Google, with PKCE) through the callback, pasting a token or a Composio id, reconnecting and removing.
import { env } from "cloudflare:workers";
import { adminRoutes } from "@bongsu/api/dashboard/routes";
import { appRoutes } from "@bongsu/api/pwa/routes";
import { createSession, setSessionWorkspace } from "@bongsu/api/pwa/session";
import type { Verifiers } from "@bongsu/api/pwa/webauthn";
import { connectionSecret, listAccounts } from "@bongsu/core/accounts";
import type { Env } from "@bongsu/core/env";
import { beforeEach, describe, expect, it } from "vitest";
import { joinDefault, testEnv, UNBOOTSTRAP, World } from "./world";

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
/** The bootstrapped user (an instance admin, the default workspace's admin here). */
let me = "";
/** This browser's connect-flow cookies (bongsu_oauth) by their path, as the starts set and the callbacks clear them. */
let flows = new Map<string, string>();
/** Keeps the response's cookies: the flows' in `flows`, the dashboard session's in `cookie` (`session`); returns them
 *  all. */
function keepCookies(r: Response, session = true) {
  const sets = r.headers.getSetCookie();
  for (const set of sets) {
    const pair = set.split(";")[0];
    if (pair.startsWith("bongsu_oauth=")) {
      const path = /Path=([^;]+)/.exec(set)?.[1] ?? "/";
      if (set.includes("Max-Age=0")) flows.delete(path);
      else flows.set(path, pair);
    } else if (session && !set.includes("Max-Age=0")) cookie = pair;
  }
  return sets;
}
async function call(path: string, body?: unknown, withCookie = true, flowCookie?: string | null) {
  const cookies = [cookie && withCookie ? cookie : "", flowCookie ?? ""].filter(Boolean).join("; ");
  const r = await adminRoutes(w.fetch, fake).request(
    `https://bongsu.test${path}`,
    {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json", ...(cookies ? { Cookie: cookies } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    e,
  );
  const setCookies = keepCookies(r);
  const text = await r.text();
  return {
    status: r.status,
    location: r.headers.get("Location"),
    setCookies,
    json: (text.startsWith("{") ? JSON.parse(text) : {}) as Record<string, unknown>,
  };
}

/** The provider sending the browser back: no dashboard cookie (it's SameSite=Strict), but the flow's cookie for this
 *  callback (SameSite=Lax), unless `browser` says which one to send (null: none). */
const callback = (provider: string, q: Record<string, string>, browser?: string | null) => {
  const path = `/admin-api/connect/${provider}/callback`;
  return call(`${path}?${new URLSearchParams(q)}`, undefined, false, browser === undefined ? flows.get(path) : browser);
};
const backParams = (location: string | null) => Object.fromEntries(new URL(location ?? "https://x/").searchParams);

const META = { clientId: "meta-app-id", clientSecret: "meta-app-secret" };
const GOOGLE = { clientId: "google-app.apps.googleusercontent.com", clientSecret: "google-secret" };

beforeEach(async () => {
  cookie = "";
  flows = new Map();
  w = new World();
  await env.DB.batch(
    [
      ...UNBOOTSTRAP,
      "DELETE FROM oauth_apps",
      "DELETE FROM oauth_states",
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
  me = await joinDefault(); // the bootstrap makes an instance admin in no workspace
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
    expect(audit).toEqual({ actor: `user:${me}`, action: "connect" });

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

describe("a flow finishes only in the browser that started it", () => {
  const stateOf = (r: { json: Record<string, unknown> }) => new URL(r.json.url as string).searchParams.get("state")!;
  const IG = "/admin-api/connect/instagram/callback";
  const unused = () =>
    env.DB.prepare("SELECT COUNT(*) AS n FROM oauth_states WHERE used_at IS NULL").first<number>("n");

  it("the start sets a Lax cookie for the callback alone, which sends it back and clears it", async () => {
    await call("/admin-api/oauth-apps/meta", META);
    const start = await call("/admin-api/connect/instagram/start", {});
    const set = start.setCookies.find((x) => x.startsWith("bongsu_oauth="))!;
    expect(set).toMatch(
      /^bongsu_oauth=[A-Za-z0-9_-]{43}; Path=\/admin-api\/connect\/instagram\/callback; HttpOnly; Secure; SameSite=Lax; Max-Age=900$/,
    );
    // only its hash is kept
    const value = set.split(";")[0].split("=")[1];
    const row = await env.DB.prepare("SELECT browser_hash FROM oauth_states").first<string>("browser_hash");
    expect(row).toMatch(/^[0-9a-f]{64}$/);
    expect(row).not.toContain(value);

    const back = await callback("instagram", { code: "ig-code", state: stateOf(start) });
    expect(backParams(back.location)).toMatchObject({ connected: "@demo_cycling" });
    expect(back.setCookies).toEqual([
      "bongsu_oauth=x; Path=/admin-api/connect/instagram/callback; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
    ]);
    expect(flows.size).toBe(0);
  });

  it("refuses a callback without the cookie, with another flow's or a forged one, and spends no code", async () => {
    await call("/admin-api/oauth-apps/meta", META);
    const mine = await call("/admin-api/connect/instagram/start", {});
    const myCookie = flows.get(IG)!;
    // someone else's flow, started in their own browser, its link sent to this one
    flows = new Map();
    const theirs = await call("/admin-api/connect/instagram/start", {});
    const theirCookie = flows.get(IG)!;
    for (const browser of [null, myCookie, "bongsu_oauth=forged-value-forged-value-forged-value-forged-va"]) {
      const r = await callback("instagram", { code: "ig-code", state: stateOf(theirs) }, browser);
      expect(r.status).toBe(302);
      expect(backParams(r.location).error).toMatch(/isn't valid/);
      expect(r.location).toMatch(/\/dashboard\/connections\?/);
      expect(r.setCookies[0]).toMatch(/^bongsu_oauth=x; Path=\/admin-api\/connect\/instagram\/callback;.*Max-Age=0$/);
    }
    expect(w.igCodes).toEqual([]); // the token endpoint was never called
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM connections WHERE provider = 'instagram'").first()).toEqual({
      n: 0,
    });
    // a refused callback doesn't use the state up: each flow still finishes in its own browser
    expect(await unused()).toBe(2);
    expect(
      backParams((await callback("instagram", { code: "ig-code", state: stateOf(theirs) }, theirCookie)).location),
    ).toMatchObject({ connected: "@demo_cycling" });
    expect(
      backParams((await callback("instagram", { code: "ig-code", state: stateOf(mine) }, myCookie)).location),
    ).toMatchObject({ connected: "@demo_cycling" });
    expect(w.igCodes).toHaveLength(2);
  });

  it("refuses a flow started before the browser was kept (no browser_hash)", async () => {
    await call("/admin-api/oauth-apps/google", GOOGLE);
    const start = await call("/admin-api/connect/youtube/start", {});
    await env.DB.prepare("UPDATE oauth_states SET browser_hash = NULL").run();
    const r = await callback("youtube", { code: "g-code", state: stateOf(start) });
    expect(backParams(r.location).error).toMatch(/isn't valid.*start again/);
    expect(w.googleCodes).toEqual([]);
  });

  it("binds YouTube's flow too: without the cookie, Google's code isn't exchanged", async () => {
    await call("/admin-api/oauth-apps/google", GOOGLE);
    const start = await call("/admin-api/connect/youtube/start", {});
    expect(start.setCookies.find((x) => x.startsWith("bongsu_oauth="))).toContain(
      "Path=/admin-api/connect/youtube/callback;",
    );
    const mine = flows.get("/admin-api/connect/youtube/callback")!;
    w.googleChallenge = new URL(start.json.url as string).searchParams.get("code_challenge")!;
    const r = await callback("youtube", { code: "g-code", state: stateOf(start) }, null);
    expect(backParams(r.location).error).toMatch(/isn't valid/);
    expect(w.googleCodes).toEqual([]);
    const back = await callback("youtube", { code: "g-code", state: stateOf(start) }, mine);
    expect(backParams(back.location)).toMatchObject({ connected: "Our Channel" });
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

describe("connecting into the workspace the flow started from", () => {
  /** A user with `role` in workspace `b` (and nowhere else). */
  const member = async (id: string, role: string) => {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO workspaces (id, name, created_at) VALUES ('b', 'Workspace B', 0) ON CONFLICT (id) DO UPDATE SET archived_at = NULL",
      ),
      env.DB.prepare("INSERT INTO users (id, name, created_at) VALUES (?1, ?1, 0)").bind(id),
      env.DB.prepare("INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES ('b', ?1, ?2, 0)").bind(
        id,
        role,
      ),
    ]);
    return `bongsu_session=${await createSession(env.DB, Math.floor(Date.now() / 1000), { userId: id })}`;
  };
  /** The app's routes, signed in with `appCookie`. */
  const app = async (appCookie: string, path: string, body?: unknown) => {
    const r = await appRoutes(w.fetch, fake).request(
      `https://bongsu.test${path}`,
      {
        method: body === undefined ? "GET" : "POST",
        headers: { "Content-Type": "application/json", Cookie: appCookie },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      e,
    );
    keepCookies(r, false); // the same browser as the dashboard's: the flow's cookie goes to the dashboard's callback
    return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
  };
  const workspaceOf = (externalId: string) =>
    env.DB.prepare("SELECT workspace_id FROM accounts WHERE external_id = ?1")
      .bind(externalId)
      .first<string>("workspace_id");
  /** Starts YouTube from the app and has Google send the browser back. */
  const youtubeFromApp = async (appCookie: string, beforeCallback?: () => Promise<unknown>) => {
    const start = await app(appCookie, "/app-api/connect/youtube/start", {});
    expect(start.status).toBe(200);
    const url = new URL(start.json.url as string);
    w.googleChallenge = url.searchParams.get("code_challenge")!;
    await beforeCallback?.();
    return callback("youtube", { code: "g-code", state: url.searchParams.get("state")! });
  };

  it("connects a creator's YouTube channel from the app into their workspace and returns to the app", async () => {
    await call("/admin-api/oauth-apps/google", GOOGLE);
    const cara = await member("cara", "creator");
    const start = await app(cara, "/app-api/connect/youtube/start", {});
    expect(start.status).toBe(200);
    const url = new URL(start.json.url as string);
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    // the provider comes back to the one registered redirect URL, whichever app started
    expect(url.searchParams.get("redirect_uri")).toBe("https://bongsu.test/admin-api/connect/youtube/callback");
    w.googleChallenge = url.searchParams.get("code_challenge")!;

    const back = await callback("youtube", { code: "g-code", state: url.searchParams.get("state")! });
    expect(back.status).toBe(302);
    expect(back.location).toMatch(/^https:\/\/bongsu\.test\/#\/settings\?/);
    expect(Object.fromEntries(new URLSearchParams(back.location!.split("?")[1]))).toEqual({
      connected: "Our Channel",
      accounts: "1",
    });
    expect(await workspaceOf("UCours")).toBe("b");
    const conn = await env.DB.prepare(
      "SELECT c.workspace_id FROM connections c JOIN accounts a ON a.connection_id = c.id WHERE a.external_id = 'UCours'",
    ).first();
    expect(conn).toEqual({ workspace_id: "b" });
    const audit = await env.DB.prepare("SELECT user_id, workspace_id FROM audit WHERE action = 'connect'").first();
    expect(audit).toEqual({ user_id: "cara", workspace_id: "b" });

    // an app flow's error goes back to the app too, and its state is single use
    const again = await callback("youtube", { code: "g-code", state: url.searchParams.get("state")! });
    expect(again.location).toMatch(/^https:\/\/bongsu\.test\/dashboard\/connections\?error=/);
    const denied = await app(cara, "/app-api/connect/youtube/start", {});
    const s = new URL(denied.json.url as string).searchParams.get("state")!;
    const cancelled = await callback("youtube", { error: "access_denied", state: s });
    expect(cancelled.location).toMatch(/^https:\/\/bongsu\.test\/#\/settings\?error=/);
  });

  it("an app flow sets its cookie in the app's browser; a link opened elsewhere connects nothing", async () => {
    await call("/admin-api/oauth-apps/google", GOOGLE);
    const cara = await member("cara", "creator");
    const start = await app(cara, "/app-api/connect/youtube/start", {});
    const path = "/admin-api/connect/youtube/callback";
    const caraBrowser = flows.get(path)!;
    expect(caraBrowser).toMatch(/^bongsu_oauth=/);
    const url = new URL(start.json.url as string);
    w.googleChallenge = url.searchParams.get("code_challenge")!;
    // cara sends Google's link to someone else, who allows it in their browser
    const elsewhere = await callback("youtube", { code: "g-code", state: url.searchParams.get("state")! }, null);
    expect(backParams(elsewhere.location).error).toMatch(/isn't valid/);
    expect(w.googleCodes).toEqual([]);
    expect(await workspaceOf("UCours")).toBeNull();
    // in cara's own browser it finishes, back in the app
    const back = await callback("youtube", { code: "g-code", state: url.searchParams.get("state")! }, caraBrowser);
    expect(back.location).toMatch(/^https:\/\/bongsu\.test\/#\/settings\?connected=/);
    expect(await workspaceOf("UCours")).toBe("b");
  });

  it("refuses editors, in the app as in the dashboard", async () => {
    await call("/admin-api/oauth-apps/google", GOOGLE);
    const ed = await member("ed", "editor");
    expect((await app(ed, "/app-api/me")).json.connects).toBe(false);
    expect((await app(await member("cara", "creator"), "/app-api/me")).json.connects).toBe(true);
    const r = await app(ed, "/app-api/connect/youtube/start", {});
    expect(r.status).toBe(403);
    expect((await app(ed, "/app-api/connections")).status).toBe(403);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM oauth_states").first()).toEqual({ n: 0 });
  });

  it("lists the workspace's connections and which providers the instance's OAuth apps make ready", async () => {
    await call("/admin-api/oauth-apps/google", GOOGLE);
    const cara = await member("cara", "creator");
    let r = (await app(cara, "/app-api/connections")).json as {
      connections: unknown[];
      providers: { provider: string; ready: boolean }[];
    };
    expect(r.connections).toEqual([]); // the default workspace's aren't hers
    expect(r.providers).toEqual([
      expect.objectContaining({ provider: "instagram", ready: false }),
      expect.objectContaining({ provider: "youtube", ready: true }),
    ]);
    await youtubeFromApp(cara);
    r = (await app(cara, "/app-api/connections")).json as typeof r;
    expect(r.connections).toEqual([
      expect.objectContaining({ provider: "youtube", label: "Our Channel", status: "ok", accounts: ["ourchannel"] }),
    ]);
    // without the Meta app, starting Instagram says who has to add it
    const ig = await app(cara, "/app-api/connect/instagram/start", {});
    expect(ig.status).toBe(400);
    expect(ig.json.error).toMatch(/Meta app/);
  });

  it("reconnects only a connection of the caller's workspace", async () => {
    await call("/admin-api/oauth-apps/google", GOOGLE);
    const cara = await member("cara", "creator");
    // c_main is the default workspace's
    expect((await app(cara, "/app-api/connect/youtube/start", { reconnect: "c_main" })).status).toBe(400);
  });

  it("a dashboard flow lands in the session's workspace, not the user's first", async () => {
    await call("/admin-api/oauth-apps/google", GOOGLE);
    await member("x", "creator"); // makes workspace b
    await env.DB.prepare(
      "INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES ('b', ?1, 'admin', 1)",
    )
      .bind(me)
      .run();
    expect((await call("/admin-api/workspaces/b/open", {})).status).toBe(200);
    const url = new URL((await call("/admin-api/connect/youtube/start", {})).json.url as string);
    w.googleChallenge = url.searchParams.get("code_challenge")!;
    const back = await callback("youtube", { code: "g-code", state: url.searchParams.get("state")! });
    expect(back.location).toMatch(/^https:\/\/bongsu\.test\/dashboard\/connections\?connected=/);
    expect(await workspaceOf("UCours")).toBe("b");
  });

  it("an instance admin who is only an editor of the workspace connects there as its admin, in both apps", async () => {
    await call("/admin-api/oauth-apps/google", GOOGLE);
    await member("x", "creator"); // makes workspace b
    await env.DB.prepare(
      "INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES ('b', ?1, 'editor', 1)",
    )
      .bind(me)
      .run();
    expect((await call("/admin-api/workspaces/b/open", {})).status).toBe(200);
    expect((await call("/admin-api/state")).json).toMatchObject({ role: "admin", instanceAdmin: true });
    const url = new URL((await call("/admin-api/connect/youtube/start", {})).json.url as string);
    w.googleChallenge = url.searchParams.get("code_challenge")!;
    const back = await callback("youtube", { code: "g-code", state: url.searchParams.get("state")! });
    expect(back.location).toMatch(/^https:\/\/bongsu\.test\/dashboard\/connections\?connected=/);
    expect(await workspaceOf("UCours")).toBe("b");
    // the app: the same rights in the same workspace
    const token = await createSession(env.DB, Math.floor(Date.now() / 1000), { userId: me });
    await setSessionWorkspace(env.DB, token, "b");
    const ina = `bongsu_session=${token}`;
    expect((await app(ina, "/app-api/me")).json).toMatchObject({ connects: true });
    expect((await app(ina, "/app-api/connections")).status).toBe(200);
    expect((await youtubeFromApp(ina)).location).toMatch(/^https:\/\/bongsu\.test\/#\/settings\?connected=/);
  });

  it("refuses to finish into a workspace the user left, or that was archived, since the start", async () => {
    await call("/admin-api/oauth-apps/google", GOOGLE);
    const cara = await member("cara", "creator");
    const left = await youtubeFromApp(cara, () =>
      env.DB.prepare("DELETE FROM memberships WHERE user_id = 'cara'").run(),
    );
    expect(left.location).toMatch(/^https:\/\/bongsu\.test\/#\/settings\?error=/);
    expect(await workspaceOf("UCours")).toBeNull();
    expect(w.googleCodes).toHaveLength(0); // refused before the code was exchanged

    await env.DB.prepare(
      "INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES ('b', 'cara', 'creator', 0)",
    ).run();
    const archived = await youtubeFromApp(cara, () =>
      env.DB.prepare("UPDATE workspaces SET archived_at = 1 WHERE id = 'b'").run(),
    );
    expect(archived.location).toMatch(/^https:\/\/bongsu\.test\/#\/settings\?error=/);
    expect(await workspaceOf("UCours")).toBeNull();

    // demoted to editor in between: no longer someone who connects
    await env.DB.prepare("UPDATE workspaces SET archived_at = NULL WHERE id = 'b'").run();
    const demoted = await youtubeFromApp(cara, () =>
      env.DB.prepare("UPDATE memberships SET role = 'editor' WHERE user_id = 'cara'").run(),
    );
    expect(demoted.location).toMatch(/^https:\/\/bongsu\.test\/#\/settings\?error=/);
    expect(await workspaceOf("UCours")).toBeNull();
  });
});
