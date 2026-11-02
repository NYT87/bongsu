// YouTube Data API for the Shorts comments, with the channel's refresh token.
import { refreshToken } from "./google";

const API = "https://www.googleapis.com/youtube/v3";
const ANALYTICS = "https://youtubeanalytics.googleapis.com/v2/reports";
/** The scope the Analytics API needs on top of youtube.force-ssl; a channel connected without it answers 403. */
export const ANALYTICS_SCOPE = "https://www.googleapis.com/auth/yt-analytics.readonly";

/** The Analytics API refused the token: the channel was connected without the analytics scope. */
export class AnalyticsScopeError extends Error {}

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
}
