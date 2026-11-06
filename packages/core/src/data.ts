// The plan data in D1 (see migrations/0001_init.sql): what's planned, approved, posted, the Shorts comments and
// the pause switch. D1 is the source of truth; the repo only holds the content (captions, comments, alt texts).

import { findAccount, trialCapable, trialDefaultOn } from "./accounts";
import type { Db } from "./db";
import type { Approval, MediaRef } from "./formats/approved";
import { TextsError } from "./formats/texts";
import {
  parseInstant,
  shiftDate,
  utcIso,
  zoneClock,
  zoneDate,
  zoneHourStart,
  zoneStamp,
  zoneToUnix,
} from "./formats/time";
import type { YouTubeTexts } from "./formats/youtube-texts";
import { FolderError, mediaPath } from "./media/folders";
import type { Format } from "./platforms/types";
import { jsonList } from "./sql";

/** The time a post goes out when only its date is given: videos 18:00, everything else 19:00. */
export const defaultTime = (format: Format | null | undefined) => (format === "video" ? "18:00" : "19:00");

export interface PlanItem {
  /** An opaque id: nothing parses it (older keys look like "reel:<project>/<base>"). */
  item_key: string;
  workspace_id: string;
  account: string;
  folder: string;
  name: string;
  /** When it goes out: unix seconds (UTC); null = not scheduled. */
  due_at: number | null;
  /** One of the account platform's formats; null = decided by the media at approval (an image, a carousel, a video). */
  format?: Format | null;
  /** The platform's options for this post, JSON (platforms/<id>.ts): Instagram's location, coverMs, trial. */
  options?: string | null;
  hold: number;
  note: string | null;
  sort: number;
  /** Where the texts and media live: the repo + UPLOADS/<folder>, or these columns (from a draft). */
  /** The display name set in the app (migration 0010); null = the readable form of `name`. */
  title?: string | null;
  /** When the texts columns were last written and by whom (migration 0016): 'repo' = copied from the repo files by
   *  an importer, else the editor (owner@app, an agent key's id). */
  texts_at?: number | null;
  texts_by?: string | null;
  content?: "repo" | "db";
  caption?: string | null;
  comment?: string | null;
  comment2?: string | null;
  alt?: string | null;
  /** A YouTube video's title, languages, tags and translations (JSON text, migration 0024); null: none. */
  texts?: string | null;
  media?: string | null;
  draft_id?: string | null;
}

