// YouTube Data API for the Shorts comments, with the channel's refresh token.
import { refreshToken } from "./google";

const API = "https://www.googleapis.com/youtube/v3";
const UPLOAD = "https://www.googleapis.com/upload/youtube/v3";
const ANALYTICS = "https://youtubeanalytics.googleapis.com/v2/reports";
/** The scope the Analytics API needs on top of youtube.force-ssl; a channel connected without it answers 403. */
export const ANALYTICS_SCOPE = "https://www.googleapis.com/auth/yt-analytics.readonly";

/** The Analytics API refused the token: the channel was connected without the analytics scope. */
export class AnalyticsScopeError extends Error {}

/** YouTube's quota is used up (403 quotaExceeded) or the channel hit its upload limit (uploadLimitExceeded). */
export class QuotaExceeded extends Error {}

/** YouTube refused a call (other than for quota): `status` is its HTTP status. */
export class YouTubeRefused extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** The resumable session no longer exists (404/410): the upload starts again from a new session. */
export class SessionGone extends Error {}

export interface VideoMeta {
  title: string;
  description: string;
  tags?: string[];
  categoryId: string;
  defaultLanguage?: string;
  defaultAudioLanguage?: string;
  madeForKids: boolean;
  localizations?: Record<string, { title: string; description: string }>;
}

export interface VideoState {
  uploadStatus: string;
  privacyStatus: string;
  rejectionReason?: string;
  failureReason?: string;
  seconds: number | null;
  width: number | null;
  height: number | null;
  status: Record<string, unknown>;
}

export interface Upload {
  id: string;
  title: string;
  privacy: string;
  when: string | null;
  short: boolean;
}

/** ISO 8601 duration (PT1M5S) → seconds. */
export function isoSeconds(d: string): number {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(d) ?? [];
  return Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0);
}

/** Why a release date can't be moved: no such video, not a scheduled one, a time not in the future, or too soon. */
export class ReleaseError extends Error {
  constructor(
    public reason: "missing" | "not_scheduled" | "past" | "lead",
    message: string,
  ) {
    super(message);
  }
}

export class YouTube {
  constructor(
    private oauthJson: string,
    private fetcher: typeof fetch,
  ) {}

  private async auth() {
    return { Authorization: `Bearer ${await refreshToken(this.oauthJson, this.fetcher)}` };
  }

  /** privacyStatus per video id (missing ids: deleted or not ours). 1 quota unit per call of up to 50. */
  async privacy(ids: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (let i = 0; i < ids.length; i += 50) {
      const r = await this.fetcher(`${API}/videos?part=status&id=${ids.slice(i, i + 50).join(",")}`, {
        headers: await this.auth(),
      });
      if (!r.ok) throw new Error(`youtube videos.list: ${r.status}`);
      const j = (await r.json()) as { items?: { id: string; status: { privacyStatus: string } }[] };
      for (const v of j.items ?? []) out.set(v.id, v.status.privacyStatus);
    }
    return out;
  }

  /** Lifetime counts per video id (a missing id: deleted or not ours; a count the channel hides is null). 1 quota unit per call of up to 50. */
  async statistics(
    ids: string[],
  ): Promise<Map<string, { views: number | null; likes: number | null; comments: number | null }>> {
    const out = new Map<string, { views: number | null; likes: number | null; comments: number | null }>();
    const num = (v: string | undefined) => (v === undefined || v === "" || Number.isNaN(Number(v)) ? null : Number(v));
    for (let i = 0; i < ids.length; i += 50) {
      const r = await this.fetcher(`${API}/videos?part=statistics&id=${ids.slice(i, i + 50).join(",")}`, {
        headers: await this.auth(),
      });
      if (!r.ok) throw new Error(`youtube videos.list: ${r.status}`);
      const j = (await r.json()) as {
        items?: { id: string; statistics?: { viewCount?: string; likeCount?: string; commentCount?: string } }[];
      };
      for (const v of j.items ?? [])
        out.set(v.id, {
          views: num(v.statistics?.viewCount),
          likes: num(v.statistics?.likeCount),
          comments: num(v.statistics?.commentCount),
        });
    }
    return out;
  }

