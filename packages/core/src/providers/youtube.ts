// YouTube as a Provider (youtube-data: the Data API with the channel's OAuth). It uploads a video private ahead of its
// due time (a resumable upload, then subtitles and the thumbnail, then YouTube's processing) and makes it public at
// finish. It also comments on videos, its own and those published elsewhere (the Shorts comments), and answers them.
import { type Connection, connectionSecret } from "../accounts";
import { ANALYTICS_SCOPE, type VideoMeta, type VideoState, YouTube, YouTubeRefused } from "../clients/youtube";
import { MediaRolesError, mediaRoles, youtubePermalink, youtubeSettings } from "../platforms/youtube";
import type {
  Grant,
  OAuthContext,
  OutgoingMedia,
  OutgoingPost,
  Provider,
  Published,
  RemoteComment,
  Step,
} from "./types";

/** How long one run may spend sending the file: below the tick lock's 240 s, the rest goes on the next run. */
export const UPLOAD_BUDGET_S = 180;
/** A piece in chunk mode: a multiple of 256 KiB, as resumable uploads require. */
export const CHUNK_BYTES = 8 * 1024 * 1024;

/** What a YouTube upload keeps in `step.data` between runs. */
export interface UploadData {
  phase: "uploading" | "extras" | "processing" | "waiting";
  session?: string;
  size: number;
  /** Bytes YouTube holds so far (the progress shown while uploading). */
  offset?: number;
  videoId?: string;
  videoChecksum: string;
  /** The subtitle tracks on the video, by language, with the checksum of the file each came from. */
  captions: Record<string, { trackId: string; md5: string }>;
  thumbnailMd5?: string;
  /** YouTube refused the custom thumbnail (a channel not allowed them): the video goes on without it. */
  thumbnailRefused?: boolean;
  notBefore?: number;
  /** What the extras phase still has to do. */
  pending: { captions: string[]; dropCaptions: string[]; thumbnail: boolean };
  /** The post's file links (re-signed by the tick each run). */
  post: { media: OutgoingMedia[] };
  /** The snippet and localizations, sent again whole by finish (videos.update replaces each part it gets). */
  meta: VideoMeta;
  privacy: "public" | "unlisted";
}

const LOCKED =
  "YouTube keeps this video private until your Google project passes YouTube's audit (see the YouTube guide)";

/** YouTube left the video private when asked to publish it: the Google project hasn't passed YouTube's audit. */
export class YouTubeLocked extends Error {
  constructor() {
    super(LOCKED);
  }
}

/** Status fields YouTube reports but refuses or ignores in videos.update. */
const READ_ONLY_STATUS = ["uploadStatus", "failureReason", "rejectionReason", "madeForKids"];
const writable = (status: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(status).filter(([k]) => !READ_ONLY_STATUS.includes(k)));

/** The post's files by role (the media entries carry no mime type, only whether each is a video). */
const rolesOf = (media: OutgoingMedia[]) =>
  mediaRoles(media.map((m) => ({ name: m.name, mime: m.video ? "video/*" : "", size: 0, ref: m })));

function metaOf(post: OutgoingPost, madeForKids: boolean, category: string): VideoMeta {
  const t = post.texts;
  return {
    title: t?.title ?? "",
    description: post.caption,
    ...(t?.tags?.length ? { tags: t.tags } : {}),
    categoryId: category,
    ...(t?.language ? { defaultLanguage: t.language } : {}),
    ...(t?.audioLanguage ? { defaultAudioLanguage: t.audioLanguage } : {}),
    madeForKids,
    ...(t?.translations && Object.keys(t.translations).length ? { localizations: t.translations } : {}),
  };
}

export class YouTubeProvider implements Provider {
  readonly id = "youtube-data";
  readonly platform = "youtube";
  private yt: YouTube;

  constructor(
    oauthJson: string,
    private fetcher: typeof fetch,
    /** Send the file in CHUNK_BYTES pieces instead of one stream (YOUTUBE_UPLOAD_MODE=chunk). */
    private chunked = false,
  ) {
    this.yt = new YouTube(oauthJson, fetcher);
  }

