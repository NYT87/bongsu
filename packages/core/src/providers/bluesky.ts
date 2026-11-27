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

/** A record key in TID form (13 base32-sortable characters: the time, then random bits), as Bluesky's own clients make. */
function tid(): string {
  const alphabet = "234567abcdefghijklmnopqrstuvwxyz";
  let n = BigInt(Date.now()) * 1000n;
  const rnd = crypto.getRandomValues(new Uint8Array(2));
  n = (n << 10n) | BigInt(((rnd[0] << 8) | rnd[1]) & 0x3ff);
  let out = "";
  for (let i = 0; i < 13; i++) {
    out = alphabet[Number(n & 31n)] + out;
    n >>= 5n;
  }
  return out;
}

const rkeyOf = (uri: string) => uri.slice(uri.lastIndexOf("/") + 1);

export class BlueskyProvider implements Provider {
  readonly id = "bluesky";
  readonly platform = "bluesky";
  // the sign-in, the record read on a retry, and createRecord
  readonly finishCalls = 3;
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

  /** Uploads the images and prepares the record, but writes nothing: the post goes live in `finish`, which the tick
   *  guards (the publishing flag, the run's call budget, `retry`). The record's key is chosen here, so a retry can
   *  tell whether an earlier call already created it. */
  async start(post: OutgoingPost, previous?: Step): Promise<Step> {
    // a retry after the publishing call: keep the record and its key, so `finish` can find what an earlier call made
    if (previous?.data.rkey && previous.data.record) return previous;
    if (post.media.some((m) => m.video))
      return { state: "failed", data: {}, error: "Bluesky can't post video: remove it and approve again" };
    const s = await signIn(this.fetcher, this.creds);
    try {
      const images = [];
      for (const [i, m] of post.media.entries())
        images.push({ alt: post.alts[i] ?? "", image: await this.blob(s, m.url) });
      const facets = facetsOf(post.caption);
      const record = {
        $type: POST,
        text: post.caption,
        createdAt: new Date().toISOString(),
        ...(facets.length ? { facets } : {}),
        ...(images.length ? { embed: { $type: "app.bsky.embed.images", images } } : {}),
      };
      return { state: "ready", data: { rkey: tid(), record } };
    } catch (e) {
      if (e instanceof BlueskyError && !transient(e.status)) return { state: "failed", data: {}, error: e.message };
      throw e;
    }
  }

  async check(step: Step): Promise<Step> {
    return step;
  }

  async finish(step: Step, retry = false): Promise<Published> {
    const rkey = String(step.data.rkey);
    const s = await signIn(this.fetcher, this.creds);
    const uri = `at://${s.did}/${POST}/${rkey}`;
    // an earlier call may have created it and lost its answer: look before writing again
    const exists =
      retry &&
      (await xrpc(
        this.fetcher,
        `com.atproto.repo.getRecord?repo=${encodeURIComponent(s.did)}&collection=${POST}&rkey=${rkey}`,
        {
          method: "GET",
          jwt: s.jwt,
        },
      ).then(
        () => true,
        (e) => {
          if (e instanceof BlueskyError && e.status === 400) return false; // RecordNotFound
          throw e;
        },
      ));
    if (!exists)
      await xrpc(this.fetcher, "com.atproto.repo.createRecord", {
        method: "POST",
        jwt: s.jwt,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo: s.did, collection: POST, rkey, record: step.data.record }),
      });
    return { mediaId: uri, permalink: `https://bsky.app/profile/${s.did}/post/${rkey}`, publishedAt: null };
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