  /** Subscribers gained (and lost) per video between two dates (YYYY-MM-DD, inclusive): the Analytics API's
   *  `reports.query` with the video dimension, 50 ids per call. A video with no row gained none. Its own quota. */
  async subscribersByVideo(
    ids: string[],
    from: string,
    to: string,
  ): Promise<Map<string, { gained: number; lost: number }>> {
    const out = new Map<string, { gained: number; lost: number }>();
    for (let i = 0; i < ids.length; i += 50) {
      const q = new URLSearchParams({
        ids: "channel==MINE",
        startDate: from,
        endDate: to,
        metrics: "subscribersGained,subscribersLost",
        dimensions: "video",
        filters: `video==${ids.slice(i, i + 50).join(",")}`,
        // the video dimension is the top-videos report: it wants a descending sort and a row cap
        sort: "-subscribersGained",
        maxResults: "50",
      });
      const r = await this.fetcher(`${ANALYTICS}?${q}`, { headers: await this.auth() });
      if (r.status === 403)
        throw new AnalyticsScopeError("YouTube Analytics refused the token: reconnect the channel with analytics");
      if (!r.ok) throw new Error(`youtube analytics: ${r.status}`);
      const j = (await r.json()) as { columnHeaders?: { name: string }[]; rows?: (string | number)[][] };
      const col = (name: string) => (j.columnHeaders ?? []).findIndex((h) => h.name === name);
      const [v, g, l] = [col("video"), col("subscribersGained"), col("subscribersLost")];
      for (const row of j.rows ?? [])
        out.set(String(row[v]), { gained: Number(row[g]) || 0, lost: Number(row[l]) || 0 });
    }
    return out;
  }

  /**
   * Moves a scheduled video's `publishAt`. `videos.update` replaces the whole status part, so the current one is read
   * first and sent back with only `publishAt` changed (otherwise license, embeddable… would reset to defaults).
   * 1 + 50 quota units.
   */
  async setReleaseDate(videoId: string, atIso: string): Promise<{ from: string }> {
    if (!(Date.parse(atIso) > Date.now())) throw new ReleaseError("past", "The new release time is not in the future");
    const h = await this.auth();
    const r = await this.fetcher(`${API}/videos?part=status&id=${videoId}`, { headers: h });
    if (!r.ok) throw new Error(`youtube videos.list: ${r.status}`);
    const status = ((await r.json()) as { items?: { status: Record<string, unknown> }[] }).items?.[0]?.status;
    if (!status) throw new ReleaseError("missing", "No such video on the channel");
    const from = status.publishAt;
    if (status.privacyStatus !== "private" || typeof from !== "string")
      throw new ReleaseError("not_scheduled", "The video is not scheduled");
    const u = await this.fetcher(`${API}/videos?part=status`, {
      method: "PUT",
      headers: { ...h, "Content-Type": "application/json" },
      body: JSON.stringify({ id: videoId, status: { ...status, publishAt: atIso } }),
    });
    if (!u.ok) throw new Error(`youtube videos.update: ${u.status} ${(await u.text()).slice(0, 200)}`);
    return { from };
  }

  /** The channel's uploads (latest `max`), with their public or scheduled time: about 3 quota units for 50. */
  async uploads(max = 50): Promise<Upload[]> {
    const h = await this.auth();
    const ch = await this.fetcher(`${API}/channels?part=contentDetails&mine=true`, { headers: h });
    if (!ch.ok) throw new Error(`youtube channels.list: ${ch.status}`);
    const list = ((await ch.json()) as { items?: { contentDetails: { relatedPlaylists: { uploads: string } } }[] })
      .items?.[0]?.contentDetails.relatedPlaylists.uploads;
    if (!list) return [];
    const pi = await this.fetcher(
      `${API}/playlistItems?part=contentDetails&maxResults=${Math.min(max, 50)}&playlistId=${list}`,
      { headers: h },
    );
    if (!pi.ok) throw new Error(`youtube playlistItems.list: ${pi.status}`);
    const ids =
      ((await pi.json()) as { items?: { contentDetails: { videoId: string } }[] }).items?.map(
        (i) => i.contentDetails.videoId,
      ) ?? [];
    if (!ids.length) return [];
    const v = await this.fetcher(`${API}/videos?part=snippet,status,contentDetails&id=${ids.join(",")}`, {
      headers: h,
    });
    if (!v.ok) throw new Error(`youtube videos.list: ${v.status}`);
    const items =
      (
        (await v.json()) as {
          items?: {
            id: string;
            snippet: { title: string; publishedAt: string };
            status: { privacyStatus: string; publishAt?: string };
            contentDetails: { duration: string };
          }[];
        }
      ).items ?? [];
    return items.map((x) => ({
      id: x.id,
      title: x.snippet.title,
      privacy: x.status.privacyStatus,
      // A scheduled upload is private with publishAt; a public one has its real publish time in publishedAt.
      when: x.status.privacyStatus === "public" ? x.snippet.publishedAt : (x.status.publishAt ?? null),
      short: isoSeconds(x.contentDetails.duration) <= 180,
    }));
  }

