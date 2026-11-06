// YouTube: Bongsu publishes videos here (uploaded private ahead of time, made public at the due time by the provider)
// and comments on videos published elsewhere (the Shorts comments, as each channel).
import { LANG } from "../formats/youtube-texts";
import { isVideo } from "../media/store";
import { NO_FEATURES, NO_LINT, type Platform } from "./types";

export const THUMBNAIL_MAX = 52428800;
const DESCRIPTION_MAX = 5000;
/** YouTube counts a video as a Short up to this long (and vertical). */
const SHORT_MAX_S = 180;

export const youtube: Platform = {
  id: "youtube",
  name: "YouTube",
  formats: ["video"],
  // The video is uploaded this long before it is due, so processing is done by then.
  uploadLeadS: 21600,
  labels: { video: { name: "Video", plural: "Videos" }, post: { name: "Video", plural: "Videos" } },
  accountNoun: "channel",
  limits: { mediaMax: 1, videoSecondsMax: 60 * 60 * 12, captionMax: DESCRIPTION_MAX },
  features: { ...NO_FEATURES, comments: true, commentOnExisting: true, firstComment: true },
  options: [
    { key: "madeForKids", type: "boolean", label: "Made for kids" },
    { key: "privacy", type: "string", label: "Visibility", pattern: /^(public|unlisted)$/ },
    { key: "category", type: "string", label: "Category", pattern: /^[0-9]{1,3}$/ },
  ],
  lint: (caption) => {
    if (caption.length > DESCRIPTION_MAX)
      return [
        {
          check: "Length",
          status: "FAIL",
          detail: `${caption.length} characters: YouTube allows ${DESCRIPTION_MAX} in a description`,
        },
      ];
    if (/[<>]/.test(caption))
      return [{ check: "Angle brackets", status: "FAIL", detail: "YouTube refuses < and > in a description" }];
    return [];
  },
  lintDefaults: NO_LINT,
};

export interface RoleEntry<T> {
  name: string;
  mime: string;
  size: number;
  ref: T;
}

export interface MediaRoles<T> {
  video: T;
  subtitles: { lang: string; ref: T }[];
  thumbnail?: T;
}

export class MediaRolesError extends Error {}

const SUBTITLE = /^(.+)\.(srt|vtt)$/;
const THUMBNAIL = /^thumbnail\.(jpg|png)$/;

/** Tells the files of a YouTube item apart by name: the video, `<lang>.srt|vtt` subtitles, `thumbnail.jpg|png`. */
export function mediaRoles<T>(entries: RoleEntry<T>[]): MediaRoles<T> {
  const videos: T[] = [];
  const subtitles: { lang: string; ref: T }[] = [];
  let thumbnail: T | undefined;
  for (const e of entries) {
    const sub = SUBTITLE.exec(e.name);
    if (isVideo(e)) videos.push(e.ref);
    else if (sub && LANG.test(sub[1])) {
      if (subtitles.some((s) => s.lang === sub[1]))
        throw new MediaRolesError(`two subtitle files for ${sub[1]}: keep one`);
      subtitles.push({ lang: sub[1], ref: e.ref });
    } else if (THUMBNAIL.test(e.name)) {
      if (thumbnail !== undefined) throw new MediaRolesError("one thumbnail per video");
      if (e.size > THUMBNAIL_MAX) throw new MediaRolesError(`${e.name} is over 50 MB`);
      thumbnail = e.ref;
    } else
      throw new MediaRolesError(`${e.name} isn't a video, a subtitle file (<lang>.srt or .vtt) or thumbnail.jpg/png`);
  }
  if (videos.length === 0) throw new MediaRolesError("a YouTube post has no video");
  if (videos.length > 1) throw new MediaRolesError("one video per post");
  return { video: videos[0], subtitles, ...(thumbnail !== undefined ? { thumbnail } : {}) };
}

/** Shorts live at /shorts/ when YouTube treats them as one: up to 3 minutes and vertical. */
export function youtubePermalink(id: string, seconds: number | null, width: number | null, height: number | null) {
  const short = seconds !== null && seconds <= SHORT_MAX_S && width !== null && height !== null && height > width;
  return short ? `https://youtube.com/shorts/${id}` : `https://youtube.com/watch?v=${id}`;
}

export interface YouTubeSettings {
  madeForKids: boolean;
  privacy: "public" | "unlisted";
  category: string;
}

/** The post's option, else the channel's default (accounts.settings.youtube), else the built-in one. */
export function youtubeSettings(
  options: Record<string, unknown>,
  accountSettings: Record<string, unknown>,
): YouTubeSettings {
  const channel = (accountSettings.youtube ?? {}) as Record<string, unknown>;
  const madeForKids = options.madeForKids ?? channel.madeForKids;
  const category = options.category ?? channel.category;
  return {
    madeForKids: typeof madeForKids === "boolean" ? madeForKids : false,
    privacy: options.privacy === "unlisted" ? "unlisted" : "public",
    category: typeof category === "string" ? category : "22",
  };
}
