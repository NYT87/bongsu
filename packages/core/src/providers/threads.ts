// Threads through its own API (graph.threads.net), with the profile's long-lived token: the same container steps as
// Instagram (create → status → publish), carousels as items then their parent, and comments as replies (a reply is a
// container with reply_to_id, published at once). A token lasts 60 days; the weekly keepAlive renews it.
// site/docs/threads.md: the Threads app and the first token.
import { igTime } from "../data";
import { ConnectionBroken, type Grant, type OAuthContext, type OutgoingPost, type Provider, type Step } from "./types";

const API = "https://graph.threads.net/v1.0";
const OAUTH_TOKEN = "https://graph.threads.net/oauth/access_token";
const EXCHANGE = "https://graph.threads.net/access_token";
const REFRESH = "https://graph.threads.net/refresh_access_token";
const LONG_S = 60 * 86400;

export class ThreadsError extends Error {}

/** {"access_token": "...", "expires_at": <unix>} as the connect flow and the renewal store it, or a bare token. */
export interface ThreadsCredentials {
  access_token: string;
  expires_at?: number;
}

export function parseThreadsCredentials(raw: string | null): ThreadsCredentials | null {
  const s = raw?.trim();
  if (!s) return null;
  if (!s.startsWith("{")) return { access_token: s };
  try {
    const j = JSON.parse(s) as ThreadsCredentials;
    return typeof j.access_token === "string" && j.access_token ? j : null;
  } catch {
    return null;
  }
}

async function call<T>(
  fetcher: typeof fetch,
  token: string,
  method: "GET" | "POST",
  path: string,
  params: Record<string, string | number | boolean> = {},
): Promise<T> {
  const url = new URL(path.startsWith("https://") ? path : `${API}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  url.searchParams.set("access_token", token);
  const r = await fetcher(url.toString(), { method });
  const j = (await r.json().catch(() => ({}))) as T & { error?: { message?: string; error_user_msg?: string } };
  if (!r.ok || j.error) {
    const msg = j.error?.error_user_msg || j.error?.message || `HTTP ${r.status}`;
    const what = `${method} ${url.pathname.replace(/^\/v[\d.]+/, "")}`;
    // 190: the token is invalid or revoked; nothing works until the owner reconnects
    const E = (j.error as { code?: number } | undefined)?.code === 190 ? ConnectionBroken : ThreadsError;
    throw new E(`Threads ${what}: ${msg}`.slice(0, 300));
  }
  return j;
}

const failed = (s: string) => s === "ERROR" || s === "EXPIRED";
/** Threads' metrics for the ones the results ask for (Instagram's names); the rest it doesn't have. */
const METRIC: Record<string, string> = { views: "views", likes: "likes", comments: "replies", shares: "shares" };

export class ThreadsProvider implements Provider {
  readonly id = "threads-graph";
  readonly platform = "threads";

  constructor(
    private token: string,
    private userId: string,
    private fetcher: typeof fetch,
  ) {}

  private get<T>(path: string, params: Record<string, string | number | boolean> = {}) {
    return call<T>(this.fetcher, this.token, "GET", path, params);
  }
  private post<T>(path: string, params: Record<string, string | number | boolean> = {}) {
    return call<T>(this.fetcher, this.token, "POST", path, params);
  }

  private async container(params: Record<string, string | number | boolean>) {
    const r = await this.post<{ id?: string }>(`${this.userId}/threads`, params);
    if (!r.id) throw new ThreadsError("Threads returned no container id");
    return r.id;
  }

  private async status(id: string) {
    const r = await this.get<{ status?: string; error_message?: string }>(id, { fields: "status,error_message" });
    return { status: r.status ?? "UNKNOWN", error: r.error_message ?? null };
  }

  private async publishContainer(id: string) {
    const r = await this.post<{ id?: string }>(`${this.userId}/threads_publish`, { creation_id: id });
    if (!r.id) throw new ThreadsError("Threads returned no post id");
    return r.id;
  }

  async start(post: OutgoingPost): Promise<Step> {
    const text = post.caption;
    // alt texts go, in order, to the images
    let alt = 0;
    const media = (m: OutgoingPost["media"][number]) => {
      const p: Record<string, string> = m.video
        ? { media_type: "VIDEO", video_url: m.url }
        : { media_type: "IMAGE", image_url: m.url };
      if (!m.video && post.alts[alt]) p.alt_text = post.alts[alt];
      if (!m.video) alt++;
      return p;
    };
    if (post.format === "text")
      return { state: "processing", data: { container: await this.container({ media_type: "TEXT", text }) } };
    if (post.format === "image" || post.format === "video")
      return { state: "processing", data: { container: await this.container({ ...media(post.media[0]), text }) } };
    if (post.format === "carousel") {
      // the items now; the parent once every item is processed (check)
      const children: string[] = [];
      for (const m of post.media) children.push(await this.container({ ...media(m), is_carousel_item: true }));
      return { state: "processing", data: { children, text } };
    }
    return { state: "failed", data: {}, error: `Threads can't publish a ${post.format}` };
  }

  async check(step: Step): Promise<Step> {
    const d = step.data;
    if (Array.isArray(d.children) && !d.container) {
      const states = await Promise.all((d.children as string[]).map((id) => this.status(id)));
      const bad = states.find((s) => failed(s.status));
      if (bad) return { ...step, state: "failed", error: `carousel item ${bad.status}: ${bad.error ?? ""}`.trim() };
      if (!states.every((s) => s.status === "FINISHED")) return step;
      const container = await this.container({
        media_type: "CAROUSEL",
        children: (d.children as string[]).join(","),
        text: String(d.text ?? ""),
      });
      return { state: "processing", data: { ...d, container } };
    }
    const s = await this.status(String(d.container));
    if (failed(s.status)) return { ...step, state: "failed", error: `container ${s.status}: ${s.error ?? ""}`.trim() };
    return s.status === "FINISHED" ? { ...step, state: "ready" } : step;
  }

  /** Publishes the container. The post is live once Threads answers with its id: the permalink is a second call
   *  whose failure must not lose that id. A container publishes once, so a retry after a lost answer is refused
   *  rather than posted twice. */
  async finish(step: Step) {
    const mediaId = await this.publishContainer(String(step.data.container));
    try {
      const got = await this.get<{ permalink?: string; timestamp?: string }>(mediaId, {
        fields: "permalink,timestamp",
      });
      return { mediaId, permalink: got.permalink ?? null, publishedAt: igTime(got.timestamp) };
    } catch {
      return { mediaId, permalink: null, publishedAt: null };
    }
  }

  /** A reply as the profile: a text container answering `to`, published at once (text needs no processing). */
  private async replyTo(to: string, text: string) {
    return this.publishContainer(await this.container({ media_type: "TEXT", text, reply_to_id: to }));
  }

  comment(mediaId: string, text: string) {
    return this.replyTo(mediaId, text);
  }
  async reply(commentId: string, text: string) {
    await this.replyTo(commentId, text);
  }
  async comments(mediaId: string) {
    type R = { id: string; text?: string; username?: string; timestamp?: string };
    const r = await this.get<{ data?: R[] }>(`${mediaId}/replies`, { fields: "id,text,username,timestamp" });
    return (r.data ?? []).map((c) => ({
      id: c.id,
      text: c.text ?? "",
      author: c.username ?? "",
      at: c.timestamp ?? "",
    }));
  }
  async results(mediaId: string, metrics: string[]) {
    const asked = [...new Set(metrics.map((m) => METRIC[m]).filter(Boolean))];
    type D = { name: string; values?: { value: number }[]; total_value?: { value: number } };
    const d = asked.length ? await this.get<{ data?: D[] }>(`${mediaId}/insights`, { metric: asked.join(",") }) : {};
    const got = new Map((d.data ?? []).map((x) => [x.name, x.values?.[0]?.value ?? x.total_value?.value ?? null]));
    return Object.fromEntries(metrics.map((m) => [m, METRIC[m] ? (got.get(METRIC[m]) ?? null) : null]));
  }
  async verify() {
    const me = await this.get<{ id?: string; username?: string }>("me", { fields: "id,username" });
    return { id: me.id ?? "", username: me.username ?? "", followers: null };
  }
}