  /** A video's latest top-level comments (commentThreads.list, 1 unit). */
  async comments(
    videoId: string,
    max = 20,
  ): Promise<{ id: string; author: string; authorChannel: string | null; text: string; at: string }[]> {
    const r = await this.fetcher(
      `${API}/commentThreads?part=snippet&order=time&maxResults=${max}&textFormat=plainText&videoId=${encodeURIComponent(videoId)}`,
      { headers: await this.auth() },
    );
    if (r.status === 403 || r.status === 404) return []; // comments off, or the video is gone
    if (!r.ok) throw new Error(`youtube commentThreads.list: ${r.status}`);
    const items =
      (
        (await r.json()) as {
          items?: {
            id: string;
            snippet: {
              topLevelComment: {
                id: string;
                snippet: {
                  authorDisplayName: string;
                  authorChannelId?: { value: string };
                  textDisplay: string;
                  publishedAt: string;
                };
              };
            };
          }[];
        }
      ).items ?? [];
    return items.map((t) => {
      const s = t.snippet.topLevelComment.snippet;
      return {
        id: t.snippet.topLevelComment.id,
        author: s.authorDisplayName,
        authorChannel: s.authorChannelId?.value ?? null,
        text: s.textDisplay,
        at: s.publishedAt,
      };
    });
  }

  /** The channel's own id (to tell our comments from others'), cached per instance. */
  private me: string | null = null;
  async channelId(): Promise<string | null> {
    if (this.me) return this.me;
    const r = await this.fetcher(`${API}/channels?part=id&mine=true`, { headers: await this.auth() });
    if (!r.ok) throw new Error(`youtube channels.list: ${r.status}`);
    this.me = ((await r.json()) as { items?: { id: string }[] }).items?.[0]?.id ?? null;
    return this.me;
  }

  /** The channel's subscriber count (rounded by YouTube above 1,000); null when the channel hides it. 1 unit. */
  async subscriberCount(): Promise<number | null> {
    const r = await this.fetcher(`${API}/channels?part=statistics&mine=true`, { headers: await this.auth() });
    if (!r.ok) throw new Error(`youtube channels.list: ${r.status}`);
    const st = (
      (await r.json()) as { items?: { statistics?: { subscriberCount?: string; hiddenSubscriberCount?: boolean } }[] }
    ).items?.[0]?.statistics;
    if (!st || st.hiddenSubscriberCount || st.subscriberCount === undefined) return null;
    const n = Number(st.subscriberCount);
    return Number.isFinite(n) ? n : null;
  }

  /** Reply to a comment as the channel (comments.insert, 50 units); returns the reply's id. */
  async reply(parentId: string, text: string): Promise<string> {
    const r = await this.fetcher(`${API}/comments?part=snippet`, {
      method: "POST",
      headers: { ...(await this.auth()), "Content-Type": "application/json" },
      body: JSON.stringify({ snippet: { parentId, textOriginal: text } }),
    });
    if (!r.ok) throw new Error(`youtube comments.insert: ${r.status} ${(await r.text()).slice(0, 200)}`);
    return ((await r.json()) as { id: string }).id;
  }

  /** Top-level comment as the channel (commentThreads.insert, 50 units); returns the thread id. */
  async comment(videoId: string, text: string): Promise<string> {
    const r = await this.fetcher(`${API}/commentThreads?part=snippet`, {
      method: "POST",
      headers: { ...(await this.auth()), "Content-Type": "application/json" },
      body: JSON.stringify({ snippet: { videoId, topLevelComment: { snippet: { textOriginal: text } } } }),
    });
    if (!r.ok) throw new Error(`youtube commentThreads.insert: ${r.status} ${(await r.text()).slice(0, 200)}`);
    return ((await r.json()) as { id: string }).id;
  }

  /** Throws QuotaExceeded or an Error for a refused call; `what` names the call in the message. */
  private async refuse(r: Response, what: string): Promise<never> {
    const body = await r.text();
    const text = body.slice(0, 300);
    // the reasons come from the whole parsed body (Google's errors run past 300 characters):
    // uploadLimitExceeded arrives as a 400 or a 403, quotaExceeded as a 403
    let reasons: string[] = [];
    try {
      const e = (JSON.parse(body) as { error?: { errors?: { reason?: string }[]; status?: string } }).error;
      reasons = [...(e?.errors ?? []).map((x) => x.reason ?? ""), e?.status ?? ""];
    } catch {}
    if (reasons.includes("uploadLimitExceeded") || (r.status === 403 && reasons.includes("quotaExceeded")))
      throw new QuotaExceeded(`youtube ${what}: ${text}`);
    throw new YouTubeRefused(r.status, `youtube ${what}: ${r.status} ${text}`);
  }

