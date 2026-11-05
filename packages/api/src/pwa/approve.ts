// Approving from the app. The owner sees an item as it would be published (media streamed
// from the media store, caption, self-comment, alt texts, time), confirms with a passkey, and the server appends the
// approval in D1. The passkey challenge is bound to a snapshot of what was shown; at verify time
// the item is resolved again and must match it exactly, so nothing can change between looking and approving.
import { captionRules, findAccount } from "@bongsu/core/accounts";
import {
  addApproval,
  contentPaths,
  dbMedia,
  getItem,
  isPosted,
  itemDue,
  itemOptions,
  keyClass,
  latestApprovals,
  readText,
} from "@bongsu/core/data";
import type { Env } from "@bongsu/core/env";
import { sha256Hex } from "@bongsu/core/formats/approved";
import type { Check } from "@bongsu/core/formats/caption-lint";
import { altLines, captionText, comment2Text, commentText } from "@bongsu/core/formats/texts";
import { mediaStores } from "@bongsu/core/media/index";
import { isMedia, isVideo, type MediaEntry } from "@bongsu/core/media/store";
import { platform } from "@bongsu/core/platforms/index";
import { type Format, formatLabel } from "@bongsu/core/platforms/types";
import { workspaceSettings } from "@bongsu/core/workspaces";

export interface Resolved {
  key: string;
  kind: "reel" | "post"; // the app's older view of the format (#116 moves it to `postFormat`)
  /** One of the platform's formats; null = decided by the media. */
  postFormat: Format | null;
  /** The platform's options for this post (Instagram: location, coverMs, trial). */
  options: Record<string, unknown>;
  /** The account's platform, and what it calls this post ("Reel"…). */
  platform: string;
  label: string;
  account: string;
  due: string | null; // "YYYY-MM-DD HH:MM" in the viewer's zone
  dueAt: number | null; // unix seconds, what gets approved
  hold: boolean;
  posted: boolean;
  title: string | null; // the display name set in the app (null: the readable form of the name)
  format: "feed" | "story"; // a Story: one image/video, no caption or comments
  coverMs: number | null; // the chosen cover frame of a video (ms); null = 500
  location: string | null; // facebook_places_id
  content: "repo" | "db"; // where the media and texts came from (db: a draft); the texts are in D1 either way
  /** When the texts were last written and by whom ('repo' = copied from `files` by an importer); `files`: a repo item's. */
  texts: {
    at: number | null;
    by: string | null;
    files: { caption: string; comment: string; comment2: string; alt: string | null } | null;
  };
  caption: string;
  comment: string | null;
  comment2: string | null; // the second comment, posted right after the first (none when null)
  alt: string; // alt.txt as stored (fingerprinted); altLines() is what's published
  media: { store: string; id: string; checksum: string; mime: string; name: string }[];
  approved: { at: string; matches: boolean; commentsOnly?: boolean } | null; // commentsOnly: just the comments differ
  problems: string[]; // anything that blocks approval
  lint: Check[]; // the caption check's warnings (its failures are in problems)
}

export interface Snapshot {
  key: string;
  /** The account it's approved for: the approval is only good there. */
  account: string;
  dueAt: number | null;
  captionSha256: string;
  commentSha256: string | null;
  comment2Sha256: string | null;
  altSha256: string | null;
  media: string[];
}

/** An item of the workspace, with its texts and media checked for approving (null: not one of its items); `tz` is the
 *  viewer's zone, for showing its time. A Shorts comment ("comment:<video id>") resolves the same way: its text is the
 *  caption, there's no media and no time (it goes out once the video is public). */
