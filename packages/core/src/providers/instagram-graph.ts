// Instagram through its own API ("Instagram API with Instagram Login", graph.instagram.com), with the account's
// long-lived token: no third party in between, and trial_params is a plain field, so Trial Reels work for every account.
// A long-lived token lasts 60 days; refreshConnections (providers/refresh.ts) renews it weekly from the inbox cron.
// site/docs/instagram-graph.md: creating the Meta app and getting the first token.
import { type ContainerParams, type IgComment, type InstagramApi, InstagramError } from "./instagram";
import type { Grant, OAuthContext } from "./types";

export const GRAPH = "https://graph.instagram.com/v23.0";
const REFRESH = "https://graph.instagram.com/refresh_access_token";

/** The connection's credentials: {"access_token": "...", "expires_at": <unix>} as the refresh stores them, or a bare
 *  token (a secret set by hand). */
export interface GraphCredentials {
  access_token: string;
  /** Unix seconds; absent when unknown (a token pasted as a secret). */
  expires_at?: number;
}

export function parseGraphCredentials(raw: string | null): GraphCredentials | null {
  const s = raw?.trim();
  if (!s) return null;
  if (s.startsWith("{")) {
    try {
      const j = JSON.parse(s) as GraphCredentials;
      return typeof j.access_token === "string" && j.access_token ? j : null;
    } catch {
      return null;
    }
  }
  return { access_token: s };
}
export const graphToken = (raw: string | null) => parseGraphCredentials(raw)?.access_token ?? null;

interface GraphError {
  error?: { message?: string; error_user_msg?: string; code?: number; error_subcode?: number };
}

async function call<T>(
  fetcher: typeof fetch,
  token: string,
  method: "GET" | "POST",
  path: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  const url = new URL(path.startsWith("http") ? path : `${GRAPH}/${path.replace(/^\//, "")}`);
  let init: RequestInit = { method };
  if (method === "GET") {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  } else {
    init = { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(params) };
  }
  url.searchParams.set("access_token", token);
  const r = await fetcher(url.toString(), init);
  const j = (await r.json().catch(() => ({}))) as T & GraphError;
  if (!r.ok || j.error) {
    const e = j.error;
    const what = `${method} ${url.pathname.replace(/^\/v[\d.]+/, "")}`;
    throw new InstagramError(
      `Instagram ${what}: ${e?.error_user_msg || e?.message || `HTTP ${r.status}`}`.slice(0, 300),
    );
  }
  return j;
}

export class GraphInstagram implements InstagramApi {
  readonly id = "instagram-graph";
  readonly trialNote = null;

  constructor(
    private token: string,
    private igUserId: string,
    private fetcher: typeof fetch,
  ) {}

  private get<T>(path: string, params: Record<string, unknown> = {}) {
    return call<T>(this.fetcher, this.token, "GET", path, params);
  }
  private post<T>(path: string, params: Record<string, unknown> = {}) {
    return call<T>(this.fetcher, this.token, "POST", path, params);
  }

  async createContainer(p: ContainerParams) {
    const params: Record<string, unknown> = { ...p };
    if (p.children) params.children = p.children.join(","); // a comma-separated list, as the API documents it
    const r = await this.post<{ id?: string }>(`${this.igUserId}/media`, params);
    if (!r.id) throw new InstagramError("Instagram returned no container id");
    return r.id;
  }

  async status(containerId: string) {
    return (await this.get<{ status_code?: string }>(containerId, { fields: "status_code" })).status_code ?? "UNKNOWN";
  }

  async publish(containerId: string) {
    const r = await this.post<{ id?: string }>(`${this.igUserId}/media_publish`, { creation_id: containerId });
    if (!r.id) throw new Error(`publish returned no media id: ${JSON.stringify(r).slice(0, 200)}`);
    return r.id;
  }

  media(mediaId: string) {
    return this.get<{ permalink?: string; timestamp?: string }>(mediaId, { fields: "id,permalink,timestamp" });
  }

  async comment(mediaId: string, text: string) {
    await this.post(`${mediaId}/comments`, { message: text });
  }

