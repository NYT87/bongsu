// Connecting accounts (the dashboard's Connect flows, Phase 4b; docs/PLAN.md D9, D10). The owner brings their own
// OAuth apps (oauth_apps: one Meta app for Instagram, one Google app for YouTube), each flow keeps its `state` and PKCE
// verifier server side (oauth_states, single use), and a finished flow's grant becomes a connection (credentials
// encrypted with ENCRYPTION_KEY) plus the accounts it reaches: existing rows are found again by their platform id, so a
// reconnect keeps each account's plan and settings. Providers only supply the exchange (providers/index.ts).
import { listAccounts } from "./accounts";
import { decryptSecret, encryptSecret } from "./crypto";
import type { Db, DbStatement } from "./db";
import type { Env } from "./env";
import { sha256Hex } from "./formats/approved";
import { connectSpecs, providerRegistration } from "./providers/index";
import type { ConnectSpec, Grant } from "./providers/types";
import { mayConnect } from "./roles";
import { sessionWorkspace } from "./workspaces";

/** How long a started flow stays usable. */
export const STATE_S = 15 * 60;

/** Where a flow's callback sends the browser back: the dashboard's Connections page, or the app's Settings. */
export type ConnectBack = "dashboard" | "app";

/** A flow that can't go on. `back` is where it started, once the state says so (an unknown state doesn't). */
export class ConnectError extends Error {
  constructor(
    message: string,
    readonly back?: ConnectBack,
    /**
     * "browser": the state is unknown or used, the flow's cookie is missing or doesn't match, or the flow was started
     * before its browser was kept (no browser_hash, from before migration 0020). Those are one condition on purpose:
     * telling them apart would let a caller without the cookie probe whether a state exists.
     * It only tells the app to suggest the phone's own browser.
     */
    readonly hint?: "browser",
  ) {
    super(message);
  }
}

// A flow started in the app keeps "<provider>@app" as its name (oauth_states.provider): the callback is the same URL
// either way (the one registered in the OAuth app), and only the way back differs.
const APP_FLOW = "@app";

const b64url = (b: Uint8Array) =>
  btoa(String.fromCharCode(...b))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const random = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));

/** Where a provider sends the browser back: register exactly this in the OAuth app. */
export const redirectUri = (publicUrl: string, provider: string) =>
  `${publicUrl.replace(/\/$/, "")}/admin-api/connect/${provider}/callback`;

/** Where Google sends the browser back after Connect Google Drive (the media store; media/manage.ts). */
export const driveRedirectUri = (publicUrl: string) =>
  `${publicUrl.replace(/\/$/, "")}/admin-api/media-stores/drive/callback`;

/** The path a flow's browser cookie is sent to: exactly its callback (the redirect URL's path). */
export const callbackPath = (redirect: string) => new URL(redirect).pathname;

/** The callback path of a provider's connect flow; null for a name no provider has (no cookie was set for it). */
export const connectCallbackPath = (publicUrl: string, provider: string) =>
  providerRegistration(provider)?.connect ? callbackPath(redirectUri(publicUrl, provider)) : null;

/** A started flow: the URL to send the browser to, and the random value to keep in that browser's cookie (sent only to
 *  `cookiePath`, the callback) so that only the browser that started the flow can finish it. */
export interface StartedFlow {
  url: string;
  browser: string;
  cookiePath: string;
}

// ---- OAuth apps

/** Each OAuth app the registered providers use, whether it's set, and the redirect URLs to register in it. */
export async function oauthApps(db: Db, publicUrl: string) {
  const rows = await db
    .prepare("SELECT id, client_id, updated_at FROM oauth_apps")
    .all<{ id: string; client_id: string; updated_at: number }>();
  const apps = new Map<string, { providers: { provider: string; label: string; redirectUri: string }[] }>();
  for (const s of connectSpecs()) {
    if (!s.app) continue;
    const a = apps.get(s.app) ?? { providers: [] };
    a.providers.push({ provider: s.provider, label: s.label, redirectUri: redirectUri(publicUrl, s.provider) });
    apps.set(s.app, a);
  }
  // the Google app also connects Drive, the media store
  apps.get("google")?.providers.push({
    provider: "drive",
    label: "Google Drive (media store)",
    redirectUri: driveRedirectUri(publicUrl),
  });
  return [...apps].map(([id, a]) => {
    const row = rows.results.find((r) => r.id === id);
    return { id, ...a, clientId: row?.client_id ?? null, updatedAt: row?.updated_at ?? null };
  });
}