export async function resolveItem(
  env: Env,
  fetcher: typeof fetch,
  key: string,
  tz: string,
  workspaceId: string,
): Promise<Resolved | null> {
  if (/^comment:[A-Za-z0-9_-]{11}$/.test(key)) return resolveShort(env, key, workspaceId);
  if (!/^(reel|post):[^/]+\/[^/]+$/.test(key)) return null;
  const i = await getItem(env.DB, key, workspaceId);
  if (!i) return null;
  const stores = await mediaStores(env, fetcher, workspaceId);
  const paths = contentPaths(i, (await workspaceSettings(env.DB, workspaceId)).mediaFolder);
  const problems: string[] = [];
  const db = i.content === "db";
  // The texts (D1, the copy the scheduler posts) and the media (the store) at the same time: the page's Approve waits on this.
  const textsP = Promise.all([
    readText(env.DB, paths.caption),
    readText(env.DB, paths.comment),
    paths.alt ? readText(env.DB, paths.alt) : null,
    readText(env.DB, paths.comment2),
  ]);
  type File = MediaEntry & { store: string };
  const mediaP = (async (): Promise<{ files: File[]; node: MediaEntry | null; missing: string[] }> => {
    if (i.format === "text") return { files: [], node: null, missing: [] }; // a text post has no media
    if (db) {
      // the draft's files, by id, in slide order, each from its own store
      const refs = await dbMedia(env.DB, paths.media ?? `db:${i.item_key}`);
      const other = refs
        .filter((r) => !stores.for(r))
        .map((r) => `${r.id} is on the ${r.store} store, which isn't set up`);
      const metas = await Promise.all(
        refs.filter((r) => stores.for(r)).map(async (r) => [r, await stores.for(r)!.stat(r.id)] as const),
      );
      const missing = [...other, ...metas.filter(([, m]) => !m).map(([r]) => `media file ${r.id} is gone`)];
      const files = metas.flatMap(([r, m]) => (m ? [{ ...m, store: r.store }] : []));
      return { files, node: null, missing: files.length ? missing : [...missing, "no media"] };
    }
    // an item given by path: in the default store
    const store = stores.default;
    if (!store)
      return { files: [], node: null, missing: ["no media store is set up: add one in the dashboard (Media)"] };
    const node = paths.media ? await store.resolve(paths.media) : null;
    if (!node)
      return {
        files: [],
        node,
        missing: [
          `not in the media store yet: ${paths.media ?? `${i.folder}/${i.name}`} (upload it there, or from the app's inbox)`,
        ],
      };
    if (paths.single) return { files: [{ ...node, store: store.id }], node, missing: [] };
    return {
      files: (await store.list(node.id))
        .filter((f) => isMedia(f))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((f) => ({ ...f, store: store.id })),
      node,
      missing: [],
    };
  })();
  const [[captionRaw, commentRaw, altRaw, comment2Raw], { files, node, missing }] = await Promise.all([textsP, mediaP]);
  const story = i.format === "story";
  if (captionRaw === null && !story)
    problems.push(
      db || (i.texts_by && i.texts_by !== "repo")
        ? "no caption: add one"
        : `no texts in the scheduler yet: add them in the app or with \`bongsu texts set ${key}\``,
    );
  const caption = story ? "" : captionText(captionRaw ?? "");
  const comment = story ? null : commentText(caption, commentRaw);
  const comment2 = story ? null : comment2Text(comment2Raw);
  const alt = paths.alt ? (altRaw ?? "").trim() : "";
  problems.push(...missing);
  if (story && files.length !== 1) problems.push(`a Story is one image or one video (it has ${files.length})`);
  // the caption check and the limits are the account's platform's (platforms/<id>.ts)
  const acc = await findAccount(env.DB, i.account, i.workspace_id);
  const plat = acc ? platform(acc.platform) : null;
  if (!acc || !plat) problems.push(`unknown account ${i.account}`);
  const checks = captionRaw === null || story || !plat || !acc ? [] : plat.lint(caption, captionRules(plat, acc));
  for (const f of checks.filter((x) => x.status === "FAIL"))
    problems.push(`caption ${f.check.toLowerCase()}: ${f.detail}`);
  const mediaMax = plat?.limits.mediaMax ?? 10;
  if ((db ? files.length > 0 : !!node) && !paths.single && !(files.length >= 1 && files.length <= mediaMax))
    problems.push(`${paths.media} has ${files.length} media files (1–${mediaMax})`);
  if (files.some((f) => !f.checksum))
    problems.push("the store hasn't finished processing a file: try again in a minute");
  const imageCount = files.filter((f) => !isVideo(f)).length;
  if (alt && altLines(alt).length > imageCount)
    problems.push(`alt.txt has ${altLines(alt).length} lines for ${imageCount} images`);
  const at0 = i.due_at;
  if (at0 === null) problems.push("the item has no valid date/time: schedule it first");
  const posted = await isPosted(env.DB, key);
  if (posted) problems.push("already published");
  const media = files.map((f) => ({ store: f.store, id: f.id, checksum: f.checksum, mime: f.mime, name: f.name }));
  const opts = itemOptions(i);
  const r: Resolved = {
    key,
    kind: keyClass(i.format),
    postFormat: i.format ?? null,
    options: opts,
    platform: acc?.platform ?? "unknown",
    label: formatLabel(plat, i.format),
    account: i.account,
    due: itemDue(i, tz),
    dueAt: at0,
    hold: !!i.hold,
    posted,
    title: i.title ?? null,
    format: story ? "story" : "feed",
    coverMs: typeof opts.coverMs === "number" ? opts.coverMs : null,
    location: typeof opts.location === "string" ? opts.location : null,
    content: db ? "db" : "repo",
    texts: { at: i.texts_at ?? null, by: i.texts_by ?? null, files: paths.files },
    caption,
    comment,
    comment2,
    alt,
    media,
    approved: null,
    problems,
    lint: checks.filter((x) => x.status === "WARN"),
  };
  const a = (await latestApprovals(env.DB, [key])).get(key);
  if (a && a.dueAt !== null) {
    const snap = await snapshot(r);
    const same =
      a.account === i.account &&
      a.dueAt === at0 &&
      a.captionSha256 === snap.captionSha256 &&
      (a.altSha256 ?? null) === snap.altSha256 &&
      a.media.map((x) => `${x.store}:${x.id}:${x.checksum}`).join(" ") === snap.media.join(" ");
    const comments = a.commentSha256 === snap.commentSha256 && (a.comment2Sha256 ?? null) === snap.comment2Sha256;
    r.approved = { at: a.approvedAt, matches: same && comments, commentsOnly: same && !comments };
  }
  return r;
}

