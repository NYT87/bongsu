// Every notification's wording, in one place: the tick, the digest, the inbox, the comments poll, the cleanup, the
// results and the connection check build their messages here and hand them to Notifier.send. A builder returns the
// title, the text, where the notification opens (target: an item key, "drafts", "comments", "today"…) and its
// extra buttons. Change wording here, and only here.
import type { Action } from "../notify";
import type { NoteGroup } from "../notify-prefs";

export interface Note {
  /** Who gets it: each person's settings switch groups on and off (notify-prefs.ts). */
  group: NoteGroup;
  title: string;
  text: string;
  target?: string;
  actions?: Action[];
  /** For a note that's also emailed: the subject, and the dashboard page the mail links to. */
  mail?: { subject: string; page: string };
}

// ---- jobs (the tick)

export const jobVerdict = (key: string, state: string, reason: string | null | undefined): Note => ({
  group: "problems",
  title: `${key}: ${state}`,
  text: reason ?? "",
  target: key,
});
export const jobFailed = (key: string, message: string): Note => ({
  group: "problems",
  title: `${key}: failed`,
  text: message,
  target: key,
});
/** `live`: the platform's name when the post may already be public there (the publishing call was made): the job
 *  keeps it, never deleting or redoing it, so the owner has to look at it there. */
const liveKept = (live?: string) =>
  live ? `\nIt may already be public on ${live}: it was kept, so check it there.` : "";
export const jobRefused = (key: string, reason: string, live?: string): Note => ({
  group: "problems",
  title: `${key}: refused`,
  text: `${reason}${liveKept(live)}`,
  target: key,
});
/** A job held by its plan (its item on hold) while its post may already be public on `live`. */
export const jobHeldLive = (key: string, reason: string, live: string): Note => ({
  group: "problems",
  title: `${key}: held`,
  text: `${reason}${liveKept(live)}`,
  target: key,
});
/** Held for the catch-up window; with `live` (it may already be public) it is a problem, like `jobHeldLive`. */
export const jobHeld = (key: string, hours: number, live?: string): Note => ({
  group: live ? "problems" : "needs_you",
  title: `${key}: held`,
  text: `not published within ${hours} h of its time${liveKept(live)}`,
  target: key,
});
/** `video`: the job had uploaded a private video, which stays on the platform (never deleted on a failure): "kept"
 *  after errors (it can be published by hand), "refused" when the platform rejected it (only to inspect). */
export const providerFailed = (
  key: string,
  platformName: string,
  error: string,
  video: false | "kept" | "refused" = false,
): Note => ({
  group: "problems",
  title: `${key}: failed`,
  text: `${platformName} reported: ${error}${
    video === "kept"
      ? `\nThe video is still on ${platformName}, private: inspect it there or publish it by hand.`
      : video === "refused"
        ? `\n${platformName} refused the video: it is still there, private, for you to inspect.`
        : ""
  }`,
  target: key,
});
/** YouTube's audit lock (providers/youtube.ts YouTubeLocked): the job's last_error is this text too. */
export const YOUTUBE_LOCKED =
  "YouTube keeps this video private until your Google project passes YouTube's audit (see the YouTube guide)";
export const youtubeLocked = (key: string): Note => ({
  group: "problems",
  title: `${key}: failed`,
  text: YOUTUBE_LOCKED,
  target: key,
});
/** A job's earlier video, to be revised or replaced, isn't private any more (the owner published it by hand). */
export const YOUTUBE_REPLACE_KEPT =
  "the video uploaded earlier was published or scheduled by hand on YouTube, so it was kept and nothing was " +
  "uploaded: record it as posted, or delete it there and approve again";
/** A removed item's video that isn't private any more (published by hand): never deleted. Only YouTube uploads
 *  leave a video to delete. */
export const VIDEO_KEPT_PUBLIC =
  "its video was published or scheduled by hand on YouTube, so it was kept: delete it there if it should go";