/** An item's options, parsed. */
export function itemOptions(i: Pick<PlanItem, "options">): Record<string, unknown> {
  try {
    const o = JSON.parse(i.options || "{}") as unknown;
    return o && typeof o === "object" && !Array.isArray(o) ? (o as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The key class new items get, so their keys keep today's shape ("reel:" for videos, "post:" otherwise) and existing
 *  scripts that compute keys keep working. Keys are opaque: nothing reads the class back. */
export const keyClass = (format: Format | null | undefined) => (format === "video" ? "reel" : "post");

/** Trial Reels: an account's default (its settings; on until changed, where possible at all). */
export async function trialDefault(
  db: Db,
  accountId: string,
  workspaceId: string,
): Promise<{ capable: boolean; on: boolean }> {
  const a = await findAccount(db, accountId, workspaceId, "instagram");
  if (!a || !trialCapable(a)) return { capable: false, on: false };
  return { capable: true, on: trialDefaultOn(a) };
}

/** Whether this Reel gets a trial copy: its own switch, else the account's default. */
export async function trialFor(
  db: Db,
  i: Pick<PlanItem, "account" | "options" | "workspace_id">,
): Promise<{ capable: boolean; on: boolean; byDefault: boolean; explicit: boolean }> {
  const d = await trialDefault(db, i.account, i.workspace_id);
  const t = itemOptions(i).trial;
  const explicit = typeof t === "boolean";
  return { capable: d.capable, byDefault: d.on, explicit, on: d.capable && (explicit ? t === true : d.on) };
}

/** "<project folder>/<name>": the part of item_key after "reel:" / "post:" */
export const shortKey = (key: string) => key.replace(/^(reel|post):/, "");
export const projectOf = (folder: string) => folder.replace(/\/+$/, "").split("/").pop() ?? "";
export const lastSeg = (p: string) => p.replace(/\/+$/, "").split("/").pop() ?? "";
export const makeKey = (cls: "reel" | "post", folder: string, name: string) =>
  `${cls}:${projectOf(folder)}/${lastSeg(name)}`;

/** An item's due time as wall time in `tz`, "YYYY-MM-DD HH:MM"; null when it isn't scheduled. */
export const itemDue = (i: Pick<PlanItem, "due_at">, tz: string) =>
  i.due_at === null ? null : zoneStamp(i.due_at, tz);

export class WhenError extends Error {}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{2}:\d{2}$/;

/** The due time a caller asked for, in unix seconds. Either `at`, an instant with its zone ("2026-11-01T09:00:00Z"),
 *  or `date` / `time` as wall time in the caller's zone `tz`: a date alone keeps the item's current time (else the
 *  format's default, videos 18:00 and the rest 19:00), a time alone keeps its date. `current` is the item's due_at.
 *  undefined = nothing asked (keep it), null = unschedule (`date: null` or `at: null`). */
export function dueFrom(
  b: Record<string, unknown>,
  format: Format | null | undefined,
  tz: string,
  current: number | null = null,
): number | null | undefined {
  if (b.at !== undefined) {
    if (b.at === null || b.at === "") return null;
    const s = parseInstant(String(b.at));
    if (s === null) throw new WhenError("at must be ISO 8601 with Z or an offset, e.g. 2026-11-01T09:00:00Z");
    return s;
  }
  const hasDate = b.date !== undefined;
  const hasTime = b.time !== undefined;
  if (!hasDate && !hasTime) return undefined;
  if (hasDate && (b.date === null || b.date === "")) return null;
  const cur = current === null ? null : new Date(current * 1000);
  const date = hasDate ? String(b.date) : cur ? zoneDate(cur, tz) : null;
  if (date === null) throw new WhenError("give a date with the time");
  if (!DATE.test(date)) throw new WhenError(`date must be YYYY-MM-DD (${tz}) or null`);
  const time = hasTime
    ? b.time
      ? String(b.time)
      : defaultTime(format)
    : cur
      ? zoneClock(cur, tz)
      : defaultTime(format);
  if (!TIME.test(time)) throw new WhenError(`time must be HH:MM (${tz}) or null`);
  const s = zoneToUnix(date, time, tz);
  if (s === null) throw new WhenError(`${date} ${time} isn't a valid date and time`);
  return s;
}

/** An item's media path under the workspace's folder, or null when its folder or name would climb out of it ("..") or
 *  has an empty segment: such an item has no media, it counts as missing. */
function safePath(folder: string, rest: string): string | null {
  try {
    return mediaPath(folder, rest);
  } catch (e) {
    if (e instanceof FolderError) return null;
    throw e;
  }
}

/** Where an item's content lives. The texts are always in D1, in the item's own columns ("db:<field>:<key>", read
 *  with readText): the scheduler reads nothing from the repo. A repo item's texts are copied there
 *  from its files by an importer (examples/repo-importer); `files` names those files. The media: a
 *  'db' item's media references ("db:<key>", dbMedia), else its path in the media store under the workspace's media `folder` (null when the path isn't inside it). */
export function contentPaths(i: Pick<PlanItem, "item_key" | "format" | "folder" | "name" | "content">, folder: string) {
  const key = i.item_key;
  const video = i.format === "video";
  const texts = {
    caption: `db:caption:${key}`,
    comment: `db:comment:${key}`,
    comment2: `db:comment2:${key}`,
    alt: video ? null : (`db:alt:${key}` as string | null),
    texts: `db:texts:${key}`,
  };
  if (i.content === "db") return { ...texts, files: null, media: `db:${key}`, single: video };
  // a repo item: a video is one file (the Reel layout), anything else a folder of media (the posts layout)
  if (video) {
    const d = `channels/${i.folder}/shorts/instagram`;
    return {
      ...texts,
      files: {
        caption: `${d}/${i.name}.txt`,
        comment: `${d}/${i.name}.comment.txt`,
        comment2: `${d}/${i.name}.comment2.txt`,
        alt: null as string | null,
      },
      media: safePath(folder, `${i.folder}/exports/shorts/instagram/${i.name}.mp4`),
      single: true,
    };
  }
  const dir = `${i.folder}/${i.name.replace(/\/+$/, "")}`;
  return {
    ...texts,
    files: {
      caption: `channels/${dir}/caption.txt`,
      comment: `channels/${dir}/comment.txt`,
      comment2: `channels/${dir}/comment2.txt`,
      alt: `channels/${dir}/alt.txt` as string | null,
    },
    media: safePath(folder, dir),
    single: false,
  };
}

/** A text by its contentPaths path, from the item's D1 column. null = missing (or a repo path from a job queued
 *  before the texts moved to D1: refused as missing, approve again). */
export async function readText(db: Db, path: string): Promise<string | null> {
  const m = /^db:(caption|comment2|comment|alt|texts):(.+)$/.exec(path);
  if (!m) return null;
  const r = await db
    .prepare(`SELECT ${m[1]} AS v FROM plan_items WHERE item_key = ?1`)
    .bind(m[2])
    .first<{ v: string | null }>();
  return r?.v ? r.v : null;
}

/** Writes an item's texts (the app's Edit texts, an agent's plan_add / plan_update): only the fields given. */
export async function writeTexts(
  db: Db,
  i: Pick<PlanItem, "item_key" | "format">,
  b: Record<string, unknown>,
  by: string,
  nowS: number,
  captionMax = 2200,
) {
  const txt = (v: unknown, max: number) => {
    const s = v == null ? "" : String(v).replace(/\r\n/g, "\n").trim();
    if (s.length > max) throw new TextsError(`too long: ${s.length} characters (at most ${max})`);
    return s || null;
  };
  const sets: string[] = [],
    vals: unknown[] = [];
  for (const [f, max] of [
    ["caption", captionMax],
    ["comment", 2200],
    ["comment2", 2200],
    ["alt", 5000],
  ] as const) {
    if (!(f in b)) continue;
    if (f === "alt" && i.format === "video") throw new TextsError("alt texts are for images (a video has none)");
    vals.push(txt(b[f], max));
    sets.push(`${f} = ?${vals.length}`);
  }
  if (!sets.length) return false;
  vals.push(nowS, by, i.item_key);
  await db
    .prepare(
      `UPDATE plan_items SET ${sets.join(", ")}, texts_at = ?${vals.length - 2}, texts_by = ?${vals.length - 1}, updated_at = ?${vals.length - 2}, updated_by = ?${vals.length - 1} WHERE item_key = ?${vals.length}`,
    )
    .bind(...vals)
    .run();
  return true;
}

/** Writes a YouTube video's own texts (already checked by checkTexts: normalised, so what is stored is what approval
 *  hashes); null clears them. Stamps who and when like the other texts. */
export async function writeYouTubeTexts(
  db: Db,
  key: string,
  texts: YouTubeTexts | null,
  by: string,
  nowS: number,
): Promise<void> {
  await db
    .prepare(
      "UPDATE plan_items SET texts = ?1, texts_at = ?2, texts_by = ?3, updated_at = ?2, updated_by = ?3 WHERE item_key = ?4",
    )
    .bind(texts === null ? null : JSON.stringify(texts), nowS, by, key)
    .run();
}
export { TextsError } from "./formats/texts";

/** A 'db' item's media (store and id), in slide order. */
export async function dbMedia(db: Db, path: string): Promise<Pick<MediaRef, "store" | "id">[]> {
  const r = await db
    .prepare("SELECT media FROM plan_items WHERE item_key = ?1")
    .bind(path.replace(/^db:/, ""))
    .first<{ media: string | null }>();
  return r?.media ? (JSON.parse(r.media) as Pick<MediaRef, "store" | "id">[]) : [];
}

// ---------------------------------------------------------------- plan items

/** Due (due_at ≤ now), not on hold, not posted, for one account. */
export async function dueItems(db: Db, account: string, nowS: number): Promise<PlanItem[]> {
  const r = await db
    .prepare(
      `SELECT p.* FROM plan_items p LEFT JOIN posted x ON x.item_key = p.item_key
     WHERE p.account = ?1 AND p.due_at IS NOT NULL AND p.due_at <= ?2 AND p.hold = 0 AND x.item_key IS NULL
     ORDER BY p.due_at, p.sort`,
    )
    .bind(account, nowS)
    .all<PlanItem>();
  return r.results;
}

export interface PlanFilter {
  /** Only this workspace's items (the caller's); every workspace when absent (the scheduler itself). */
  workspaceId?: string;
  account?: string;
  /** The content channel: the folder's first part (main, vlogs, demo_running). */
  channel?: string;
  /** The project: the folder's last part (20260923_JAPAN). */
  group?: string;
  /** Only items due at or after this instant (unix seconds). */
  from?: number;
}

/** Not posted, due up to `until` (unix seconds), filtered in SQL by account / channel / group. */
export async function upcomingItems(db: Db, until: number, f: PlanFilter = {}): Promise<PlanItem[]> {
  const r = await db
    .prepare(
      `SELECT p.* FROM plan_items p LEFT JOIN posted x ON x.item_key = p.item_key
     WHERE x.item_key IS NULL AND p.due_at IS NOT NULL AND p.due_at <= ?1
       AND (CAST(?2 AS TEXT) IS NULL OR p.account = ?2)
       AND (CAST(?3 AS TEXT) IS NULL OR p.folder LIKE ?3 || '/%')
       AND (CAST(?4 AS TEXT) IS NULL OR p.folder LIKE '%/' || ?4)
       AND (CAST(?5 AS BIGINT) IS NULL OR p.due_at >= ?5)
       AND (CAST(?6 AS TEXT) IS NULL OR p.workspace_id = ?6)
     ORDER BY p.due_at, p.sort`,
    )
    .bind(until, f.account ?? null, f.channel ?? null, f.group ?? null, f.from ?? null, f.workspaceId ?? null)
    .all<PlanItem>();
  return r.results;
}

/** The channels and groups that have upcoming items (for the filters), with counts. */
export async function upcomingFacets(
  db: Db,
  until: number,
  workspaceId?: string,
): Promise<{ channel: string; group: string; n: number }[]> {
  const r = await db
    .prepare(
      `SELECT p.folder, COUNT(*) AS n FROM plan_items p LEFT JOIN posted x ON x.item_key = p.item_key
     WHERE x.item_key IS NULL AND p.due_at IS NOT NULL AND p.due_at <= ?1 AND (CAST(?2 AS TEXT) IS NULL OR p.workspace_id = ?2)
     GROUP BY p.folder ORDER BY p.folder`,
    )
    .bind(until, workspaceId ?? null)
    .all<{ folder: string; n: number }>();
  return r.results.map((x) => ({
    channel: x.folder.split("/")[0],
    group: x.folder.split("/").pop() ?? x.folder,
    n: x.n,
  }));
}

/** The item already in an account's hour slot (the hour on the clock of `tz`, the caller's zone): several items a
 *  day per account are fine, two in the same hour aren't; plan_add, plan_update and scheduling a draft refuse it. Held
 *  and posted items keep their slot. */
export async function slotTaken(db: Db, account: string, at: number, tz: string, exceptKey: string | null = null) {
  const start = zoneHourStart(at, tz);
  return db
    .prepare(
      `SELECT item_key, due_at FROM plan_items
     WHERE account = ?1 AND due_at >= ?2 AND due_at < ?3 AND item_key != ?4 AND COALESCE(format, 'feed') != 'story' LIMIT 1`,
    )
    .bind(account, start, start + 3600, exceptKey ?? "")
    .first<{ item_key: string; due_at: number }>();
}
export const slotMessage = (account: string, taken: { item_key: string; due_at: number }, tz: string) =>
  `@${account} already has ${taken.item_key} at ${zoneStamp(taken.due_at, tz)} ${tz}: one item per account per hour, pick another time`;

/** Free hours to offer when a slot is taken: the same day at the next hours (to 23:00), then the next days at
 *  the asked time, until `n` are found; wall time in `tz`, plus the instant. Same rule as slotTaken. */
export async function freeSlots(
  db: Db,
  account: string,
  at: number,
  tz: string,
  exceptKey: string | null,
  n = 4,
): Promise<{ date: string; time: string; at: string }[]> {
  const date = zoneDate(new Date(at * 1000), tz);
  const t = zoneClock(new Date(at * 1000), tz);
  const [hh, mm] = t.split(":").map(Number);
  const tries: { date: string; time: string }[] = [];
  for (let h = hh + 1; h <= 23; h++)
    tries.push({ date, time: `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}` });
  for (let k = 1; k <= 7; k++) tries.push({ date: shiftDate(date, k), time: t });
  const out: { date: string; time: string; at: string }[] = [];
  for (const c of tries) {
    if (out.length >= n) break;
    const s = zoneToUnix(c.date, c.time, tz);
    if (s !== null && !(await slotTaken(db, account, s, tz, exceptKey))) out.push({ ...c, at: utcIso(s) });
  }
  return out;
}

/** A plan item by key; with `workspaceId`, only when it belongs to that workspace (callers acting for a workspace
 *  pass theirs, so another workspace's items look absent). */
export const getItem = (db: Db, key: string, workspaceId?: string) =>
  db
    .prepare("SELECT * FROM plan_items WHERE item_key = ?1 AND (CAST(?2 AS TEXT) IS NULL OR workspace_id = ?2)")
    .bind(key, workspaceId ?? null)
    .first<PlanItem>();

// ---------------------------------------------------------------- approvals

interface ApprovalRow {
  id: number;
  item_key: string;
  account: string | null;
  due_at: number | null;
  caption_sha: string | null;
  comment_sha: string | null;
  comment2_sha?: string | null;
  alt_sha: string | null;
  media: string;
  approved_at: string;
  approved_by: string;
  user_id?: string | null;
  texts_sha?: string | null;
}

function toApproval(r: ApprovalRow): Approval {
  return {
    line: r.id,
    key: r.item_key,
    account: r.account ?? null,
    dueAt: r.due_at,
    captionSha256: r.caption_sha ?? "",
    commentSha256: r.comment_sha,
    comment2Sha256: r.comment2_sha ?? null,
    altSha256: r.alt_sha,
    media: JSON.parse(r.media) as MediaRef[],
    approvedAt: r.approved_at,
    approvedBy: r.approved_by,
    approvedByUser: r.user_id ?? null,
    textsSha256: r.texts_sha ?? null,
  };
}

/** The latest approval per key (the last row wins), for the given keys. */
export async function latestApprovals(db: Db, keys: string[]): Promise<Map<string, Approval>> {
  if (!keys.length) return new Map();
  const r = await db
    .prepare(
      `SELECT a.* FROM approvals a JOIN (SELECT item_key, MAX(id) AS id FROM approvals WHERE item_key IN ${jsonList(db, 1)} GROUP BY item_key) m ON m.id = a.id`,
    )
    .bind(JSON.stringify(keys))
    .all<ApprovalRow>();
  return new Map(r.results.map((x) => [x.item_key, toApproval(x)]));
}

/** Where an item stands with its latest approval: one for another time (the item moved) needs approving again. */
export function approvalState(
  a: Approval | undefined,
  dueAt: number | null,
): "approved" | "re-approve" | "not approved" {
  if (!a || a.dueAt === null) return "not approved";
  return a.dueAt === dueAt ? "approved" : "re-approve";
}

/** How many of the workspace's upcoming items (not held, not posted) wait for an approval or a new one. */
export async function waitingApproval(db: Db, workspaceId: string, now: number): Promise<number> {
  const r = await db
    .prepare(
      `SELECT p.item_key, p.due_at FROM plan_items p LEFT JOIN posted x ON x.item_key = p.item_key
       WHERE x.item_key IS NULL AND p.due_at > ?1 AND p.hold = 0 AND p.workspace_id = ?2`,
    )
    .bind(now, workspaceId)
    .all<{ item_key: string; due_at: number }>();
  const approvals = await latestApprovals(
    db,
    r.results.map((p) => p.item_key),
  );
  return r.results.filter((p) => approvalState(approvals.get(p.item_key), p.due_at) !== "approved").length;
}

export async function addApproval(
  db: Db,
  a: {
    key: string;
    /** The account the approval is for (the item's; a Shorts comment's channel). */
    account: string;
    dueAt: number | null;
    captionSha256: string | null;
    commentSha256: string | null;
    comment2Sha256?: string | null;
    altSha256: string | null;
    media: MediaRef[];
    approvedAt: string;
    approvedBy: string;
    /** The user who approved (null when no user was recorded). */
    userId?: string | null;
    /** sha256 of the approved texts (canonical JSON); null: the item has none. */
    textsSha256?: string | null;
  },
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO approvals (item_key, due_at, caption_sha, comment_sha, alt_sha, media, approved_at, approved_by, comment2_sha, user_id, account, texts_sha) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
    )
    .bind(
      a.key,
      a.dueAt,
      a.captionSha256,
      a.commentSha256,
      a.altSha256,
      JSON.stringify(a.media),
      a.approvedAt,
      a.approvedBy,
      a.comment2Sha256 ?? null,
      a.userId ?? null,
      a.account,
      a.textsSha256 ?? null,
    )
    .run();
}

// ---------------------------------------------------------------- posted

export const isPosted = async (db: Db, key: string) =>
  !!(await db.prepare("SELECT 1 FROM posted WHERE item_key = ?1").bind(key).first());

/** Instagram's "2026-10-18T03:31:00+0000" → unix seconds (null if it isn't one). */
export function igTime(ts: unknown): number | null {
  if (typeof ts !== "string") return null;
  const ms = Date.parse(ts.replace(/([+-]\d\d)(\d\d)$/, "$1:$2"));
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/** publishedAt: when it went live (unix seconds; Instagram's timestamp when known, else when it was recorded). */
export async function recordPosted(
  db: Db,
  p: {
    key: string;
    account: string;
    mediaId: string | null;
    permalink: string | null;
    source: "scheduler" | "manual" | "import";
    publishedAt: number;
    /** Now, in unix seconds. */
    recordedAt: number;
    workspaceId: string;
  },
): Promise<boolean> {
  const r = await db
    .prepare(
      "INSERT INTO posted (item_key, account, media_id, permalink, source, published_at, workspace_id, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) ON CONFLICT (item_key) DO NOTHING RETURNING item_key",
    )
    .bind(p.key, p.account, p.mediaId, p.permalink, p.source, p.publishedAt, p.workspaceId, p.recordedAt)
    .first();
  return !!r;
}

export const getPosted = (db: Db, key: string) =>
  db.prepare("SELECT media_id, permalink, source, published_at FROM posted WHERE item_key = ?1").bind(key).first<{
    media_id: string | null;
    permalink: string | null;
    source: string;
    published_at: number;
  }>();

// ---------------------------------------------------------------- Shorts comments

export interface ShortRow {
  video_id: string;
  /** The YouTube account's id. */
  channel: string;
  file: string;
  label: string | null /** The comment (migration 0016): copied from `file` by an importer, or given by an agent. */;
  text: string | null;
}

export async function pendingShorts(db: Db, channel: string): Promise<ShortRow[]> {
  const r = await db
    .prepare(
      `SELECT s.video_id, s.channel, s.file, s.label, s.text FROM shorts_comments s LEFT JOIN shorts_commented d ON d.video_id = s.video_id
     WHERE s.channel = ?1 AND d.video_id IS NULL ORDER BY s.sort`,
    )
    .bind(channel)
    .all<ShortRow>();
  return r.results;
}

export async function recordCommented(
  db: Db,
  c: {
    video: string;
    channel: string;
    datePt: string;
    threadId: string | null;
    label: string | null;
    source: "scheduler" | "manual" | "import";
    workspaceId: string;
  },
) {
  await db
    .prepare(
      "INSERT INTO shorts_commented (video_id, channel, date_pt, thread_id, label, source, workspace_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT (video_id) DO NOTHING",
    )
    .bind(c.video, c.channel, c.datePt, c.threadId, c.label, c.source, c.workspaceId)
    .run();
}

// ---------------------------------------------------------------- pause switch
// Each workspace pauses on its own (workspace_settings.paused: {reason, by, userId?, at}, NULL while running): the tick
// skips a paused workspace's jobs and Shorts comments, and every other workspace goes on publishing.

/** A pause: `by` is text (a key's name, or the person's name when paused); `userId` is the person, when one paused
 *  (absent on a key's pause and on pauses stored before 0023, which show `by`). */
export interface Pause {
  reason: string;
  by: string;
  userId?: string;
  at: string;
}

export async function pausedState(db: Db, workspaceId: string): Promise<Pause | null> {
  const r = await db
    .prepare("SELECT paused FROM workspace_settings WHERE workspace_id = ?1")
    .bind(workspaceId)
    .first<{ paused: string | null }>();
  return r?.paused ? JSON.parse(r.paused) : null;
}

/** Pauses the workspace; false when it already was. A workspace without settings yet gets them (the defaults
 *  workspaceSettings reads for one without). */
export async function setPaused(
  db: Db,
  workspaceId: string,
  reason: string,
  by: { userId?: string; text: string },
  now: Date,
): Promise<boolean> {
  const pause: Pause = {
    reason: reason.slice(0, 300),
    by: by.text,
    ...(by.userId ? { userId: by.userId } : {}),
    at: now.toISOString(),
  };
  const r = await db
    .prepare(
      `INSERT INTO workspace_settings (workspace_id, timezone, digest_hour, locale, updated_at, paused)
       VALUES (?1, 'UTC', 8, 'en', ?2, ?3)
       ON CONFLICT (workspace_id) DO UPDATE SET paused = excluded.paused, updated_at = excluded.updated_at
       WHERE workspace_settings.paused IS NULL
       RETURNING workspace_id`,
    )
    .bind(workspaceId, Math.floor(now.getTime() / 1000), JSON.stringify(pause))
    .first();
  return !!r;
}

/** Resumes the workspace; false when it wasn't paused. */
export async function clearPaused(db: Db, workspaceId: string): Promise<boolean> {
  return !!(await db
    .prepare(
      "UPDATE workspace_settings SET paused = NULL WHERE workspace_id = ?1 AND paused IS NOT NULL RETURNING workspace_id",
    )
    .bind(workspaceId)
    .first());
}

/** Why the scheduler leaves a workspace alone this run: it's paused (audited when it was paused), or archived. */
export type Held = "paused" | "archived";

/** The workspaces the scheduler leaves alone this run: the paused ones and the archived ones. Read once per run
 *  (tick). */
export async function heldWorkspaces(db: Db): Promise<Map<string, Held>> {
  const r = await db
    .prepare(
      `SELECT w.id, w.archived_at FROM workspaces w LEFT JOIN workspace_settings s ON s.workspace_id = w.id
       WHERE w.archived_at IS NOT NULL OR s.paused IS NOT NULL`,
    )
    .all<{ id: string; archived_at: number | null }>();
  return new Map(r.results.map((x) => [x.id, x.archived_at === null ? "paused" : "archived"]));
}