  /** The answer to a session PUT: done (the video resource), or 308 with the bytes YouTube kept in `Range`. */
  private async sessionReply(r: Response, size: number): Promise<{ offset: number; videoId?: string }> {
    if (r.status === 200 || r.status === 201) return { offset: size, videoId: ((await r.json()) as { id: string }).id };
    if (r.status === 308) {
      const m = /^bytes=0-(\d+)$/.exec(r.headers.get("Range") ?? "");
      return { offset: m ? Number(m[1]) + 1 : 0 };
    }
    if (r.status === 404 || r.status === 410) throw new SessionGone(`youtube upload session: ${r.status}`);
    return this.refuse(r, "upload");
  }

  /** Opens a resumable upload (videos.insert, 1600 units): the video starts private. Returns the session URL. */
  async startUpload(meta: VideoMeta, size: number, mime: string): Promise<string> {
    const r = await this.fetcher(`${UPLOAD}/videos?uploadType=resumable&part=snippet,status,localizations`, {
      method: "POST",
      headers: {
        ...(await this.auth()),
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Length": String(size),
        "X-Upload-Content-Type": mime,
      },
      body: JSON.stringify({
        snippet: snippetOf(meta),
        status: { privacyStatus: "private", selfDeclaredMadeForKids: meta.madeForKids },
        ...(meta.localizations ? { localizations: meta.localizations } : {}),
      }),
    });
    if (!r.ok) return this.refuse(r, "videos.insert");
    const session = r.headers.get("Location");
    if (!session) throw new Error("youtube videos.insert: no session URL");
    return session;
  }

  /** Asks the session how many bytes YouTube holds (a `*` Content-Range); videoId once the upload is complete. */
  async uploadOffset(session: string, size: number): Promise<{ offset: number; videoId?: string }> {
    const r = await this.fetcher(session, {
      method: "PUT",
      headers: { ...(await this.auth()), "Content-Range": `bytes */${size}`, "Content-Length": "0" },
    });
    return this.sessionReply(r, size);
  }