  /** Uploads the video private, or, given the job's earlier step with an uploaded video, revises that one: the same
   *  file keeps the video and changes only what differs; another file replaces it. */
  async start(post: OutgoingPost, previous?: Step): Promise<Step> {
    let roles: ReturnType<typeof rolesOf>;
    try {
      roles = rolesOf(post.media);
    } catch (e) {
      if (e instanceof MediaRolesError) return { state: "failed", data: {}, error: e.message };
      throw e;
    }
    const settings = post.settings ?? youtubeSettings(post.options, {});
    const meta = metaOf(post, settings.madeForKids, settings.category);
    const old = previous?.data as Partial<UploadData> | undefined;
    if (old?.videoId) {
      if (old.videoChecksum === roles.video.checksum) {
        const revised = await this.revise(old as UploadData, post, roles, meta, settings.privacy);
        if (revised) return revised;
      } else await this.yt.deleteVideo(old.videoId);
    }

    const { size, mime } = await this.probe(roles.video.url);
    const session = await this.yt.startUpload(meta, size, mime);
    const data: UploadData = {
      phase: "uploading",
      session,
      size,
      offset: 0,
      videoChecksum: roles.video.checksum,
      captions: {},
      pending: { captions: roles.subtitles.map((s) => s.lang), dropCaptions: [], thumbnail: !!roles.thumbnail },
      post: { media: post.media },
      meta,
      privacy: settings.privacy,
    };
    return { state: "processing", data: data as unknown as Record<string, unknown> };
  }

  /** The same video file: new texts and settings (still private), and only the tracks and thumbnail that changed.
   *  Null when the video is gone from YouTube (it is uploaded again). */
  private async revise(
    old: UploadData,
    post: OutgoingPost,
    roles: ReturnType<typeof rolesOf>,
    meta: VideoMeta,
    privacy: "public" | "unlisted",
  ): Promise<Step | null> {
    const id = old.videoId as string;
    const state = await this.yt.videoState(id);
    if (!state) return null;
    await this.yt.updateVideo(id, meta, { ...writable(state.status), privacyStatus: "private" });
    const langs = new Set(roles.subtitles.map((s) => s.lang));
    const thumbnail = roles.thumbnail;
    const data: UploadData = {
      phase: "extras",
      size: old.size,
      videoId: id,
      videoChecksum: old.videoChecksum,
      captions: { ...old.captions },
      ...(old.thumbnailMd5 ? { thumbnailMd5: old.thumbnailMd5 } : {}),
      pending: {
        captions: roles.subtitles.filter((s) => old.captions[s.lang]?.md5 !== s.ref.checksum).map((s) => s.lang),
        dropCaptions: Object.keys(old.captions).filter((lang) => !langs.has(lang)),
        thumbnail: !!thumbnail && thumbnail.checksum !== old.thumbnailMd5,
      },
      post: { media: post.media },
      meta,
      privacy,
    };
    return { state: "processing", data: data as unknown as Record<string, unknown> };
  }

  /** The file's size and type from a one-byte range read, without downloading it. */
  private async probe(url: string): Promise<{ size: number; mime: string }> {
    const r = await this.fetcher(url, { headers: { Range: "bytes=0-0" } });
    await r.body?.cancel();
    const total = /\/(\d+)$/.exec(r.headers.get("Content-Range") ?? "")?.[1];
    const size = r.status === 206 && total ? Number(total) : Number(r.headers.get("Content-Length"));
    if (!r.ok || !(size > 0)) throw new Error(`the video's link answered ${r.status} without a size`);
    const type = r.headers.get("Content-Type") ?? "";
    // YouTube takes video/* when the store doesn't say what kind of video it is
    return { size, mime: type.startsWith("video/") ? type : "video/*" };
  }

  /** One phase per run. QuotaExceeded and SessionGone go through to the tick, which waits or starts again. */
  async check(step: Step): Promise<Step> {
    const d = step.data as unknown as UploadData;
    const next = (data: UploadData, state: Step["state"] = "processing"): Step => ({
      state,
      data: data as unknown as Record<string, unknown>,
    });
    switch (d.phase) {
      case "uploading":
        return next(await this.upload(d));
      case "extras":
        return next(await this.extras(d));
      case "processing": {
        const v = await this.yt.videoState(d.videoId as string);
        if (!v) return { ...step, state: "failed", error: "the video is gone from YouTube" };
        if (v.uploadStatus === "rejected" || v.uploadStatus === "failed")
          return {
            ...step,
            state: "failed",
            error: `YouTube ${v.uploadStatus} the video: ${v.rejectionReason ?? v.failureReason ?? "no reason given"}`,
          };
        // processed: ready, and the tick holds it private until its due time
        return v.uploadStatus === "processed" ? next({ ...d, phase: "waiting" }, "ready") : next(d);
      }
      case "waiting":
        return next(d, "ready");
      default:
        return { ...step, state: "failed", error: `unknown upload phase ${String(d.phase)}` };
    }
  }