export async function saveOAuthApp(
  env: Env,
  id: string,
  clientId: string,
  clientSecret: string,
  userId: string,
  nowS: number,
) {
  if (!connectSpecs().some((s) => s.app === id)) throw new ConnectError(`no provider uses an app called ${id}`);
  if (!clientId.trim() || !clientSecret.trim()) throw new ConnectError("paste both the client id and the secret");
  await env.DB.prepare(
    `INSERT INTO oauth_apps (id, client_id, client_secret, updated_at, updated_by) VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT (id) DO UPDATE SET client_id = excluded.client_id, client_secret = excluded.client_secret,
       updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
  )
    .bind(id, clientId.trim(), await encryptSecret(env.ENCRYPTION_KEY, clientSecret.trim()), nowS, userId)
    .run();
}

export const removeOAuthApp = (db: Db, id: string) => db.prepare("DELETE FROM oauth_apps WHERE id = ?1").bind(id).run();

/** The owner's OAuth app (oauth_apps), decrypted, with the redirect URL a flow sends Google or Meta back to. */
export async function oauthApp(env: Env, appId: string, redirect: string) {
  const row = await env.DB.prepare("SELECT client_id, client_secret FROM oauth_apps WHERE id = ?1")
    .bind(appId)
    .first<{ client_id: string; client_secret: string }>();
  if (!row)
    throw new ConnectError(
      `add your ${appId === "meta" ? "Meta" : appId === "google" ? "Google" : appId} app first (OAuth apps)`,
    );
  return {
    clientId: row.client_id,
    clientSecret: await decryptSecret(env.ENCRYPTION_KEY, row.client_secret),
    redirectUri: redirect,
  };
}

async function appFor(env: Env, provider: string) {
  const spec = providerRegistration(provider)?.connect;
  if (!spec?.app) throw new ConnectError(`${provider} doesn't connect through an OAuth app`);
  return oauthApp(env, spec.app, redirectUri(env.PUBLIC_URL, provider));
}

// ---- the flow

/** Starts an OAuth flow: the URL to send the browser to and its browser cookie. `reconnect` names the connection it
 *  renews; the callback saves the connection in `workspaceId` and sends the browser `back` to where it started. */
export async function startConnect(
  env: Env,
  provider: string,
  o: { userId: string; workspaceId: string; back: ConnectBack; reconnect?: string | null; nowS: number },
): Promise<StartedFlow> {
  const reg = providerRegistration(provider);
  const spec = reg?.connect;
  if (!reg?.exchange || !spec?.authorizeUrl) throw new ConnectError(`${provider} has no authorization flow`);
  const app = await appFor(env, provider);
  if (o.reconnect) {
    const c = await env.DB.prepare("SELECT provider FROM connections WHERE id = ?1 AND workspace_id = ?2")
      .bind(o.reconnect, o.workspaceId)
      .first<{ provider: string }>();
    if (c?.provider !== provider) throw new ConnectError("no such connection to reconnect");
  }
  return authorizeUrl(env, spec, app, {
    flow: o.back === "app" ? `${provider}${APP_FLOW}` : provider,
    userId: o.userId,
    workspaceId: o.workspaceId,
    connectionId: o.reconnect ?? null,
    nowS: o.nowS,
  });
}

/** Starts any OAuth flow: keeps its state (hashed), its PKCE verifier and the hash of the starting browser's cookie,
 *  single use, for STATE_S; returns the URL to send the browser to and the cookie's value and path. `flow` names what
 *  the callback finishes (a provider, or "media:drive"); `workspaceId` is where it connects into (null: the instance,
 *  as Drive). */
export async function authorizeUrl(
  env: Env,
  spec: Pick<ConnectSpec, "authorizeUrl" | "scopes" | "scopeSeparator" | "pkce" | "authorizeParams">,
  app: { clientId: string; redirectUri: string },
  o: { flow: string; userId: string; workspaceId: string | null; connectionId: string | null; nowS: number },
): Promise<StartedFlow> {
  await env.DB.prepare("DELETE FROM oauth_states WHERE expires_at < ?1").bind(o.nowS).run(); // flows never finished
  const state = random();
  const verifier = spec.pkce ? random(48) : null;
  // The state alone would let anyone finish the flow: a provider link sent to someone else would connect their account
  // into the sender's workspace. The callback also wants this value back from the starting browser's cookie.
  const browser = random();
  await env.DB.prepare(
    `INSERT INTO oauth_states (state_hash, provider, user_id, workspace_id, verifier, connection_id, created_at,
       expires_at, browser_hash)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  )
    .bind(
      await sha256Hex(state),
      o.flow,
      o.userId,
      o.workspaceId,
      verifier,
      o.connectionId,
      o.nowS,
      o.nowS + STATE_S,
      await sha256Hex(browser),
    )
    .run();
  const url = new URL(spec.authorizeUrl ?? "");
  url.searchParams.set("client_id", app.clientId);
  url.searchParams.set("redirect_uri", app.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", (spec.scopes ?? []).join(spec.scopeSeparator ?? " "));
  url.searchParams.set("state", state);
  if (verifier) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    url.searchParams.set("code_challenge", b64url(new Uint8Array(digest)));
    url.searchParams.set("code_challenge_method", "S256");
  }
  for (const [k, v] of Object.entries(spec.authorizeParams ?? {})) url.searchParams.set(k, v);
  return { url: url.toString(), browser, cookiePath: callbackPath(app.redirectUri) };
}

/** What a provider sends back to a callback. */
export interface CallbackQuery {
  code?: string | null;
  state?: string | null;
  error?: string | null;
  errorDescription?: string | null;
}

// Compares two hashes without returning early on the first difference.
function sameHash(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const INVALID = "this sign-in link isn't valid (or was used already, or opened in another browser): start again";

/** The callback's checks: the state is this flow's, unused and in time, came back to the browser that started it
 *  (`browser`: its cookie), and a code came instead of an error. Uses the state up; returns who started the flow and
 *  where (the workspace, the app it goes back to), the PKCE verifier and the code. The flow started in the dashboard or
 *  the app: either is this flow's. */
export async function takeState(env: Env, flow: string, q: CallbackQuery, browser: string | null, nowS: number) {
  if (!q.state) throw new ConnectError("the provider sent no state: start again from the dashboard");
  const stateHash = await sha256Hex(q.state);
  // The browser first, before the state is used up: another browser (or none) leaves it to the one that started it.
  // A flow started before browser_hash existed (NULL) can't be checked, so it's refused too.
  const pending = await env.DB.prepare(
    "SELECT browser_hash FROM oauth_states WHERE state_hash = ?1 AND used_at IS NULL",
  )
    .bind(stateHash)
    .first<{ browser_hash: string | null }>();
  if (!pending?.browser_hash || !browser || !sameHash(await sha256Hex(browser), pending.browser_hash))
    throw new ConnectError(INVALID, undefined, "browser");
  const st = await env.DB.prepare(
    `UPDATE oauth_states SET used_at = ?1 WHERE state_hash = ?2 AND used_at IS NULL
     RETURNING provider, user_id, workspace_id, verifier, connection_id, expires_at`,
  )
    .bind(nowS, stateHash)
    .first<{
      provider: string;
      user_id: string;
      workspace_id: string | null;
      verifier: string | null;
      connection_id: string | null;
      expires_at: number;
    }>();
  if (!st || (st.provider !== flow && st.provider !== `${flow}${APP_FLOW}`)) throw new ConnectError(INVALID);
  const back: ConnectBack = st.provider === flow ? "dashboard" : "app";
  if (st.expires_at < nowS) throw new ConnectError("that took too long: start again", back);
  if (q.error)
    throw new ConnectError(
      q.error === "access_denied"
        ? "you cancelled, or didn't allow access"
        : `${flow}: ${q.errorDescription ?? q.error}`,
      back,
    );
  if (!q.code) throw new ConnectError("the provider sent no code", back);
  return {
    userId: st.user_id,
    workspaceId: st.workspace_id,
    back,
    verifier: st.verifier,
    connectionId: st.connection_id,
    code: q.code,
  };
}

/** The provider's redirect back: checks the state (this provider's, unused, in time, back in the browser that started
 *  it: `browser` is its cookie), exchanges the code and saves the grant in the workspace the flow was started from, if
 *  the user who started it may still connect there (a member as an admin or a creator, or an instance admin, and the
 *  workspace not archived). `error` is what the provider sent instead of a code (the person cancelled, the app was
 *  refused). A failure past the state says where to go `back`. */
export async function finishConnect(
  env: Env,
  fetcher: typeof fetch,
  provider: string,
  q: CallbackQuery,
  browser: string | null,
  nowS: number,
) {
  const st = await takeState(env, provider, q, browser, nowS);
  try {
    const where = st.workspaceId
      ? await sessionWorkspace(env.DB, { userId: st.userId, workspaceId: st.workspaceId })
      : null;
    // sessionWorkspace falls back to the user's first workspace: only the one the flow started from will do
    if (!where || where.workspaceId !== st.workspaceId || !mayConnect(where.role))
      throw new ConnectError("you can't connect accounts in that workspace any more (or it was archived)");
    const workspaceId = where.workspaceId;
    const reg = providerRegistration(provider)!;
    const grant = await reg.exchange!(fetcher, await appFor(env, provider), st.code, st.verifier, nowS);
    return {
      userId: st.userId,
      workspaceId,
      back: st.back,
      ...(await saveGrant(env, provider, grant, nowS, st.connectionId, workspaceId)),
    };
  } catch (e) {
    throw new ConnectError((e as Error).message, st.back);
  }
}

/** A pasted token or Composio connected-account id → a connection. */
export async function pasteConnect(
  env: Env,
  fetcher: typeof fetch,
  provider: string,
  value: string,
  nowS: number,
  workspaceId: string,
) {
  const reg = providerRegistration(provider);
  if (!reg?.paste) throw new ConnectError(`${provider} can't be connected by pasting`);
  return saveGrant(env, provider, await reg.paste(env, fetcher, value.trim(), nowS), nowS, null, workspaceId);
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "account";

/** Stores a grant as a connection of the workspace (a new one, or `reconnect`'s, or the one already reaching the same
 *  accounts) and creates or updates the accounts it reaches. */
export async function saveGrant(
  env: Env,
  provider: string,
  g: Grant,
  nowS: number,
  reconnect: string | null,
  ws: string,
) {
  if (!g.accounts.length) throw new ConnectError("the grant reaches no account");
  const db = env.DB;
  const existing = await listAccounts(db, { workspaceId: ws, all: true });
  // An account is found again by its platform id; one set up without it (by hand, from secrets) by its handle, or as
  // the account of the connection being reconnected.
  const match = (d: Grant["accounts"][number]) =>
    existing.find((a) => a.platform === d.platform && a.externalId === d.externalId) ??
    existing.find((a) => a.platform === d.platform && a.handle === d.handle && !a.externalId) ??
    (reconnect
      ? existing.find((a) => a.connection?.id === reconnect && a.platform === d.platform && !a.externalId)
      : undefined);
  // Connecting an account that's already connected the same way renews that connection rather than adding another.
  const same = g.accounts.map(match).find((a) => a?.connection?.provider === provider)?.connection?.id;
  const id =
    reconnect ??
    same ??
    `c_${provider}_${random(6)
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "")}`;
  const credentials = g.credentials === null ? null : await encryptSecret(env.ENCRYPTION_KEY, g.credentials);
  const kind = provider === "composio" ? "composio" : "oauth";
  // the connection and its accounts in one transaction: a refused account leaves no half-saved grant
  const writes: DbStatement[] = [];
  writes.push(
    db
      .prepare(
        `INSERT INTO connections (id, workspace_id, provider, kind, label, external_ref, credentials, secret_name, status,
         expires_at, last_error, last_checked_at, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, 'ok', ?8, NULL, ?9, ?9, ?9)
       ON CONFLICT (id) DO UPDATE SET provider = excluded.provider, kind = excluded.kind, label = excluded.label,
         external_ref = excluded.external_ref, credentials = excluded.credentials, secret_name = NULL, status = 'ok',
         expires_at = excluded.expires_at, last_error = NULL, last_checked_at = excluded.last_checked_at,
         updated_at = excluded.updated_at`,
      )
      .bind(id, ws, provider, kind, g.label, g.externalRef ?? null, credentials, g.expiresAt ?? null, nowS),
  );
  // an account's id is unique across the instance (accounts.id), not only the workspace
  const taken = new Set((await db.prepare("SELECT id FROM accounts").all<{ id: string }>()).results.map((r) => r.id));
  const accounts: { id: string; handle: string; created: boolean }[] = [];
  for (const d of g.accounts) {
    const a = match(d);
    if (a) {
      writes.push(
        db
          .prepare(
            `UPDATE accounts SET handle = ?1, display_name = COALESCE(?2, display_name), external_id = ?3,
             connection_id = ?4, capabilities = ?5, updated_at = ?6 WHERE id = ?7`,
          )
          .bind(
            d.handle,
            d.displayName ?? null,
            d.externalId,
            id,
            JSON.stringify({ ...a.capabilities, ...d.capabilities }),
            nowS,
            a.id,
          ),
      );
      accounts.push({ id: a.id, handle: d.handle, created: false });
      continue;
    }
    let aid = slug(d.handle);
    if (taken.has(aid)) aid = `${aid}-${d.platform}`;
    for (let n = 2; taken.has(aid); n++) aid = `${slug(d.handle)}-${n}`;
    taken.add(aid);
    writes.push(
      db
        .prepare(
          `INSERT INTO accounts (id, workspace_id, platform, handle, display_name, external_id, connection_id, capabilities,
           settings, sort, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, '{}', ?9, ?10, ?10)`,
        )
        .bind(
          aid,
          ws,
          d.platform,
          d.handle,
          d.displayName ?? null,
          d.externalId,
          id,
          JSON.stringify(d.capabilities ?? {}),
          existing.length + accounts.length,
          nowS,
        ),
    );
    accounts.push({ id: aid, handle: d.handle, created: true });
  }
  await db.batch(writes);
  return { connectionId: id, label: g.label, accounts };
}

/** Removes a connection: its accounts stay (with their plans) but can't publish until connected again; the grant is
 *  revoked at the provider where it allows that. */
export async function removeConnection(env: Env, fetcher: typeof fetch, id: string, workspaceId: string) {
  const c = await env.DB.prepare(
    "SELECT provider, label, credentials FROM connections WHERE id = ?1 AND workspace_id = ?2",
  )
    .bind(id, workspaceId)
    .first<{ provider: string; label: string | null; credentials: string | null }>();
  if (!c) throw new ConnectError("no such connection");
  const revoke = providerRegistration(c.provider)?.revoke;
  let revoked = false;
  if (revoke && c.credentials) {
    try {
      await revoke(fetcher, await decryptSecret(env.ENCRYPTION_KEY, c.credentials));
      revoked = true;
    } catch {
      // best effort: the connection goes either way
    }
  }
  await env.DB.prepare("UPDATE accounts SET connection_id = NULL WHERE connection_id = ?1").bind(id).run();
  await env.DB.prepare("DELETE FROM connections WHERE id = ?1").bind(id).run();
  return { label: c.label, revoked };
}