/** A Shorts comment as the owner approves it: the text the scheduler will post, as the channel. */
async function resolveShort(env: Env, key: string, workspaceId: string): Promise<Resolved | null> {
  const video = key.slice("comment:".length);
  const row = await env.DB.prepare(
    "SELECT video_id, channel, file, label, text FROM shorts_comments WHERE video_id = ?1 AND workspace_id = ?2",
  )
    .bind(video, workspaceId)
    .first<{ video_id: string; channel: string; file: string; label: string | null; text: string | null }>();
  if (!row) return null;
  const problems: string[] = [];
  const text = (row.text ?? "").trim();
  if (!text)
    problems.push(
      row.file
        ? `no comment text in the scheduler: add one in the app or with \`bongsu texts set <key> --comment\``
        : "no comment text: add one",
    );
  const acc = await findAccount(env.DB, row.channel, workspaceId);
  if (!acc) problems.push(`unknown account ${row.channel}`);
  const commented = !!(await env.DB.prepare("SELECT 1 FROM shorts_commented WHERE video_id = ?1").bind(video).first());
  if (commented) problems.push("already commented");
  const r: Resolved = {
    key,
    kind: "post",
    postFormat: null,
    options: {},
    platform: acc?.platform ?? "youtube",
    label: "Shorts comment",
    account: row.channel,
    due: null,
    dueAt: 0, // no time of its own: once the video is public
    hold: false,
    posted: commented,
    title: row.label,
    format: "feed",
    coverMs: null,
    location: null,
    content: "db",
    texts: { at: null, by: null, files: null },
    caption: text,
    comment: null,
    comment2: null,
    alt: "",
    media: [],
    approved: null,
    problems,
    lint: [],
  };
  const a = (await latestApprovals(env.DB, [key])).get(key);
  if (a && a.dueAt !== null) {
    const matches = a.account === row.channel && a.captionSha256 === (await sha256Hex(text));
    r.approved = { at: a.approvedAt, matches };
  }
  return r;
}

export async function snapshot(r: Resolved): Promise<Snapshot> {
  return {
    key: r.key,
    account: r.account,
    dueAt: r.dueAt,
    captionSha256: await sha256Hex(r.caption),
    commentSha256: r.comment ? await sha256Hex(r.comment) : null,
    comment2Sha256: r.comment2 ? await sha256Hex(r.comment2) : null,
    altSha256: r.alt ? await sha256Hex(r.alt) : null,
    media: r.media.map((m) => `${m.store}:${m.id}:${m.checksum}`),
  };
}

export const sameSnapshot = (a: Snapshot, b: Snapshot) => JSON.stringify(a) === JSON.stringify(b);

/** Records the approval in D1: by `userId`, through `approvedBy` (owner@app: a passkey in the app; owner@cli: a CLI token). */
export async function writeApproval(
  env: Env,
  _fetcher: typeof fetch,
  _r: Resolved,
  s: Snapshot,
  now: Date,
  userId: string,
  approvedBy: string,
): Promise<void> {
  await addApproval(env.DB, {
    key: s.key,
    account: s.account,
    dueAt: s.dueAt,
    captionSha256: s.captionSha256,
    commentSha256: s.commentSha256,
    comment2Sha256: s.comment2Sha256,
    altSha256: s.altSha256,
    media: s.media.map((x) => {
      const [store, id, ...rest] = x.split(":");
      return { store, id, checksum: rest.join(":") };
    }),
    approvedAt: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
    approvedBy,
    userId,
  });
}