/** The sweep found a removed item's video public (the refusal, if any, came earlier): sent once. */
export const videoKept = (key: string): Note => ({
  group: "problems",
  title: `${key}: video kept`,
  text: `removed from the plan; ${VIDEO_KEPT_PUBLIC}`,
  target: key,
});
export const YOUTUBE_QUOTA = "YouTube's daily quota is used up: uploads continue after midnight Pacific time";
/** Sent once per workspace per Pacific day (the tick dedupes it in settings). */
export const youtubeQuota = (): Note => ({
  group: "problems",
  title: "YouTube quota used up",
  text: YOUTUBE_QUOTA,
});
export const youtubeThumbnailRefused = (key: string): Note => ({
  group: "problems",
  title: `${key}: thumbnail refused`,
  text: "YouTube refused the thumbnail: the channel needs YouTube's verified features (the video still goes out)",
  target: key,
});
export const processingTimeout = (key: string, platformName: string): Note => ({
  group: "problems",
  title: `${key}: failed`,
  text: `${platformName} didn't finish processing within 2 h`,
  target: key,
});
export const dryRunPublish = (key: string, kind: string, account: string, detail?: string): Note => ({
  group: "published",
  title: `dry run: would publish ${key}`,
  text: `${kind} on ${account}${detail ? `, ${detail}` : ""}`,
  target: key,
});
/** A post went out: its link, with a note on what differs (a Story vanishes; a location Instagram refused). */
export const published = (
  key: string,
  permalink: string | null,
  o: { story: boolean; locationDropped: boolean },
): Note => ({
  group: "published",
  title: `published ${o.story ? "Story " : ""}${key}`,
  text: o.story
    ? `${permalink ?? ""} (a Story: it disappears after 24 h).`
    : `${permalink ?? ""}${o.locationDropped ? " (without its location: Instagram refused it)" : ""}. Pin the self-comment in the app.`,
  target: key,
  actions: permalink ? [{ label: "Open post", url: permalink }] : [],
});
export const publishedTrial = (key: string, permalink: string | null): Note => ({
  group: "published",
  title: `published Trial Reel ${key}`,
  text: `${permalink ?? ""} — shown to non-followers first; it reaches your followers if they respond well.`,
  target: key,
  actions: permalink ? [{ label: "Open trial", url: permalink }] : [],
});

// ---- Shorts comments

export const shortsWaiting = (handle: string, accountId: string): Note => ({
  group: "needs_you",
  title: `${handle}: Shorts comments waiting`,
  text: "the account has no working connection",
  target: accountId,
});
export const dryRunComment = (label: string, text: string, key: string): Note => ({
  group: "published",
  title: `dry run: would comment on Short ${label}`,
  text,
  target: key,
});
export const commented = (label: string, key: string): Note => ({
  group: "published",
  title: `commented on Short ${label}`,
  text: "Pin it in YouTube Studio.",
  target: key,
});

// ---- the other runs

export const digest = (title: string, text: string): Note => ({
  group: "digest",
  title,
  text,
  target: "today",
});
export const newDrafts = (names: string[]): Note => ({
  group: "inbox",
  title: names.length === 1 ? "new draft from the inbox" : `${names.length} new drafts from the inbox`,
  text: `${names.join(", ")}: review in the app.`,
  target: "drafts",
});
export const newComments = (lines: string[], total: number): Note => ({
  group: "inbox",
  title: total === 1 ? "New comment" : `${total} new comments`,
  text: lines.join("\n"),
  target: "comments",
});
export const cleanupRefused = (refused: string[]): Note => ({
  group: "problems",
  title: "Media cleanup: the store refused",
  text: `${refused.join("; ")}. Those files stay where they are.`,
});
export const results = (lines: string[], target: string | undefined): Note => ({
  group: "published",
  title: lines.length === 1 ? "24 h results" : `24 h results (${lines.length})`,
  text: lines.join("\n"),
  target,
});
export const connectionProblem = (text: string): Note => ({
  group: "problems",
  title: "A connection needs attention",
  text,
});
export const connectionMailSubject = "Bongsu: a connection needs attention";
/** `own`: the store is the workspace's own, which its admins fix in Settings → Media (members can't open the instance's page). */
export const mediaStoreProblem = (text: string, own = false): Note => ({
  group: "problems",
  title: "A media store needs attention",
  text: `${text}\nIts files can't be read until it's fixed: check it in the dashboard (${own ? "Settings → Media" : "Media"}).`,
  target: "media_stores",
  mail: {
    subject: "Bongsu: a media store needs attention",
    page: own ? "/dashboard/settings/media" : "/dashboard/media",
  },
});
export const releaseMoved = (title: string, from: string, to: string, by: string): Note => ({
  group: "inbox",
  title: `Release moved: ${title}`,
  text: `from ${from} to ${to}, by ${by}`,
});
