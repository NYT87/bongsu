// Which provider reaches an account: chosen by its connection (connections.provider). Each registration says how the
// provider is built for an account, how an account gets connected (ConnectSpec, for the dashboard and the docs) and,
// optionally, how its connections are kept alive (renewing tokens, checking grants: providers/refresh.ts runs it
// weekly). The tick, the comments inbox and the results only call providerFor.

import { type Account, type Connection, connectionSecret } from "../accounts";
import { refreshToken } from "../clients/google";
import { ANALYTICS_SCOPE } from "../clients/youtube";
import type { Env } from "../env";
import { instagramFor } from "./instagram";
import { composioGrant } from "./instagram-composio";
import { exchangeInstagramCode, instagramGrant, parseGraphCredentials, refreshGraphToken } from "./instagram-graph";
import { InstagramProvider } from "./instagram-publish";
import {
  ConnectionBroken,
  type ConnectSpec,
  type Grant,
  type KeptAlive,
  type OAuthContext,
  type Provider,
} from "./types";
import { exchangeGoogleCode, revokeGoogle, YouTubeProvider } from "./youtube";

/** Builds the provider for an account whose connection it handles; null when that account can't be reached. */
export type ProviderFactory = (env: Env, fetcher: typeof fetch, a: Account) => Promise<Provider | null>;
/** Renews or checks one connection; throws when it doesn't work (ConnectionBroken: not until it's reconnected). */
export type KeepAlive = (
  env: Env,
  fetcher: typeof fetch,
  c: Connection,
  nowS: number,
) => Promise<KeptAlive | undefined>;

export interface ProviderRegistration {
  factory: ProviderFactory;
  connect: ConnectSpec;
  /** The OAuth code (and the PKCE verifier, when the spec asks for PKCE) → the grant (connect.kind "oauth2"). */
  exchange?: (
    fetcher: typeof fetch,
    app: OAuthContext,
    code: string,
    verifier: string | null,
    nowS: number,
  ) => Promise<Grant>;
  /** A pasted value → the grant: a long-lived token (connect.pasteToken) or a Composio connected-account id. */
  paste?: (env: Env, fetcher: typeof fetch, value: string, nowS: number) => Promise<Grant>;
  /** Ends the grant at the provider when the connection is removed (best effort; absent where it can't be done). */
  revoke?: (fetcher: typeof fetch, credentials: string) => Promise<void>;
  keepAlive?: KeepAlive;
  /** How often keepAlive runs (default weekly). */
  keepAliveEveryS?: number;
}

const registry = new Map<string, ProviderRegistration>();

/** connections.provider → its registration (a later one replaces an earlier one). */
export function registerProvider(connectionProvider: string, r: ProviderRegistration) {
  registry.set(connectionProvider, r);
}
export const providerRegistration = (connectionProvider: string) => registry.get(connectionProvider) ?? null;
/** Every registered way to connect, by connections.provider value. */
export const connectSpecs = () => [...registry].map(([provider, r]) => ({ provider, ...r.connect }));

const instagramFactory: ProviderFactory = async (env, fetcher, a) => {
  if (a.platform !== "instagram") return null;
  const ig = await instagramFor(env, fetcher, a);
  return ig ? new InstagramProvider(ig) : null;
};

const IG_SCOPES = [
  "instagram_business_basic",
  "instagram_business_content_publish",
  "instagram_business_manage_comments",
  "instagram_business_manage_insights",
];

registerProvider("instagram", {
  factory: instagramFactory,
  connect: {
    kind: "oauth2",
    label: "Instagram (Instagram Login)",
    platform: "instagram",
    app: "meta",
    authorizeUrl: "https://www.instagram.com/oauth/authorize",
    tokenUrl: "https://api.instagram.com/oauth/access_token",
    scopes: IG_SCOPES,
    scopeSeparator: ",",
    authorizeParams: { force_reauth: "true" }, // lets a reconnect pick the account again
    pasteToken: true,
    docs: "site/docs/instagram-graph.md",
  },
  exchange: (fetcher, app, code, _verifier, nowS) => exchangeInstagramCode(fetcher, app, code, nowS),
  paste: (_env, fetcher, value) => {
    const creds = parseGraphCredentials(value);
    if (!creds) throw new Error("paste the account's long-lived token");
    return instagramGrant(fetcher, creds);
  },
  // A long-lived token lasts 60 days and can be renewed once it's a day old; the renewed one is kept encrypted.
  keepAlive: async (env, fetcher, c, nowS) => {
    const creds = parseGraphCredentials(await connectionSecret(env, c));
    if (!creds) throw new ConnectionBroken("no token");
    if (!env.ENCRYPTION_KEY) throw new Error("ENCRYPTION_KEY isn't set, so a renewed token can't be stored");
    const fresh = await refreshGraphToken(fetcher, creds.access_token, nowS);
    return { credentials: JSON.stringify(fresh), expiresAt: fresh.expires_at };
  },
});

registerProvider("composio", {
  factory: instagramFactory,
  connect: {
    kind: "composio",
    label: "Instagram (through Composio)",
    platform: "instagram",
    docs: "site/docs/instagram-composio.md",
  },
  paste: (env, fetcher, value) => {
    if (!env.COMPOSIO_CONSUMER_KEY) throw new Error("COMPOSIO_CONSUMER_KEY isn't set on the Worker");
    if (!/^[\w-]{4,80}$/.test(value.trim())) throw new Error("paste the Composio connected-account id (ca_…)");
    return composioGrant(env.COMPOSIO_CONSUMER_KEY, value.trim(), fetcher);
  },
});

registerProvider("youtube", {
  factory: async (env, fetcher, a) => {
    const oauth = await connectionSecret(env, a.connection);
    return oauth ? new YouTubeProvider(oauth, fetcher) : null;
  },
  connect: {
    kind: "oauth2",
    label: "YouTube channel",
    platform: "youtube",
    app: "google",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: ["https://www.googleapis.com/auth/youtube.force-ssl", ANALYTICS_SCOPE],
    pkce: true,
    // a refresh token every time (prompt=consent), so a reconnect gets a new one too
    authorizeParams: { access_type: "offline", prompt: "consent", include_granted_scopes: "true" },
    docs: "site/docs/youtube.md",
  },
  exchange: (fetcher, app, code, verifier) => exchangeGoogleCode(fetcher, app, code, verifier),
  revoke: revokeGoogle,
  // The refresh token doesn't change; checking it weekly catches a revoked grant (or a Google app still in testing,
  // whose tokens expire after 7 days) before a Shorts comment fails.
  keepAlive: async (env, fetcher, c, nowS) => {
    const oauth = await connectionSecret(env, c);
    if (!oauth) throw new ConnectionBroken("no OAuth credentials");
    try {
      await refreshToken(oauth, fetcher, nowS * 1000, true);
    } catch (e) {
      const msg = (e as Error).message;
      throw /invalid_grant/.test(msg)
        ? new ConnectionBroken(`Google refused the refresh token (${msg.slice(0, 120)})`)
        : e;
    }
    return undefined;
  },
});

/** The provider that reaches an account, or null when it isn't connected (or its connection is broken). */
export async function providerFor(env: Env, fetcher: typeof fetch, a: Account): Promise<Provider | null> {
  if (!a.connection || a.connection.status === "broken") return null;
  const r = registry.get(a.connection.provider);
  return r ? r.factory(env, fetcher, a) : null;
}