  /** Sends what YouTube doesn't hold yet, from the offset it reports; a cut-off leaves the rest for the next run. */
  private async upload(d: UploadData): Promise<UploadData> {
    const session = d.session as string;
    const video = rolesOf(d.post.media).video;
    let r = await this.yt.uploadOffset(session, d.size);
    if (!r.videoId)
      r = await this.yt.uploadFrom(session, video.url, r.offset, d.size, {
        budgetMs: UPLOAD_BUDGET_S * 1000,
        ...(this.chunked ? { chunkBytes: CHUNK_BYTES } : {}),
      });
    if (!r.videoId) return { ...d, offset: r.offset };
    const { session: _s, ...rest } = d;
    return { ...rest, offset: d.size, videoId: r.videoId, phase: "extras" };
  }

  /**
   * Dropped tracks, then new or changed subtitles, then the thumbnail. Each is recorded as it lands, so a retry never
   * duplicates a track: an error after something landed returns the progress (the failing call is tried again next
   * run); an error before anything landed goes to the tick.
   */
  private async extras(d: UploadData): Promise<UploadData> {
    const id = d.videoId as string;
    const roles = rolesOf(d.post.media);
    let cur: UploadData = { ...d, captions: { ...d.captions }, pending: { ...d.pending } };
    let landed = false;
    try {
      for (const lang of d.pending.dropCaptions) {
        const track = cur.captions[lang];
        if (track) await this.yt.deleteCaption(track.trackId);
        const { [lang]: _gone, ...captions } = cur.captions;
        cur = { ...cur, captions, pending: { ...cur.pending, dropCaptions: cur.pending.dropCaptions.slice(1) } };
        landed = true;
      }
      for (const lang of d.pending.captions) {
        const sub = roles.subtitles.find((s) => s.lang === lang);
        const old = cur.captions[lang];
        if (old) {
          // a changed file: the old track goes first, so the language never has two
          await this.yt.deleteCaption(old.trackId);
          const { [lang]: _replaced, ...captions } = cur.captions;
          cur = { ...cur, captions };
          landed = true;
        }
        if (sub) {
          const trackId = await this.yt.insertCaption(id, lang, sub.ref.url, lang);
          cur = { ...cur, captions: { ...cur.captions, [lang]: { trackId, md5: sub.ref.checksum } } };
        }
        cur = { ...cur, pending: { ...cur.pending, captions: cur.pending.captions.slice(1) } };
        landed = true;
      }
      if (d.pending.thumbnail && roles.thumbnail) cur = await this.thumbnail(cur, id, roles.thumbnail);
      return { ...cur, pending: { ...cur.pending, thumbnail: false }, phase: "processing" };
    } catch (e) {
      if (landed) return cur;
      throw e;
    }
  }

  /** A thumbnail YouTube refuses (a channel without custom thumbnails, an image it won't take) doesn't stop the
   *  video: the step records it for a note. Quota and server errors go on as any other (QuotaExceeded isn't a
   *  YouTubeRefused). */
  private async thumbnail(d: UploadData, id: string, file: OutgoingMedia): Promise<UploadData> {
    try {
      await this.yt.setThumbnail(id, file.url);
      return { ...d, thumbnailMd5: file.checksum, thumbnailRefused: false };
    } catch (e) {
      const refused = e instanceof YouTubeRefused && e.status < 500 && e.message.startsWith("youtube thumbnails.set:");
      if (!refused) throw e;
      return { ...d, thumbnailRefused: true };
    }
  }

  /** Public (or unlisted) now: the status read and written back whole, then read again to see YouTube kept it. */
  async finish(step: Step): Promise<Published> {
    const d = step.data as unknown as UploadData;
    const id = d.videoId as string;
    const before = await this.state(id);
    await this.yt.updateVideo(id, d.meta, { ...writable(before.status), privacyStatus: d.privacy });
    const after = await this.state(id);
    if (after.privacyStatus === "private") throw new YouTubeLocked();
    // publishedAt null: the tick records its own clock
    return {
      mediaId: id,
      permalink: youtubePermalink(id, after.seconds, after.width, after.height),
      publishedAt: null,
    };
  }

  private async state(id: string): Promise<VideoState> {
    const v = await this.yt.videoState(id);
    if (!v) throw new Error("the video is gone from YouTube");
    return v;
  }

  /** Deletes the uploaded private video, if there is one; best effort (it may already be gone). */
  async discard(step: Step): Promise<void> {
    const id = (step.data as Partial<UploadData>).videoId;
    if (id) await this.yt.deleteVideo(id).catch(() => {});
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
