// Bluesky through the AT Protocol, with an app password (bsky.social): sign in, upload each image as a blob, create
// the post record; comments are replies to it. An app password is revocable and limited, so it's what the owner
// pastes instead of an OAuth flow (docs/superpowers/specs/2026-11-25-bluesky-design.md). No JWT is stored: every
// run signs in again, which costs one call and leaves nothing to expire.
import { facetsOf } from "./bluesky-richtext";
import { ConnectionBroken, type Grant, type OutgoingPost, type Provider, type Published, type Step } from "./types";

const HOST = "https://bsky.social";
const POST = "app.bsky.feed.post";

export interface BlueskyCredentials {
  handle: string;
  password: string;
}

/** `handle:app-password` (the handle with or without a leading @); null when it isn't that. */
export function parseBlueskyCredentials(raw: string | null): BlueskyCredentials | null {
  const s = raw?.trim().replace(/^@/, "");
  if (!s) return null;
  const i = s.indexOf(":");
  if (i <= 0 || i === s.length - 1) return null;
  return { handle: s.slice(0, i).trim(), password: s.slice(i + 1).trim() };
}

interface Session {
  jwt: string;
  did: string;
  handle: string;
}

/** An answer to retry later (rate limit, outage): thrown, so the tick tries again; other 4xx are the post's own fault. */
const transient = (status: number) => status === 429 || status >= 500;

async function xrpc<T>(fetcher: typeof fetch, method: string, init: RequestInit & { jwt?: string }): Promise<T> {
  const { jwt, ...rest } = init;
  const r = await fetcher(`${HOST}/xrpc/${method}`, {
    ...rest,
    headers: { ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}), ...(rest.headers as Record<string, string>) },
  });
  const j = (await r.json().catch(() => ({}))) as T & { message?: string; error?: string };
  if (!r.ok)
    throw new BlueskyError(r.status, `Bluesky ${method}: ${j.message ?? j.error ?? `HTTP ${r.status}`}`.slice(0, 300));
  return j;
}

class BlueskyError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function signIn(fetcher: typeof fetch, c: BlueskyCredentials): Promise<Session> {
  try {
    const j = await xrpc<{ accessJwt: string; did: string; handle: string }>(
      fetcher,
      "com.atproto.server.createSession",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: c.handle, password: c.password }),
      },
    );
    return { jwt: j.accessJwt, did: j.did, handle: j.handle };
  } catch (e) {
    if (e instanceof BlueskyError && e.status === 401) throw new ConnectionBroken("Bluesky refused the app password");
    throw e;
  }
}

const rkeyOf = (uri: string) => uri.slice(uri.lastIndexOf("/") + 1);

export class BlueskyProvider implements Provider {
  readonly id = "bluesky";
  readonly platform = "bluesky";
  constructor(
    private creds: BlueskyCredentials,
    private fetcher: typeof fetch,
  ) {}

  private async record(s: Session, record: Record<string, unknown>) {
    return xrpc<{ uri: string; cid: string }>(this.fetcher, "com.atproto.repo.createRecord", {
      method: "POST",
      jwt: s.jwt,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo: s.did, collection: POST, record }),
    });
  }

  private async blob(s: Session, url: string) {
    const src = await this.fetcher(url);
    if (!src.ok) throw new Error(`the image's link answered ${src.status}`);
    const type = src.headers.get("Content-Type") ?? "application/octet-stream";
    const j = await xrpc<{ blob: unknown }>(this.fetcher, "com.atproto.repo.uploadBlob", {
      method: "POST",
      jwt: s.jwt,
      headers: { "Content-Type": type },
      body: await src.arrayBuffer(),
    });
    return j.blob;
  }

  async start(post: OutgoingPost): Promise<Step> {
    const s = await signIn(this.fetcher, this.creds);
    try {
      const images = [];
      for (const [i, m] of post.media.filter((m) => !m.video).entries())
        images.push({ alt: post.alts[i] ?? "", image: await this.blob(s, m.url) });
      const facets = facetsOf(post.caption);
      const r = await this.record(s, {
        $type: POST,
        text: post.caption,
        createdAt: new Date().toISOString(),
        ...(facets.length ? { facets } : {}),
        ...(images.length ? { embed: { $type: "app.bsky.embed.images", images } } : {}),
      });
      return { state: "ready", data: { uri: r.uri, cid: r.cid } };
    } catch (e) {
      if (e instanceof BlueskyError && !transient(e.status)) return { state: "failed", data: {}, error: e.message };
      throw e;
    }
  }

  async check(step: Step): Promise<Step> {
    return step;
  }

  async finish(step: Step): Promise<Published> {
    const uri = String(step.data.uri);
    return {
      mediaId: uri,
      permalink: `https://bsky.app/profile/${this.creds.handle}/post/${rkeyOf(uri)}`,
      publishedAt: null,
    };
  }

  async comment(mediaId: string, text: string): Promise<string> {
    const s = await signIn(this.fetcher, this.creds);
    const got = await xrpc<{ cid: string }>(
      this.fetcher,
      `com.atproto.repo.getRecord?repo=${encodeURIComponent(s.did)}&collection=${POST}&rkey=${rkeyOf(mediaId)}`,
      { method: "GET", jwt: s.jwt },
    );
    const ref = { uri: mediaId, cid: got.cid };
    const facets = facetsOf(text);
    const r = await this.record(s, {
      $type: POST,
      text,
      createdAt: new Date().toISOString(),
      reply: { root: ref, parent: ref },
      ...(facets.length ? { facets } : {}),
    });
    return r.uri;
  }

  async verify() {
    const s = await signIn(this.fetcher, this.creds);
    return { id: s.did, username: s.handle, followers: null };
  }
}

/** Signs in once to learn the account's DID: the grant a pasted `handle:app-password` becomes. */
export async function blueskyGrant(fetcher: typeof fetch, creds: BlueskyCredentials): Promise<Grant> {
  const s = await signIn(fetcher, creds).catch((e) => {
    throw e instanceof ConnectionBroken ? new Error("Bluesky refused that handle and app password") : e;
  });
  return {
    credentials: `${creds.handle}:${creds.password}`,
    label: `@${s.handle}`,
    accounts: [{ platform: "bluesky", handle: s.handle, externalId: s.did }],
  };
}
