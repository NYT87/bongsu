// Connecting accounts (the dashboard's Connect flows, Phase 4b; docs/PLAN.md D9, D10). The owner brings their own
// OAuth apps (oauth_apps: one Meta app for Instagram, one Google app for YouTube), each flow keeps its `state` and PKCE
// verifier server side (oauth_states, single use), and a finished flow's grant becomes a connection (credentials
// encrypted with ENCRYPTION_KEY) plus the accounts it reaches: existing rows are found again by their platform id, so a
// reconnect keeps each account's plan and settings. Providers only supply the exchange (providers/index.ts).
import { DEFAULT_WORKSPACE, listAccounts } from "./accounts";
import { decryptSecret, encryptSecret } from "./crypto";
import type { Db, DbStatement } from "./db";
import type { Env } from "./env";
import { sha256Hex } from "./formats/approved";
import { connectSpecs, providerRegistration } from "./providers/index";
import type { Grant } from "./providers/types";
import { userWorkspace } from "./workspaces";

/** How long a started flow stays usable. */
export const STATE_S = 15 * 60;

export class ConnectError extends Error {}

const b64url = (b: Uint8Array) =>
  btoa(String.fromCharCode(...b))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const random = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));

/** Where a provider sends the browser back: register exactly this in the OAuth app. */
export const redirectUri = (publicUrl: string, provider: string) =>
  `${publicUrl.replace(/\/$/, "")}/admin-api/connect/${provider}/callback`;

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

async function appFor(env: Env, provider: string) {
  const spec = providerRegistration(provider)?.connect;
  if (!spec?.app) throw new ConnectError(`${provider} doesn't connect through an OAuth app`);
  const row = await env.DB.prepare("SELECT client_id, client_secret FROM oauth_apps WHERE id = ?1")
    .bind(spec.app)
    .first<{ client_id: string; client_secret: string }>();
  if (!row)
    throw new ConnectError(
      `add your ${spec.app === "meta" ? "Meta" : spec.app === "google" ? "Google" : spec.app} app first (OAuth apps)`,
    );
  return {
    clientId: row.client_id,
    clientSecret: await decryptSecret(env.ENCRYPTION_KEY, row.client_secret),
    redirectUri: redirectUri(env.PUBLIC_URL, provider),
  };
}

// ---- the flow

/** Starts an OAuth flow: the URL to send the browser to. `reconnect` names the connection it renews. */
export async function startConnect(
  env: Env,
  provider: string,
  o: { userId: string; workspaceId: string; reconnect?: string | null; nowS: number },
) {
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
  await env.DB.prepare("DELETE FROM oauth_states WHERE expires_at < ?1").bind(o.nowS).run(); // flows never finished
  const state = random();
  const verifier = spec.pkce ? random(48) : null;
  await env.DB.prepare(
    `INSERT INTO oauth_states (state_hash, provider, user_id, verifier, connection_id, created_at, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  )
    .bind(await sha256Hex(state), provider, o.userId, verifier, o.reconnect ?? null, o.nowS, o.nowS + STATE_S)
    .run();
  const url = new URL(spec.authorizeUrl);
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
  return url.toString();
}

/** The provider's redirect back: checks the state (this provider's, unused, in time), exchanges the code and saves
 *  the grant in the workspace of the user who started the flow. `error` is what the provider sent instead of a code
 *  (the owner cancelled, the app was refused). */
export async function finishConnect(
  env: Env,
  fetcher: typeof fetch,
  provider: string,
  q: { code?: string | null; state?: string | null; error?: string | null; errorDescription?: string | null },
  nowS: number,
) {
  if (!q.state) throw new ConnectError("the provider sent no state: start again from the dashboard");
  const st = await env.DB.prepare(
    `UPDATE oauth_states SET used_at = ?1 WHERE state_hash = ?2 AND used_at IS NULL
     RETURNING provider, user_id, verifier, connection_id, expires_at`,
  )
    .bind(nowS, await sha256Hex(q.state))
    .first<{
      provider: string;
      user_id: string;
      verifier: string | null;
      connection_id: string | null;
      expires_at: number;
    }>();
  if (!st || st.provider !== provider)
    throw new ConnectError("this sign-in link isn't valid (or was used already): start again");
  if (st.expires_at < nowS) throw new ConnectError("that took too long: start again");
  if (q.error)
    throw new ConnectError(
      q.error === "access_denied"
        ? "you cancelled, or didn't allow access"
        : `${provider}: ${q.errorDescription ?? q.error}`,
    );
  if (!q.code) throw new ConnectError("the provider sent no code");
  const reg = providerRegistration(provider)!;
  const workspaceId = await userWorkspace(env.DB, st.user_id);
  if (!workspaceId) throw new ConnectError("the user who started this belongs to no workspace");
  const grant = await reg.exchange!(fetcher, await appFor(env, provider), q.code, st.verifier, nowS);
  return {
    userId: st.user_id,
    workspaceId,
    ...(await saveGrant(env, provider, grant, nowS, st.connection_id, workspaceId)),
  };
}

/** A pasted token or Composio connected-account id → a connection. */
export async function pasteConnect(
  env: Env,
  fetcher: typeof fetch,
  provider: string,
  value: string,
  nowS: number,
  workspaceId = DEFAULT_WORKSPACE,
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
  ws = DEFAULT_WORKSPACE,
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
export async function removeConnection(env: Env, fetcher: typeof fetch, id: string, workspaceId = DEFAULT_WORKSPACE) {
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