/** The profile behind a token, as a connection's grant. */
export async function threadsGrant(fetcher: typeof fetch, creds: ThreadsCredentials): Promise<Grant> {
  const me = await new ThreadsProvider(creds.access_token, "me", fetcher).verify();
  if (!me.id || !me.username) throw new ThreadsError("Threads didn't say which profile the token is for");
  return {
    credentials: JSON.stringify(creds),
    expiresAt: creds.expires_at ?? null,
    label: `@${me.username}`,
    accounts: [{ platform: "threads", handle: me.username, externalId: me.id }],
  };
}

/** The OAuth code → a short-lived token → a long-lived one (60 days) → the grant. */
export async function exchangeThreadsCode(
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
      code: code.replace(/#_$/, ""), // Meta appends "#_" to the code in the redirect
    }),
  });
  const j = (await r.json().catch(() => ({}))) as { access_token?: string; error?: { message?: string } };
  if (!r.ok || !j.access_token)
    throw new ThreadsError(`Threads refused the code: ${j.error?.message ?? `HTTP ${r.status}`}`.slice(0, 300));
  const long = await call<{ access_token?: string; expires_in?: number }>(fetcher, j.access_token, "GET", EXCHANGE, {
    grant_type: "th_exchange_token",
    client_secret: app.clientSecret,
  });
  if (!long.access_token) throw new ThreadsError("Threads returned no long-lived token");
  return threadsGrant(fetcher, { access_token: long.access_token, expires_at: nowS + (long.expires_in ?? LONG_S) });
}

/** A fresh long-lived token for one at least a day old; valid 60 days from now. */
export async function refreshThreadsToken(
  fetcher: typeof fetch,
  token: string,
  nowS: number,
): Promise<ThreadsCredentials> {
  const r = await call<{ access_token?: string; expires_in?: number }>(fetcher, token, "GET", REFRESH, {
    grant_type: "th_refresh_token",
  });
  if (!r.access_token) throw new ThreadsError("Threads' refresh returned no token");
  return { access_token: r.access_token, expires_at: nowS + (r.expires_in ?? LONG_S) };
}
