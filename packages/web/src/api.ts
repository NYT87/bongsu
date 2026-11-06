// The app's only backend: /app-api on the same origin (the scheduler Worker), with the session cookie.
import type { YouTubeTexts } from "@bongsu/core/formats/youtube-texts";
import type { YouTubeSettings } from "@bongsu/core/platforms/youtube";
import type { UploadProgress } from "@bongsu/core/upload-progress";

export type { UploadProgress, YouTubeSettings, YouTubeTexts };

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public body: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export async function api<T = Record<string, unknown>>(
  path: string,
  body?: unknown,
  method: "GET" | "POST" | "PUT" = body === undefined ? "GET" : "POST",
): Promise<T> {
  const r = await fetch(`/app-api/${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (!r.ok) throw new HttpError(r.status, String(data.error ?? r.statusText), data);
  return data as T;
}

/** Move the app's session to another workspace the person can open; 403 when they can't (any more). */
export const switchWorkspace = (id: string) => api<{ ok: true; id: string }>("session/workspace", { id });

/** The five kinds of notification a member gets from a workspace (core/notify-prefs.ts), in this order. */
export type NoteGroup = "needs_you" | "problems" | "published" | "inbox" | "digest";
/** The signed-in person's groups in the session's workspace: on or off, and whether that's still their role's default. */
export type NotifyPrefs = { groups: { grp: NoteGroup; enabled: boolean; isDefault: boolean }[] };
export const notifyPrefs = () => api<NotifyPrefs>("notify-prefs");
export const setNotifyPref = (grp: NoteGroup, enabled: boolean) =>
  api<NotifyPrefs>("notify-prefs", { grp, enabled }, "PUT");

export interface QueueItem {
  key: string;
  /** The account's platform, and what it calls this post ("Reel"…). */
  platform: string;
  label: string;
  account: string;
  due: string | null;
  folder: string;
  name: string;
  title?: string | null;
  /** One of the platform's formats (video, image, carousel, story, text); null = decided by its media. */
  format: string | null;
  options: Record<string, unknown>;
  hold: boolean;
  approved: boolean;
  approval_matches_schedule: boolean;
}
export interface Results {
  views: number | null;
  reach: number | null;
  likes: number | null;
  comments: number | null;
  saves: number | null;
  shares: number | null;
  /** The followers the post brought and its profile visits; null when the platform didn't report them. */
  follows: number | null;
  profile_visits: number | null;
  median_views: number | null;
  fetched_at: number;
}
/** One sample of a metrics series (unix seconds), or, with `daily`, one day's growth (null: no sample that day). */
export interface MetricPoint {
  at: number;
  views: number | null;
  reach: number | null;
  likes: number | null;
  comments: number | null;
  saves: number | null;
  shares: number | null;
  follows: number | null;
  profile_visits: number | null;
}
/** `/app-api/item/metrics` and `/app-api/video/metrics`: the series, and the Trial Reel copy's when it was posted. */
export interface Metrics {
  item: {
    key: string;
    platform: string;
    account: string;
    label: string;
    published_at: string | null;
    due: string | null;
    due_at: string | null;
  };
  samples: MetricPoint[];
  trial?: { samples: MetricPoint[] };
  /** A video's: whether the channel's connection holds the analytics scope (subscribers gained). */
  analytics?: boolean;
}
export interface Item {
  key: string;
  platform: string;
  /** What the platform calls it ("Reel"…). */
  label: string;
  /** One of the platform's formats; null = decided by its media. */
  postFormat: string | null;
  options: Record<string, unknown>;
  account: string;
  due: string | null;
  hold: boolean;
  posted: boolean;
  content: "repo" | "db";
  title?: string | null;
  /** Where the texts (the scheduler's copy) came from: 'repo' = copied from `files` by an importer, else who edited them. */
  texts?: { at: number | null; by: string | null; files: { caption: string } | null };
  format?: "feed" | "story";
  coverMs?: number | null;
  location?: string | null;
  published: { at: string; permalink: string | null } | null;
  caption: string;
  comment: string | null;
  comment2?: string | null;
  alt: string;
  media: { store: string; id: string; checksum: string; mime: string; name: string; url: string }[];
  approved: { at: string; matches: boolean; commentsOnly?: boolean; by?: string | null } | null;
  problems: string[];
  lint?: { check: string; status: string; detail: string }[];
  results?: Results | null;
  /** The Trial Reel copy, on accounts that post one (null otherwise): planned → pending … → published. */
  trial?: {
    on: boolean;
    byDefault: boolean;
    explicit: boolean;
    state: string;
    error: string | null;
    permalink: string | null;
    at: string | null;
    results: Results | null;
  } | null;
  /** Its job failed: why, and whether approving again starts it over (not when the post may be live). */
  failed?: { error: string | null; again: boolean } | null;
  /** The server's fingerprint of what's shown; approving sends it back and is refused if the item changed since. */
  fingerprint?: string;
  /** What a YouTube video adds to the approval: its texts, the subtitle files and thumbnail among `media` (by
   *  name), and the settings it goes out with; null off YouTube. */
  youtube?: {
    texts: YouTubeTexts | null;
    subtitles: { lang: string; name: string }[];
    thumbnail: string | null;
    roles: string[];
    settings: YouTubeSettings;
    /** The channel's own defaults: a setting equal to one is sent as null, so the video follows the channel. */
    channel: YouTubeSettings;
  } | null;
  /** A YouTube upload's phase while its job runs (core/upload-progress.ts); null otherwise. */
  progress?: UploadProgress;
}

/** `/app-api/stats/channel`: an account's page over a period (days on the workspace's clock). */
export interface ChannelStats {
  account: {
    id: string;
    platform: string;
    title: string;
    url: string | null;
    followers: number | null;
    change: number | null;
    since: string | null;
  };
  followers: { total: { at: number; value: number | null }[]; daily: { at: number; value: number | null }[] };
  views: { at: number; value: number | null }[];
  brought: {
    key: string;
    title: string;
    platform: string;
    follows: number;
    share: number | null;
    href: string;
    source?: "bongsu" | "elsewhere";
  }[];
  /** A YouTube channel's: whether its connection holds the analytics scope; null for Instagram. */
  analytics: boolean | null;
}