  /**
   * Sends the file from `offset`, reading `source` with a Range request and PUTting it to the session. Without
   * `chunkBytes` the rest goes in one streamed PUT; with it, pieces of that size one after another. Whatever the
   * budget doesn't allow is left for the next run: an abort is normal and answers with the offset YouTube kept.
   */
  async uploadFrom(
    session: string,
    source: string,
    offset: number,
    size: number,
    o: { budgetMs: number; chunkBytes?: number },
  ): Promise<{ offset: number; videoId?: string }> {
    const signal = AbortSignal.timeout(o.budgetMs);
    // a finished upload only needs its id (an earlier run may have ended right after the last byte)
    if (offset >= size) return this.uploadOffset(session, size);
    const h = await this.auth();
    try {
      while (offset < size) {
        const end = Math.min(size, o.chunkBytes ? offset + o.chunkBytes : size) - 1;
        const src = await this.fetcher(source, {
          headers: { Range: `bytes=${offset}-${o.chunkBytes ? end : ""}` },
          signal,
        });
        // a chunk read from a source that ignores Range would send the wrong bytes
        if (o.chunkBytes && src.status !== 206)
          throw new Error(`youtube upload source ignored the Range request: ${src.status}`);
        if (src.status !== 206 && !(src.status === 200 && offset === 0)) return this.refuse(src, "upload source");
        const put = await this.fetcher(session, {
          method: "PUT",
          headers: {
            ...h,
            "Content-Range": `bytes ${offset}-${end}/${size}`,
            "Content-Length": String(end - offset + 1),
          },
          // a chunk is held in memory (8 MiB); the whole rest is streamed so a big file never is
          body: o.chunkBytes ? await src.arrayBuffer() : src.body,
          // @ts-expect-error: `duplex` is required for a stream body by fetch implementations, absent from the DOM types
          duplex: "half",
          signal,
        });
        const r = await this.sessionReply(put, size);
        if (r.videoId || !o.chunkBytes || r.offset <= offset) return r;
        offset = r.offset;
      }
      return { offset };
    } catch (e) {
      if (e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError"))
        return this.uploadOffset(session, size);
      throw e;
    }
  }

  /** A video's state while it processes: status, processing and file details (1 unit); null when it is gone. */
  async videoState(id: string): Promise<VideoState | null> {
    const r = await this.fetcher(
      `${API}/videos?part=status,processingDetails,fileDetails,contentDetails&id=${encodeURIComponent(id)}`,
      { headers: await this.auth() },
    );
    if (!r.ok) return this.refuse(r, "videos.list");
    const v = ((await r.json()) as { items?: Record<string, any>[] }).items?.[0];
    if (!v) return null;
    const stream = v.fileDetails?.videoStreams?.[0];
    const num = (n: unknown) => (typeof n === "number" ? n : null);
    return {
      uploadStatus: v.status?.uploadStatus ?? "",
      privacyStatus: v.status?.privacyStatus ?? "",
      rejectionReason: v.status?.rejectionReason,
      failureReason: v.status?.failureReason,
      seconds: v.contentDetails?.duration ? isoSeconds(v.contentDetails.duration) : null,
      width: num(stream?.widthPixels),
      height: num(stream?.heightPixels),
      status: v.status ?? {},
    };
  }

  /** videos.update (50 units) of snippet, status and localizations: each part replaces what YouTube holds. */
  async updateVideo(id: string, meta: VideoMeta, status: Record<string, unknown>): Promise<void> {
    const r = await this.fetcher(`${API}/videos?part=snippet,status,localizations`, {
      method: "PUT",
      headers: { ...(await this.auth()), "Content-Type": "application/json" },
      body: JSON.stringify({
        id,
        snippet: snippetOf(meta),
        status: { ...status, selfDeclaredMadeForKids: meta.madeForKids },
        localizations: meta.localizations ?? {},
      }),
    });
    if (!r.ok) return this.refuse(r, "videos.update");
  }

  /** thumbnails.set (50 units) with the image read from `source`. */
  async setThumbnail(videoId: string, source: string): Promise<void> {
    const src = await this.fetcher(source);
    if (!src.ok) return this.refuse(src, "thumbnail source");
    const r = await this.fetcher(`${UPLOAD}/thumbnails/set?videoId=${encodeURIComponent(videoId)}`, {
      method: "POST",
      headers: { ...(await this.auth()), "Content-Type": src.headers.get("Content-Type") ?? "image/jpeg" },
      body: await src.arrayBuffer(),
    });
    if (!r.ok) return this.refuse(r, "thumbnails.set");
  }

  /** captions.insert (400 units): a subtitle file for one language, sent as multipart/related. Returns the track id. */
  async insertCaption(videoId: string, lang: string, source: string, name: string): Promise<string> {
    const src = await this.fetcher(source);
    if (!src.ok) return this.refuse(src, "caption source");
    const boundary = `bongsu-${crypto.randomUUID()}`;
    const enc = new TextEncoder();
    const meta = JSON.stringify({ snippet: { videoId, language: lang, name, isDraft: false } });
    const parts = [
      enc.encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`),
      enc.encode(`--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`),
      new Uint8Array(await src.arrayBuffer()),
      enc.encode(`\r\n--${boundary}--`),
    ];
    const body = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
      body.set(p, at);
      at += p.length;
    }
    const r = await this.fetcher(`${UPLOAD}/captions?uploadType=multipart&part=snippet`, {
      method: "POST",
      headers: { ...(await this.auth()), "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
    });
    if (!r.ok) return this.refuse(r, "captions.insert");
    return ((await r.json()) as { id: string }).id;
  }

  /** captions.delete (50 units); a track already gone counts as deleted. */
  async deleteCaption(trackId: string): Promise<void> {
    const r = await this.fetcher(`${API}/captions?id=${encodeURIComponent(trackId)}`, {
      method: "DELETE",
      headers: await this.auth(),
    });
    if (!r.ok && r.status !== 404) return this.refuse(r, "captions.delete");
  }

  /** videos.delete (50 units); a video already gone (404) counts as deleted. */
  async deleteVideo(id: string): Promise<void> {
    const r = await this.fetcher(`${API}/videos?id=${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: await this.auth(),
    });
    if (!r.ok && r.status !== 404) return this.refuse(r, "videos.delete");
  }
}

function snippetOf(m: VideoMeta) {
  return {
    title: m.title,
    description: m.description,
    ...(m.tags?.length ? { tags: m.tags } : {}),
    categoryId: m.categoryId,
    ...(m.defaultLanguage ? { defaultLanguage: m.defaultLanguage } : {}),
    ...(m.defaultAudioLanguage ? { defaultAudioLanguage: m.defaultAudioLanguage } : {}),
  };
}
