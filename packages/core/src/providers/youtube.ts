// YouTube as a Provider (youtube-data: the Data API with the channel's OAuth). For now it comments on videos published
// elsewhere (the Shorts comments) and answers comments; uploads come later through start/check/finish (Phase 14).
import { type Connection, connectionSecret } from "../accounts";
import { ANALYTICS_SCOPE, YouTube } from "../clients/youtube";
import type { Grant, OAuthContext, OutgoingPost, Provider, Published, RemoteComment, Step } from "./types";

export class YouTubeProvider implements Provider {
  readonly id = "youtube-data";
  readonly platform = "youtube";
  private yt: YouTube;

  constructor(oauthJson: string, fetcher: typeof fetch) {
    this.yt = new YouTube(oauthJson, fetcher);
  }

  async start(_post: OutgoingPost): Promise<Step> {
    throw new Error("YouTube uploads aren't supported yet: Bongsu only comments on YouTube videos");
  }
  async check(step: Step): Promise<Step> {
    return { ...step, state: "failed", error: "YouTube uploads aren't supported yet" };
  }
  async finish(_step: Step): Promise<Published> {
    throw new Error("YouTube uploads aren't supported yet");
  }

  /** A top-level comment as the channel; returns the thread id. */
  comment(videoId: string, text: string) {
    return this.yt.comment(videoId, text);
  }
  async reply(commentId: string, text: string) {
    await this.yt.reply(commentId, text);
  }
  async comments(videoId: string): Promise<RemoteComment[]> {
    return (await this.yt.comments(videoId)).map((c) => ({
      id: c.id,
      text: c.text,
      author: c.author,
      authorId: c.authorChannel,
      at: c.at,
    }));
  }
  /** The videos that are public now (a Short is commented on only once it is). */
  async isPublic(videoIds: string[]) {
    const privacy = await this.yt.privacy(videoIds);
    return new Set(videoIds.filter((id) => privacy.get(id) === "public"));
  }
  /** Lifetime views, likes and comments per video id (the metrics sampler). */
  statistics(videoIds: string[]) {
    return this.yt.statistics(videoIds);
  }
  /** The channel's subscriber count (the account series). */
  subscriberCount() {
    return this.yt.subscriberCount();
  }
  /** Subscribers gained per video between two dates (the metrics sampler, with the analytics scope). */
  subscribers(videoIds: string[], from: string, to: string) {
    return this.yt.subscribersByVideo(videoIds, from, to);
  }
  async verify() {
    return { id: (await this.yt.channelId()) ?? "", username: "", followers: null };
  }
}

// ---- connecting (the dashboard's Connect YouTube, Phase 4b)

const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE = "https://oauth2.googleapis.com/revoke";
const CHANNELS = "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true";

/** The OAuth code (and PKCE verifier) → a refresh token → the channels it reaches. The credentials are the JSON
 *  clients/google.ts refreshes from. */
export async function exchangeGoogleCode(
  fetcher: typeof fetch,
  app: OAuthContext,
  code: string,
  verifier: string | null,
): Promise<Grant> {
  const r = await fetcher(GOOGLE_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: app.clientId,
      client_secret: app.clientSecret,
      redirect_uri: app.redirectUri,
      grant_type: "authorization_code",
      ...(verifier ? { code_verifier: verifier } : {}),
    }),
  });
  const j = (await r.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    scope?: string;
    error?: string;
    error_description?: string;
  };
  if (!r.ok || !j.access_token)
    throw new Error(`Google refused the code: ${j.error_description ?? j.error ?? `HTTP ${r.status}`}`.slice(0, 300));
  if (!j.refresh_token)
    throw new Error(
      "Google returned no refresh token: remove Bongsu's access in your Google account and connect again",
    );
  const ch = await fetcher(CHANNELS, { headers: { Authorization: `Bearer ${j.access_token}` } });
  if (!ch.ok) throw new Error(`youtube channels.list: HTTP ${ch.status}`);
  const items =
    ((await ch.json()) as { items?: { id: string; snippet?: { title?: string; customUrl?: string } }[] }).items ?? [];
  if (!items.length) throw new Error("this Google account has no YouTube channel");
  return {
    credentials: JSON.stringify({
      client_id: app.clientId,
      client_secret: app.clientSecret,
      refresh_token: j.refresh_token,
      token_uri: GOOGLE_TOKEN,
      // what Google granted: the sampler asks Analytics only when the analytics scope is in it
      scope: j.scope ?? "",
    }),
    label: items[0].snippet?.title ?? items[0].id,
    accounts: items.map((c) => ({
      platform: "youtube",
      handle: (c.snippet?.customUrl ?? c.id).replace(/^@/, ""),
      displayName: c.snippet?.title ?? null,
      externalId: c.id,
    })),
  };
}

/** Ends Bongsu's access to the channel (Google's token revocation); best effort. */
export async function revokeGoogle(fetcher: typeof fetch, credentials: string) {
  const { refresh_token } = JSON.parse(credentials) as { refresh_token?: string };
  if (!refresh_token) return;
  await fetcher(`${GOOGLE_REVOKE}?token=${encodeURIComponent(refresh_token)}`, { method: "POST" }).catch(() => {});
}

/** Whether a channel's connection was granted the Analytics scope: a connection made before the scope was asked
 *  for has no `scope` in its credentials and answers false until the owner reconnects it. */
export async function youtubeAnalytics(env: object, connection: Connection | null): Promise<boolean> {
  const secret = await connectionSecret(env, connection);
  if (!secret) return false;
  try {
    return String((JSON.parse(secret) as { scope?: string }).scope ?? "").includes(ANALYTICS_SCOPE);
  } catch {
    return false;
  }
}