  async reply(commentId: string, text: string) {
    await this.post(`${commentId}/replies`, { message: text });
  }

  async comments(mediaId: string): Promise<IgComment[]> {
    return (
      (await this.get<{ data?: IgComment[] }>(`${mediaId}/comments`, { fields: "id,text,username,timestamp" })).data ??
      []
    );
  }

  async insights(mediaId: string, metrics: string[]) {
    const d = await this.get<{ data?: { name: string; values?: { value: number }[] }[] }>(`${mediaId}/insights`, {
      metric: metrics.join(","),
    });
    return Object.fromEntries((d.data ?? []).map((x) => [x.name, x.values?.[0]?.value ?? null]));
  }

  async verify() {
    const d = await this.get<{ user_id?: string; id?: string; username?: string; followers_count?: number }>("me", {
      fields: "user_id,username,followers_count",
    });
    return { id: d.user_id ?? d.id ?? "", username: d.username ?? "", followers: d.followers_count ?? null };
  }
}

/** A fresh long-lived token for one at least a day old (Instagram refuses younger ones); valid 60 days from now. */
export async function refreshGraphToken(fetcher: typeof fetch, token: string, nowS: number): Promise<GraphCredentials> {
  const r = await call<{ access_token?: string; expires_in?: number }>(fetcher, token, "GET", REFRESH, {
    grant_type: "ig_refresh_token",
  });
  if (!r.access_token) throw new InstagramError("Instagram's refresh returned no token");
  return { access_token: r.access_token, expires_at: nowS + (r.expires_in ?? 60 * 86400) };
}

// ---- connecting (the dashboard's Connect Instagram, Phase 4b)

const OAUTH_TOKEN = "https://api.instagram.com/oauth/access_token";
const EXCHANGE = "https://graph.instagram.com/access_token";
/** Trial Reels need a professional account with this many followers (Instagram's rule for the feature). */
export const TRIAL_MIN_FOLLOWERS = 1000;

/** The account behind a token, as a connection's grant: the token (long-lived) and the one account it reaches. */
export async function instagramGrant(fetcher: typeof fetch, creds: GraphCredentials): Promise<Grant> {
  const me = await new GraphInstagram(creds.access_token, "me", fetcher).verify();
  if (!me.id || !me.username) throw new InstagramError("Instagram didn't say which account the token is for");
  return {
    credentials: JSON.stringify(creds),
    expiresAt: creds.expires_at ?? null,
    label: `@${me.username}`,
    accounts: [
      {
        platform: "instagram",
        handle: me.username,
        externalId: me.id,
        capabilities: { trialReels: (me.followers ?? 0) >= TRIAL_MIN_FOLLOWERS },
      },
    ],
  };
}

/** The OAuth code → a short-lived token → a long-lived one (60 days) → the grant. */
export async function exchangeInstagramCode(
  fetcher: typeof fetch,
  app: OAuthContext,
  code: string,
  nowS: number,
): Promise<Grant> {
  const r = await fetcher(OAUTH_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: app.clientId,
      client_secret: app.clientSecret,
      grant_type: "authorization_code",
      redirect_uri: app.redirectUri,
      code: code.replace(/#_$/, ""), // Instagram appends "#_" to the code in the redirect
    }),
  });
  type Short = { access_token?: string; error_message?: string; error?: { message?: string } };
  const j = (await r.json().catch(() => ({}))) as Short & { data?: Short[] };
  const short = j.access_token ?? j.data?.[0]?.access_token;
  if (!r.ok || !short)
    throw new InstagramError(
      `Instagram refused the code: ${j.error_message ?? j.error?.message ?? `HTTP ${r.status}`}`.slice(0, 300),
    );
  const long = await call<{ access_token?: string; expires_in?: number }>(fetcher, short, "GET", EXCHANGE, {
    grant_type: "ig_exchange_token",
    client_secret: app.clientSecret,
  });
  if (!long.access_token) throw new InstagramError("Instagram returned no long-lived token");
  return instagramGrant(fetcher, {
    access_token: long.access_token,
    expires_at: nowS + (long.expires_in ?? 60 * 86400),
  });
}
