// The agent API's operations, shared by REST (/v1) and MCP (/mcp). They read and write the
// scheduler's D1 only (the plan and the texts it posts). Nothing here can approve,
// resume or publish: approval stays with the owner (the app's passkey, or the CLI with a token made with one).

import { findAccount, listAccounts, trialCapable, trialDefaultOn, youtubeAccounts } from "@bongsu/core/accounts";
import { channelUploads } from "@bongsu/core/calendar";
import { ReleaseError } from "@bongsu/core/clients/youtube";
import { METRICS_DENSE_S, METRICS_MAX_POINTS } from "@bongsu/core/constants";
import {
  clearPaused,
  contentPaths,
  dueFrom,
  freeSlots,
  getItem,
  getPosted,
  igTime,
  itemOptions,
  keyClass,
  latestApprovals,
  makeKey,
  type PlanItem,
  pausedState,
  readText,
  recordCommented,
  recordPosted,
  setPaused,
  slotMessage,
  slotTaken,
  TextsError,
  upcomingFacets,
  upcomingItems,
  WhenError,
  writeTexts,
  writeYouTubeTexts,
} from "@bongsu/core/data";
import type { Env } from "@bongsu/core/env";
import { altLines, captionText, comment2Text, commentText } from "@bongsu/core/formats/texts";
import { shiftDate, utcIso, zoneDate, zoneStamp, zoneToUnix } from "@bongsu/core/formats/time";
import { checkTexts, parseTexts } from "@bongsu/core/formats/youtube-texts";
import { mediaStores } from "@bongsu/core/media/index";
import { assertOwns, MediaError } from "@bongsu/core/media/owns";
import { dailyGrowth, nearest24h, type Point, type Sample, series } from "@bongsu/core/metrics";
import { platform, requirePlatform } from "@bongsu/core/platforms/index";
import {
  describePlatform,
  type Format,
  formatLabel,
  OptionsError,
  type Platform,
  validateOptions,
} from "@bongsu/core/platforms/types";
import { youtubeAnalytics } from "@bongsu/core/providers/youtube";
import { moveRelease, releaseStatus } from "@bongsu/core/release";
import { jsonList } from "@bongsu/core/sql";
import { callerZone, memberName, memberNames, workspaceSettings } from "@bongsu/core/workspaces";
import { bongsuVideos } from "@bongsu/core/youtube-videos";
import type { Caller } from "./auth";

export class ApiError extends Error {
  /** extra: more for the caller next to the message (e.g. free slots after a clash). */
  constructor(
    public status: number,
    message: string,
    public extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** A clash in an account's hour: the message names the item there and lists free hours, which also come as data. */
async function slotClash(
  c: OpCtx,
  account: string,
  at: number,
  key: string,
  taken: { item_key: string; due_at: number },
) {
  const tz = await zoneOf(c);
  const free = await freeSlots(c.env.DB, account, at, tz, key);
  return new ApiError(
    409,
    `${slotMessage(account, taken, tz)}${free.length ? ` (free: ${free.map((f) => `${f.date} ${f.time}`).join(", ")})` : ""}`,
    { suggestions: free },
  );
}

export interface OpCtx {
  env: Env;
  fetch: typeof fetch;
  now: Date;
  caller: Caller;
  /** The caller's time zone, once looked up (zoneOf). */
  tz?: string;
}

/** The caller's time zone, for the dates and times it gives and reads (the database keeps UTC): the user's own, else
 *  the workspace's. */
export async function zoneOf(c: OpCtx): Promise<string> {
  c.tz ??= await callerZone(c.env.DB, c.caller.workspaceId, c.caller.userId);
  return c.tz;
}

const nowS = (c: OpCtx) => Math.floor(c.now.getTime() / 1000);
/** "YYYY-MM-DD HH:MM <zone>" for unix seconds. */
const stamp = (s: number | null, tz: string) => (s === null ? null : `${zoneStamp(s, tz)} ${tz}`);
/** ISO 8601 UTC for unix seconds. */
const iso = (s: number | null) => (s === null ? null : utcIso(s));

/** The first instant after `days` days from today on the caller's clock (exclusive end of a "next N days" range). */
const daysAhead = (c: OpCtx, tz: string, days: number) =>
  (zoneToUnix(shiftDate(zoneDate(c.now, tz), days + 1), "00:00", tz) ?? 0) - 1;

/** What the caller asked for as a due time; a bad value is a 400. */
function askedDue(b: Record<string, unknown>, format: Format | null, tz: string, current: number | null = null) {
  try {
    return dueFrom(b, format, tz, current);
  } catch (e) {
    if (e instanceof WhenError) throw new ApiError(400, e.message);
    throw e;
  }
}

/** The app's caller is the signed-in person (its id is theirs); a CLI token (a person's) or an agent key is a key. */
const inApp = (c: OpCtx) => !!c.caller.userId && c.caller.id === c.caller.userId;

export async function audit(c: OpCtx, action: string, target: string | null, detail: unknown) {
  await c.env.DB.prepare(
    "INSERT INTO audit (at, actor, action, target, detail, user_id, workspace_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
  )
    .bind(
      nowS(c),
      inApp(c) ? `user:${c.caller.id}` : `key:${c.caller.id}`,
      action,
      target,
      JSON.stringify(detail),
      c.caller.userId ?? null,
      c.caller.workspaceId,
    )
    .run();
}

// ---------------------------------------------------------------- reads

export async function status(c: OpCtx) {
  const tz = await zoneOf(c);
  const p = await pausedState(c.env.DB, c.caller.workspaceId);
  // who paused: the person as the workspace names them now; a key's pause (or one stored before people had ids) its text
  const pausedBy = p ? ((p.userId ? await memberName(c.env.DB, p.userId, c.caller.workspaceId) : null) ?? p.by) : null;
  const states = await c.env.DB.prepare(
    "SELECT state, dry_run, COUNT(*) AS n FROM jobs WHERE updated_at >= ?1 AND workspace_id = ?2 GROUP BY state, dry_run",
  )
    .bind(nowS(c) - 7 * 86400, c.caller.workspaceId)
    .all<{ state: string; dry_run: number; n: number }>();
  return {
    dry_run: c.env.DRY_RUN !== "0",
    paused: p !== null,
    paused_by: pausedBy,
    today: zoneDate(c.now, tz),
    timezone: tz,
    jobs_last_7_days: states.results.map((r) => ({ state: r.state, mode: r.dry_run ? "dry" : "live", n: r.n })),
    accounts: await accountIds(c),
  };
}

interface QueueItem {
  key: string;
  /** The account's platform. */
  platform: string;
  /** What the platform calls it ("Reel", "Post"…). */
  label: string;
  /** Older clients' view of the format: "reel" for a video, "post" otherwise. */
  kind: "reel" | "post";
  account: string;
  /** In the caller's zone, "YYYY-MM-DD HH:MM <zone>". */
  due: string | null;
  /** The same instant, ISO 8601 UTC. */
  due_at: string | null;
  folder: string;
  name: string;
  title: string | null;
  /** One of the platform's formats; null = decided by the media at approval. */
  format: Format | null;
  options: Record<string, unknown>;
  hold: boolean;
  approved: boolean;
  approval_matches_schedule: boolean;
  note: string | null;
}

const FILTER = /^[A-Za-z0-9_.-]{1,80}$/;

export async function listAccountsOp(c: OpCtx) {
  const all = await listAccounts(c.env.DB, { workspaceId: c.caller.workspaceId });
  return {
    accounts: all.map((a) => ({
      id: a.id,
      platform: a.platform,
      handle: a.handle,
      name: a.displayName ?? a.handle,
      connected: !!a.connection && a.connection.status !== "broken",
      ...(() => {
        // what can be planned for it, and how (its platform's formats, options and features)
        const p = platform(a.platform);
        if (!p) return {};
        const d = describePlatform(p);
        return {
          platform_name: d.name,
          formats: d.formats.map((f) => ({ format: f.format, name: f.name })),
          options: d.options.map((o) => ({ key: o.key, type: o.type, label: o.label, formats: o.formats })),
          features: Object.entries(d.features)
            .filter(([, on]) => on)
            .map(([f]) => f),
        };
      })(),
      ...(platform(a.platform)?.features.trial
        ? { trial_reels: trialCapable(a) ? (trialDefaultOn(a) ? "on" : "off") : "not possible" }
        : {}),
    })),
  };
}

export async function queue(
  c: OpCtx,
  opts: { days?: number; account?: string; channel?: string; group?: string; from?: string } = {},
) {
  const tz = await zoneOf(c);
  const days = Math.min(Math.max(opts.days ?? 14, 1), 120);
  for (const [k, v] of Object.entries({ account: opts.account, channel: opts.channel, group: opts.group })) {
    if (v !== undefined && v !== "" && !FILTER.test(v)) throw new ApiError(400, `bad ${k}`);
  }
  if (opts.from && !/^\d{4}-\d{2}-\d{2}$/.test(opts.from)) throw new ApiError(400, `from must be YYYY-MM-DD (${tz})`);
  const items = await upcomingItems(c.env.DB, daysAhead(c, tz, days), {
    workspaceId: c.caller.workspaceId,
    account: opts.account || undefined,
    channel: opts.channel || undefined,
    group: opts.group || undefined,
    from: opts.from ? (zoneToUnix(opts.from, "00:00", tz) ?? undefined) : undefined,
  });
  const approvals = await latestApprovals(
    c.env.DB,
    items.map((i) => i.item_key),
  );
  const platformOf = new Map(
    (await listAccounts(c.env.DB, { workspaceId: c.caller.workspaceId, all: true })).map((a) => [a.id, a.platform]),
  );
  const out: QueueItem[] = items.map((i) => {
    const a = approvals.get(i.item_key);
    const due = i.due_at;
    const plat = platformOf.get(i.account) ?? "unknown";
    return {
      key: i.item_key,
      platform: plat,
      label: formatLabel(platform(plat), i.format),
      kind: keyClass(i.format),
      account: i.account,
      due: stamp(due, tz),
      due_at: iso(due),
      folder: i.folder,
      name: i.name,
      title: i.title ?? null,
      format: i.format ?? null,
      options: itemOptions(i),
      hold: !!i.hold,
      approved: !!a && a.dueAt !== null,
      approval_matches_schedule: !!a && a.dueAt !== null && a.dueAt === due,
      note: i.note,
    };
  });
  return { timezone: tz, until: shiftDate(zoneDate(c.now, tz), days), items: out };
}

/** The channels and groups with upcoming items, for the queue filters. */
export async function queueFacets(c: OpCtx, opts: { days?: number } = {}) {
  const tz = await zoneOf(c);
  const days = Math.min(Math.max(opts.days ?? 14, 1), 120);
  const rows = await upcomingFacets(c.env.DB, daysAhead(c, tz, days), c.caller.workspaceId);
  const channels = [...new Set(rows.map((r) => r.channel))].map((ch) => ({
    channel: ch,
    n: rows.filter((r) => r.channel === ch).reduce((s, r) => s + r.n, 0),
  }));
  return { until: shiftDate(zoneDate(c.now, tz), days), channels, groups: rows };
}

export interface ExportRow {
  key: string;
  account: string;
  platform: string;
  format: string | null;
  due: string | null;
  due_at: string | null;
  hold: boolean;
  approved: boolean;
  approval_matches: boolean;
  approved_at: string | null;
  posted_media_id: string | null;
  posted_permalink: string | null;
  published_at: string | null;
  note: string | null;
  caption?: string;
  comment?: string | null;
  comment2?: string | null;
  alt?: string[];
}

/** Every plan item of the caller's workspace, past and future, for backups and reports (`bongsu export`).
 *  The texts cost one read per text, so they come only when asked for. */
export async function exportPlan(c: OpCtx, opts: { texts?: boolean } = {}) {
  const tz = await zoneOf(c);
  const db = c.env.DB;
  const workspaceId = c.caller.workspaceId;
  const items = (
    await db
      .prepare(
        "SELECT item_key, account, folder, name, due_at, format, hold, note, content FROM plan_items WHERE workspace_id = ?1 ORDER BY due_at, sort",
      )
      .bind(workspaceId)
      .all<
        Pick<PlanItem, "item_key" | "account" | "folder" | "name" | "due_at" | "format" | "hold" | "note" | "content">
      >()
  ).results;
  const approvals = await latestApprovals(
    db,
    items.map((i) => i.item_key),
  );
  const posted = new Map(
    (
      await db
        .prepare("SELECT item_key, media_id, permalink, published_at FROM posted WHERE workspace_id = ?1")
        .bind(workspaceId)
        .all<{ item_key: string; media_id: string | null; permalink: string | null; published_at: number | null }>()
    ).results.map((p) => [p.item_key, p]),
  );
  const platformOf = new Map((await listAccounts(db, { workspaceId, all: true })).map((a) => [a.id, a.platform]));
  const folder = (await workspaceSettings(db, workspaceId)).mediaFolder;
  const rows: ExportRow[] = [];
  for (const i of items) {
    const a = approvals.get(i.item_key);
    const p = posted.get(i.item_key);
    const row: ExportRow = {
      key: i.item_key,
      account: i.account,
      platform: platformOf.get(i.account) ?? "unknown",
      format: i.format ?? null,
      due: stamp(i.due_at, tz),
      due_at: iso(i.due_at),
      hold: !!i.hold,
      approved: !!a && a.dueAt !== null,
      approval_matches: !!a && a.dueAt !== null && a.dueAt === i.due_at,
      approved_at: a?.approvedAt ?? null,
      posted_media_id: p?.media_id ?? null,
      posted_permalink: p?.permalink ?? null,
      published_at: iso(p?.published_at ?? null),
      note: i.note,
    };
    if (opts.texts) {
      const paths = contentPaths(i, folder);
      const caption = captionText((await readText(db, paths.caption)) ?? "");
      row.caption = caption;
      row.comment = commentText(caption, await readText(db, paths.comment));
      row.comment2 = comment2Text(await readText(db, paths.comment2));
      if (paths.alt) row.alt = altLines((await readText(db, paths.alt)) ?? "");
    }
    rows.push(row);
  }
  return { timezone: tz, items: rows };
}

/** One planned item's texts as they'd be published, its approval and whether it's been posted. */
export async function item(c: OpCtx, key: string) {
  const tz = await zoneOf(c);
  if (!/^(reel|post):[^/]+\/[^/]+$/.test(key))
    throw new ApiError(400, 'key must be "reel:<project>/<base>" or "post:<project>/<post dir>"');
  const i = await getItem(c.env.DB, key, c.caller.workspaceId);
  if (!i) throw new ApiError(404, `${key} isn't planned`);
  const paths = contentPaths(i, (await workspaceSettings(c.env.DB, c.caller.workspaceId)).mediaFolder);
  const caption = captionText((await readText(c.env.DB, paths.caption)) ?? "");
  const a = (await latestApprovals(c.env.DB, [key])).get(key);
  const due = i.due_at;
  const posted = await getPosted(c.env.DB, key);
  return {
    key,
    account: i.account,
    due: stamp(due, tz),
    due_at: iso(due),
    hold: !!i.hold,
    note: i.note,
    caption,
    comment: commentText(caption, await readText(c.env.DB, paths.comment)),
    comment2: comment2Text(await readText(c.env.DB, paths.comment2)),
    alt: paths.alt ? altLines((await readText(c.env.DB, paths.alt)) ?? "") : undefined,
    // a YouTube video's title, translations and tags; null for an Instagram post
    texts: parseTexts(i.texts),
    texts_source: {
      at: stamp(i.texts_at ?? null, tz),
      by: i.texts_by ?? null,
      ...(paths.files ? { repo_files: paths.files } : {}),
    },
    approval: a
      ? {
          due: stamp(a.dueAt, tz),
          due_at: iso(a.dueAt),
          approved_at: a.approvedAt,
          approved_by: a.approvedByUser ? await memberName(c.env.DB, a.approvedByUser, c.caller.workspaceId) : null,
          media: a.media.length,
          matches_schedule: a.dueAt !== null && a.dueAt === due,
        }
      : null,
    posted: posted
      ? {
          media_id: posted.media_id,
          permalink: posted.permalink,
          source: posted.source,
          published: stamp(posted.published_at, tz),
          published_at: iso(posted.published_at),
        }
      : null,
  };
}

// ---------------------------------------------------------------- metrics (the post_metrics series)

export interface MetricsQuery {
  daily?: boolean;
  /** Dates (YYYY-MM-DD) on the caller's clock, both inclusive. */
  from?: string;
  to?: string;
}

/** The start of a date on the caller's clock; null without one, a 400 for a malformed one. */
function dayStart(date: string | undefined, name: string, tz: string): number | null {
  if (!date) return null;
  const s = zoneToUnix(date, "00:00", tz);
  if (s === null) throw new ApiError(400, `${name} must be a date (YYYY-MM-DD)`);
  return s;
}

/** A series' samples in the caller's workspace, taken in [lo, hi), oldest first; with a limit, the newest ones. */
async function sampleRows(c: OpCtx, itemKey: string, o: { lo?: number | null; hi?: number | null; limit?: number }) {
  const binds: (string | number)[] = [itemKey, c.caller.workspaceId];
  let sql =
    "SELECT taken_at AS at, views, reach, likes, comments, saves, shares, follows, profile_visits FROM post_metrics WHERE item_key = ?1 AND workspace_id = ?2";
  if (o.lo != null) sql += ` AND taken_at >= ?${binds.push(o.lo)}`;
  if (o.hi != null) sql += ` AND taken_at < ?${binds.push(o.hi)}`;
  sql += " ORDER BY taken_at DESC";
  if (o.limit !== undefined) sql += ` LIMIT ?${binds.push(o.limit)}`;
  const r = await c.env.DB.prepare(sql)
    .bind(...binds)
    .all<Sample>();
  return r.results.reverse();
}

/** The points a chart reads: totals, or what each day added (on the caller's clock), at most METRICS_MAX_POINTS. */
async function metricSeries(c: OpCtx, itemKey: string, q: MetricsQuery): Promise<Sample[]> {
  const tz = await zoneOf(c);
  const from = dayStart(q.from, "from", tz);
  const to = dayStart(q.to, "to", tz);
  // the end is exclusive: the start of the day after `to`
  const hi = to === null ? null : dayStart(shiftDate(q.to as string, 1), "to", tz);
  if (!q.daily) return sampleRows(c, itemKey, { lo: from, hi, limit: METRICS_MAX_POINTS });
  // a day's point is its growth since the previous sampled day, which can be a week before `from`: read the last
  // sample before it too, then leave the points before `from` out
  const before = from === null ? [] : await sampleRows(c, itemKey, { hi: from, limit: 1 });
  const points = series([...before, ...(await sampleRows(c, itemKey, { lo: from, hi }))], { daily: true, tz });
  return points.filter((p) => from === null || p.at >= from).slice(-METRICS_MAX_POINTS);
}

/** One planned item's metrics series, and its Trial Reel copy's when it has one. */
export async function itemMetrics(c: OpCtx, o: MetricsQuery & { key: string }) {
  const tz = await zoneOf(c);
  const i = await getItem(c.env.DB, o.key, c.caller.workspaceId);
  if (!i) throw new ApiError(404, `${o.key} isn't planned`);
  const acc = await findAccount(c.env.DB, i.account, c.caller.workspaceId);
  const posted = await getPosted(c.env.DB, o.key);
  const trial = await c.env.DB.prepare("SELECT item_key FROM trial_posts WHERE item_key = ?1").bind(o.key).first();
  return {
    item: {
      key: o.key,
      platform: acc?.platform ?? "unknown",
      account: i.account,
      label: formatLabel(acc ? platform(acc.platform) : null, i.format),
      published_at: iso(posted?.published_at ?? null),
      due: stamp(i.due_at, tz),
      due_at: iso(i.due_at),
    },
    samples: await metricSeries(c, o.key, o),
    ...(trial ? { trial: { samples: await metricSeries(c, `trial:${o.key}`, o) } } : {}),
  };
}

/** Video id → item key for the Bongsu uploads of these channels in the caller's workspace (D6). */
const bongsuOf = (c: OpCtx, channels: { id: string }[]) =>
  bongsuVideos(
    c.env.DB,
    channels.map((a) => a.id),
    c.caller.workspaceId,
  );

/** The same for every YouTube channel of the caller's workspace: two accounts on one channel list the same video. */
const workspaceBongsu = async (c: OpCtx) => bongsuOf(c, await youtubeAccounts(c.env.DB, c.caller.workspaceId));

/** The video page's answer: a Bongsu upload answers `{ item_key }` (the app opens the item), any other video its
 *  series, as `uploadMetrics`. */
export async function videoMetrics(c: OpCtx, o: MetricsQuery & { video: string }) {
  const key = (await workspaceBongsu(c)).get(o.video);
  return key ? { item_key: key } : await uploadMetrics(c, o);
}

/** A YouTube upload's metrics series (`video:<id>`), when a channel of the caller's workspace lists it. */
async function uploadMetrics(c: OpCtx, o: MetricsQuery & { video: string }) {
  for (const account of await youtubeAccounts(c.env.DB, c.caller.workspaceId)) {
    let upload: Awaited<ReturnType<typeof channelUploads>>[number] | undefined;
    try {
      upload = (await channelUploads(c.env, c.fetch, account)).find((u) => u.id === o.video);
    } catch {
      continue; // a channel that can't be read doesn't hide the others
    }
    if (!upload) continue;
    const key = `video:${o.video}`;
    const published = upload.when ? Math.floor(Date.parse(upload.when) / 1000) : Number.NaN;
    return {
      item: {
        key,
        platform: "youtube",
        account: account.id,
        label: upload.short ? "Short" : "Video",
        published_at: Number.isFinite(published) ? iso(published) : null,
        due: null,
        due_at: null,
      },
      samples: await metricSeries(c, key, o),
      // false for a channel connected before the analytics scope was asked for: the app says why subscribers are missing
      analytics: await youtubeAnalytics(c.env, account.connection),
    };
  }
  throw new ApiError(404, `no channel of this workspace has the video ${o.video}`);
}

/** The "24 h" numbers the item page shows: a sample within 6 h of 24 h after publishing; once the 24 h marker exists
 *  (the notification went out), the nearest sample even outside that window, with the marker's median (and its time
 *  when there's no sample). Null otherwise: the sampler's first sample, minutes after publishing, isn't a 24 h result. */
export async function results24h(c: OpCtx, itemKey: string, publishedAt: number) {
  const rows = await sampleRows(c, itemKey, {});
  const marker = await c.env.DB.prepare(
    "SELECT median_views, fetched_at FROM post_results WHERE item_key = ?1 AND workspace_id = ?2",
  )
    .bind(itemKey, c.caller.workspaceId)
    .first<{ median_views: number | null; fetched_at: number }>();
  const s = nearest24h(rows, publishedAt, { strict: !marker });
  const at = s?.at ?? marker?.fetched_at;
  if (at === undefined) return null;
  return {
    views: s?.views ?? null,
    reach: s?.reach ?? null,
    likes: s?.likes ?? null,
    comments: s?.comments ?? null,
    saves: s?.saves ?? null,
    shares: s?.shares ?? null,
    follows: s?.follows ?? null,
    profile_visits: s?.profile_visits ?? null,
    median_views: marker?.median_views ?? null,
    fetched_at: at,
  };
}

export async function jobs(c: OpCtx, opts: { days?: number } = {}) {
  const tz = await zoneOf(c);
  const days = Math.min(Math.max(opts.days ?? 7, 1), 90);
  const r = await c.env.DB.prepare(
    "SELECT item_key, kind, account, due_at, state, dry_run, last_error, permalink, updated_at FROM jobs WHERE updated_at >= ?1 AND workspace_id = ?2 ORDER BY due_at DESC LIMIT 200",
  )
    .bind(nowS(c) - days * 86400, c.caller.workspaceId)
    .all<{
      item_key: string;
      kind: string;
      account: string;
      due_at: number;
      state: string;
      dry_run: number;
      last_error: string | null;
      permalink: string | null;
    }>();
  return {
    jobs: r.results.map((j) => ({
      key: j.item_key,
      kind: j.kind,
      account: j.account,
      due: stamp(j.due_at, tz),
      due_at: iso(j.due_at),
      state: j.state,
      mode: j.dry_run ? "dry" : "live",
      note: j.last_error,
      permalink: j.permalink,
    })),
  };
}

export async function notifications(c: OpCtx, opts: { limit?: number } = {}) {
  const tz = await zoneOf(c);
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const r = await c.env.DB.prepare(
    "SELECT at, target, detail FROM audit WHERE action = 'notify' AND (workspace_id IS NULL OR workspace_id = ?2) ORDER BY at DESC LIMIT ?1",
  )
    .bind(limit, c.caller.workspaceId)
    .all<{ at: number; target: string | null; detail: string }>();
  return {
    notifications: r.results.map((n) => ({
      at: stamp(n.at, tz),
      target: n.target,
      ...(JSON.parse(n.detail) as { title: string; text: string }),
    })),
  };
}

// ---------------------------------------------------------------- drafts (proposals for the owner to approve)

const KINDS = ["reel", "photo", "carousel", "shorts_comment"] as const;

/** Who made each draft: a person (an app upload) as the workspace names them, a key ("key:<id>") by its name. */
async function draftAuthors(c: OpCtx, rows: { created_by: string; user_id: string | null }[]) {
  const people = await memberNames(
    c.env.DB,
    rows.flatMap((d) => (d.user_id ? [d.user_id] : [])),
    c.caller.workspaceId,
  );
  const keyIds = [
    ...new Set(rows.flatMap((d) => (!d.user_id && d.created_by.startsWith("key:") ? [d.created_by.slice(4)] : []))),
  ];
  const keys = new Map<string, string>();
  if (keyIds.length) {
    const k = await c.env.DB.prepare(
      `SELECT id, name FROM api_keys WHERE id IN ${jsonList(c.env.DB, 1)} AND workspace_id = ?2`,
    )
      .bind(JSON.stringify(keyIds), c.caller.workspaceId)
      .all<{ id: string; name: string }>();
    for (const x of k.results) keys.set(`key:${x.id}`, x.name);
  }
  return { people, keys };
}

export async function listDrafts(c: OpCtx, opts: { status?: string } = {}) {
  const tz = await zoneOf(c);
  const status = opts.status ?? "draft";
  const r = await c.env.DB.prepare(
    "SELECT id, kind, account, payload, texts, source, created_by, user_id, status, created_at, updated_at FROM drafts WHERE status = ?1 AND workspace_id = ?2 ORDER BY created_at DESC LIMIT 100",
  )
    .bind(status, c.caller.workspaceId)
    .all<{
      id: string;
      kind: string;
      account: string;
      payload: string;
      texts: string | null;
      source: string;
      created_by: string;
      user_id: string | null;
      status: string;
      created_at: number;
      updated_at: number;
    }>();
  const by = await draftAuthors(c, r.results);
  return {
    drafts: r.results.map(({ user_id, texts, ...d }) => ({
      ...d,
      texts: parseTexts(texts),
      by: (user_id ? by.people.get(user_id) : by.keys.get(d.created_by)) ?? null,
      payload: JSON.parse(d.payload),
      created_at: stamp(d.created_at, tz),
      updated_at: stamp(d.updated_at, tz),
    })),
  };
}

export async function createDraft(c: OpCtx, body: Record<string, unknown>) {
  const kind = String(body.kind ?? "");
  if (!(KINDS as readonly string[]).includes(kind)) throw new ApiError(400, `kind must be one of ${KINDS.join(", ")}`);
  const account = String(body.account ?? "");
  const known = kind === "shorts_comment" ? await accountIds(c, "youtube") : await accountIds(c);
  if (!known.includes(account)) throw new ApiError(400, `account must be one of ${known.join(", ")}`);
  const acc = await findAccount(c.env.DB, account, c.caller.workspaceId);
  const plat = acc && platform(acc.platform);
  // a YouTube channel takes videos (a reel draft is a video), not photos or carousels
  if (plat?.id === "youtube" && kind !== "reel" && kind !== "shorts_comment")
    throw new ApiError(400, `${plat.name} takes a reel (a video) or a shorts_comment`);
  let texts: ReturnType<typeof checkTexts> = null;
  if (body.texts !== undefined && body.texts !== null) {
    if (!plat) throw new ApiError(400, `${account}: unknown platform`);
    texts = checkOrFail(plat, body.texts);
  }
  const payload: Record<string, unknown> = {};
  for (const k of [
    "title",
    "caption",
    "comment",
    "comment2",
    "date",
    "time",
    "location",
    "folder",
    "video_id",
    "note",
  ]) {
    if (body[k] !== undefined) payload[k] = String(body[k]).slice(0, 5000);
  }
  // file ids in the workspace's default media store, in slide order; each must be in the workspace's media
  if (Array.isArray(body.media)) {
    const stores = await mediaStores(c.env, c.fetch, c.caller.workspaceId);
    const store = stores.default;
    if (!store) throw new ApiError(400, "no media store is set up: add one in the dashboard (Media)");
    const refs = body.media.slice(0, 10).map((m) => ({ store: store.id, id: String(m).slice(0, 200) }));
    try {
      await assertOwns(stores, (await workspaceSettings(c.env.DB, c.caller.workspaceId)).mediaFolder, refs);
    } catch (e) {
      if (e instanceof MediaError) throw new ApiError(e.status, e.message);
      throw e;
    }
    payload.media = refs;
  }
  if (body.options !== undefined) {
    if (!plat) throw new ApiError(400, `${account}: unknown platform`);
    // checked as a video (the format a reel draft becomes); the app applies them when it schedules the draft
    payload.options = askedOptions({ options: body.options }, plat, "video");
  }
  if (!payload.caption && !payload.comment && !payload.note && !texts)
    throw new ApiError(400, "a draft needs at least a caption, a comment, a note or texts");
  if (payload.date && !/^\d{4}-\d{2}-\d{2}$/.test(String(payload.date)))
    throw new ApiError(400, "date must be YYYY-MM-DD (your time zone)");
  if (payload.time && !/^\d{2}:\d{2}$/.test(String(payload.time)))
    throw new ApiError(400, "time must be HH:MM (your time zone)");
  const id = `d_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  await c.env.DB.prepare(
    "INSERT INTO drafts (id, kind, account, payload, source, created_by, status, created_at, updated_at, workspace_id, texts) VALUES (?1, ?2, ?3, ?4, 'api', ?5, 'draft', ?6, ?6, ?7, ?8)",
  )
    .bind(
      id,
      kind,
      account,
      JSON.stringify(payload),
      `key:${c.caller.id}`,
      nowS(c),
      c.caller.workspaceId,
      texts === null ? null : JSON.stringify(texts),
    )
    .run();
  await audit(c, "draft_create", id, { kind, account });
  return { id, status: "draft", note: "A draft is a proposal: the owner reviews and approves it; a key can't." };
}

export async function withdrawDraft(c: OpCtx, id: string) {
  const r = await c.env.DB.prepare(
    "UPDATE drafts SET status = 'withdrawn', updated_at = ?1 WHERE id = ?2 AND status = 'draft' AND workspace_id = ?3 RETURNING id",
  )
    .bind(nowS(c), id, c.caller.workspaceId)
    .first<{ id: string }>();
  if (!r) throw new ApiError(404, `no open draft ${id}`);
  await audit(c, "draft_withdraw", id, {});
  return { id, status: "withdrawn" };
}

// ---------------------------------------------------------------- pause (resume needs a passkey, in the app)
// Both act on the caller's workspace only: the others go on publishing.

export async function pause(c: OpCtx, reason: string) {
  const set = await setPaused(
    c.env.DB,
    c.caller.workspaceId,
    reason || "paused",
    inApp(c)
      ? { userId: c.caller.id, text: (await memberName(c.env.DB, c.caller.id, c.caller.workspaceId)) ?? "someone" }
      : { text: `API key "${c.caller.name}"` },
    c.now,
  );
  if (!set) return { paused: true, already: true };
  await audit(c, "pause", `workspace:${c.caller.workspaceId}`, { reason });
  return {
    paused: true,
    note: "Nothing in this workspace is published until an admin or creator resumes it (in the app).",
  };
}

export async function resume(c: OpCtx) {
  const was = await clearPaused(c.env.DB, c.caller.workspaceId);
  await audit(c, "resume", `workspace:${c.caller.workspaceId}`, { was });
  return { paused: false, wasPaused: was };
}

// ---------------------------------------------------------------- editing the plan (scope "plan")
// Changing an approved item's time makes its approval stop matching: the scheduler refuses it until the owner
// approves again. Nothing here can approve. Times come as `at` (ISO 8601 with its zone) or `date` / `time` on the
// caller's clock (dueFrom); the database keeps UTC.

const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** The ids of the caller's workspace's accounts that publish items (every platform with formats), or only the
 *  YouTube channels (Shorts comments). */
async function accountIds(c: OpCtx, only?: "youtube") {
  if (only === "youtube") return (await youtubeAccounts(c.env.DB, c.caller.workspaceId)).map((a) => a.id);
  const all = await listAccounts(c.env.DB, { workspaceId: c.caller.workspaceId });
  return all.filter((a) => platform(a.platform)?.formats.length).map((a) => a.id);
}

/** A video's texts, checked for the platform (a TextsError is the caller's mistake: 400). */
function checkOrFail(p: Platform, raw: unknown) {
  try {
    return checkTexts(p, raw);
  } catch (e) {
    if (e instanceof TextsError) throw new ApiError(400, e.message);
    throw e;
  }
}

/** The format a caller asked for: `format` (one of the platform's), or the older `kind` ("reel" → video, "post" → decided
 *  by the media, "post" + format "story" → story). */
function askedFormat(b: Record<string, unknown>, p: Platform): Format | null {
  const f = b.format === undefined || b.format === null || b.format === "" ? null : String(b.format);
  if (b.kind !== undefined) {
    if (b.kind === "reel" && (f === null || f === "video")) return "video";
    if (b.kind === "post" && (f === null || f === "feed")) return null;
    if (b.kind === "post" && f === "story") return "story";
    throw new ApiError(400, 'kind must be "reel" or "post" (or give a format instead)');
  }
  if (f === null) return null;
  if (!p.formats.includes(f as Format))
    throw new ApiError(400, `format must be one of ${p.formats.join(", ")} on ${p.name}`);
  return f as Format;
}

/** The options a caller set (`options`, or the older top-level `location`), checked against the platform. */
function askedOptions(
  b: Record<string, unknown>,
  p: Platform,
  format: Format | null,
  current: Record<string, unknown> = {},
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (b.options !== undefined) {
    if (!b.options || typeof b.options !== "object" || Array.isArray(b.options))
      throw new ApiError(400, "options must be an object");
    Object.assign(patch, b.options);
  }
  if ("location" in b) patch.location = b.location ? String(b.location) : null;
  if (!Object.keys(patch).length) return current;
  try {
    // checked as the format it will most likely be (a post without one: as an image)
    return validateOptions(p, format ?? "image", { ...current, ...patch });
  } catch (e) {
    if (e instanceof OptionsError) throw new ApiError(400, e.message);
    throw e;
  }
}

export async function planAdd(c: OpCtx, b: Record<string, unknown>) {
  const account = String(b.account ?? "");
  const accts = await listAccounts(c.env.DB, { workspaceId: c.caller.workspaceId });
  const acc = accts.find((a) => a.id === account && platform(a.platform)?.formats.length);
  if (!acc)
    throw new ApiError(
      400,
      `account must be one of ${accts
        .filter((a) => platform(a.platform)?.formats.length)
        .map((a) => a.id)
        .join(", ")}`,
    );
  const plat = requirePlatform(acc.platform);
  const format = askedFormat(b, plat);
  const folder = String(b.folder ?? "")
    .replace(/^channels\//, "")
    .replace(/\/+$/, "");
  const name = String(b.name ?? "").replace(/\/+$/, "");
  if (!/^[a-z]+\/CONTENT\/[^/]+$/.test(folder))
    throw new ApiError(400, "folder is the project under channels/, e.g. vlogs/CONTENT/20260823_LISBON");
  if (!name || (format === "video" && name.includes("/")))
    throw new ApiError(400, "name: a video's base (short5_x) or a post's folder (posts/carousel3_green)");
  const options = askedOptions(b, plat, format);
  // checked before the insert, so a refused one leaves nothing behind
  const video = "texts" in b ? checkOrFail(plat, b.texts) : undefined;
  const tz = await zoneOf(c);
  const due = askedDue(b, format, tz) ?? null;
  const key = makeKey(keyClass(format), folder, name);
  const story = format === "story";
  if (due !== null && !story) {
    const taken = await slotTaken(c.env.DB, account, due, tz, key);
    if (taken) throw await slotClash(c, account, due, key, taken);
  }
  const r = await c.env.DB.prepare(
    `INSERT INTO plan_items (item_key, format, account, folder, name, due_at, options, hold, note, sort, updated_by,
       content, workspace_id, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, (SELECT COALESCE(MAX(sort), 0) + 1 FROM plan_items), ?10, ?11, ?12, ?13,
       ?13)
     ON CONFLICT (item_key) DO NOTHING RETURNING item_key`,
  )
    .bind(
      key,
      format,
      account,
      folder,
      name,
      due,
      JSON.stringify(options),
      b.hold ? 1 : 0,
      b.note ? String(b.note).slice(0, 1000) : null,
      c.caller.id,
      "repo",
      c.caller.workspaceId,
      nowS(c),
    )
    .first();
  if (!r) throw new ApiError(409, `${key} is already planned (use plan_update)`);
  const texts = await setTexts(c, { item_key: key, format }, plat, b, video);
  await audit(c, "plan_add", key, { due_at: iso(due), texts });
  return { key, added: true, due: stamp(due, tz), due_at: iso(due), texts };
}

const TEXT_FIELDS = ["caption", "comment", "comment2", "alt", "texts"] as const;

/** An agent's texts for an item (plan_add / plan_update): straight into the scheduler's copy, which is what it posts. */
async function setTexts(
  c: OpCtx,
  i: Pick<PlanItem, "item_key" | "format">,
  p: Platform,
  b: Record<string, unknown>,
  video: ReturnType<typeof checkTexts> | undefined,
): Promise<string[] | undefined> {
  const given = TEXT_FIELDS.filter((f) => f in b);
  if (!given.length) return undefined;
  const by = `key:${c.caller.id}`;
  try {
    await writeTexts(c.env.DB, i, b, by, nowS(c), p.limits.captionMax);
    if (video !== undefined) await writeYouTubeTexts(c.env.DB, i.item_key, video, by, nowS(c));
  } catch (e) {
    if (e instanceof TextsError) throw new ApiError(400, e.message);
    throw e;
  }
  return given;
}

export async function planUpdate(c: OpCtx, b: Record<string, unknown>) {
  const tz = await zoneOf(c);
  const key = String(b.key ?? "");
  const i = await getItem(c.env.DB, key, c.caller.workspaceId);
  if (!i) throw new ApiError(404, `${key} isn't planned`);
  const next: PlanItem = { ...i };
  const due = askedDue(b, i.format ?? null, tz, i.due_at);
  if (due !== undefined) next.due_at = due;
  if ("hold" in b) next.hold = b.hold ? 1 : 0;
  const acc = await findAccount(c.env.DB, i.account, c.caller.workspaceId);
  const plat = acc && platform(acc.platform);
  if (plat) next.options = JSON.stringify(askedOptions(b, plat, i.format ?? null, itemOptions(i)));
  else if (b.options !== undefined || "location" in b) throw new ApiError(400, `${i.account}: unknown platform`);
  if ("note" in b) next.note = b.note ? String(b.note).slice(0, 1000) : null;
  const video = plat && "texts" in b ? checkOrFail(plat, b.texts) : undefined;
  if (next.due_at !== null && next.due_at !== i.due_at && i.format !== "story") {
    const taken = await slotTaken(c.env.DB, i.account, next.due_at, tz, key);
    if (taken) throw await slotClash(c, i.account, next.due_at, key, taken);
  }
  if (TEXT_FIELDS.some((f) => f in b) && (await getPosted(c.env.DB, key)))
    throw new ApiError(409, `${key} was published: its texts can't change`);
  await c.env.DB.prepare(
    "UPDATE plan_items SET due_at = ?1, hold = ?2, options = ?3, note = ?4, updated_at = ?7, updated_by = ?5 WHERE item_key = ?6 AND workspace_id = ?8",
  )
    .bind(next.due_at, next.hold, next.options ?? "{}", next.note, c.caller.id, key, nowS(c), c.caller.workspaceId)
    .run();
  const texts = plat ? await setTexts(c, i, plat, b, video) : undefined;
  const a = (await latestApprovals(c.env.DB, [key])).get(key);
  const stillApproved = !!a && a.dueAt !== null && a.dueAt === next.due_at;
  await audit(c, "plan_update", key, {
    from: { due_at: iso(i.due_at), hold: i.hold },
    to: { due_at: iso(next.due_at), hold: next.hold },
    texts,
  });
  return {
    key,
    due: stamp(next.due_at, tz),
    due_at: iso(next.due_at),
    hold: !!next.hold,
    approved: stillApproved,
    texts,
    ...(a && !stillApproved
      ? { note: "The schedule no longer matches the approval: the owner must approve again." }
      : a && texts
        ? {
            note: "Texts changed: if they differ from what was approved, the owner must approve again (the scheduler refuses a changed text).",
          }
        : {}),
  };
}

export async function planRemove(c: OpCtx, key: string) {
  if (!(await getItem(c.env.DB, key, c.caller.workspaceId))) throw new ApiError(404, `${key} isn't planned`);
  if (await getPosted(c.env.DB, key)) throw new ApiError(409, `${key} was published: it stays as history`);
  const r = await c.env.DB.prepare(
    "DELETE FROM plan_items WHERE item_key = ?1 AND workspace_id = ?2 RETURNING item_key",
  )
    .bind(key, c.caller.workspaceId)
    .first();
  if (!r) throw new ApiError(404, `${key} isn't planned`);
  await audit(c, "plan_remove", key, {});
  return { key, removed: true };
}

/** Record a post made by hand (ig.py, the app), so the scheduler never publishes it again. */
export async function recordManualPost(c: OpCtx, b: Record<string, unknown>) {
  const tz = await zoneOf(c);
  const key = String(b.key ?? "");
  const i = await getItem(c.env.DB, key);
  // another workspace's item is not this caller's to record (it would stop its scheduler from posting it)
  if (i && i.workspace_id !== c.caller.workspaceId) throw new ApiError(404, `${key} isn't planned`);
  const account = i?.account ?? String(b.account ?? "");
  if (!(await accountIds(c)).includes(account)) throw new ApiError(400, "unknown item: pass account too");
  const date = String(b.date ?? zoneDate(c.now, tz));
  if (!DATE.test(date)) throw new ApiError(400, `date must be YYYY-MM-DD (${tz})`);
  // When it went live: published_at (Instagram's timestamp, ISO or unix seconds); else now if it's dated today, else
  // its planned time if that was on that day, else noon that day.
  const given =
    typeof b.published_at === "number"
      ? Math.floor(b.published_at)
      : b.published_at
        ? igTime(String(b.published_at))
        : null;
  if (b.published_at !== undefined && given === null)
    throw new ApiError(400, "published_at must be ISO 8601 or unix seconds");
  const planned = i?.due_at != null && zoneDate(new Date(i.due_at * 1000), tz) === date ? i.due_at : null;
  const publishedAt =
    given ?? (date === zoneDate(c.now, tz) ? nowS(c) : (planned ?? zoneToUnix(date, "12:00", tz) ?? nowS(c)));
  const added = await recordPosted(c.env.DB, {
    workspaceId: c.caller.workspaceId,
    key,
    account,
    mediaId: b.media_id ? String(b.media_id) : null,
    permalink: b.permalink ? String(b.permalink) : null,
    source: "manual",
    publishedAt,
    recordedAt: nowS(c),
  });
  await audit(c, "posted_manual", key, { published_at: iso(publishedAt) });
  return { key, recorded: added, ...(added ? {} : { note: "already recorded" }) };
}

export async function shortsAdd(c: OpCtx, b: Record<string, unknown>) {
  const video = String(b.video_id ?? ""),
    channel = String(b.channel ?? ""),
    file = String(b.file ?? "");
  const text = b.text == null ? null : String(b.text).trim() || null;
  if (text && text.length > 10000) throw new ApiError(400, "text: at most 10,000 characters");
  if (!/^[A-Za-z0-9_-]{11}$/.test(video)) throw new ApiError(400, "video_id: an 11-character YouTube id");
  const channels = await accountIds(c, "youtube");
  if (!channels.includes(channel)) throw new ApiError(400, `channel must be one of ${channels.join(", ")}`);
  if (!text && !file) throw new ApiError(400, "give the comment's text (or, for a repo setup, its file)");
  if (file.length > 300) throw new ApiError(400, "file: at most 300 characters");
  const r = await c.env.DB.prepare(
    "INSERT INTO shorts_comments (video_id, channel, file, label, sort, text, created_at, workspace_id) VALUES (?1, ?2, ?3, ?4, (SELECT COALESCE(MAX(sort), 0) + 1 FROM shorts_comments), ?5, ?6, ?7) ON CONFLICT (video_id) DO NOTHING RETURNING video_id",
  )
    .bind(video, channel, file, b.label ? String(b.label) : null, text, nowS(c), c.caller.workspaceId)
    .first();
  if (!r) throw new ApiError(409, `${video} is already listed`);
  await audit(c, "shorts_add", video, { channel, text: !!text });
  return {
    video_id: video,
    added: true,
    note: text
      ? "The owner approves the comment in the app before it goes out (once the video is public)."
      : `No text given: the scheduler won't comment until it has one, approved by the owner (bongsu texts set, or the app).`,
  };
}

/** Record a Shorts comment posted by hand (yt.py), so the scheduler doesn't comment again. */
export async function recordManualComment(c: OpCtx, b: Record<string, unknown>) {
  const tz = await zoneOf(c);
  const video = String(b.video_id ?? "");
  const row = await c.env.DB.prepare(
    "SELECT channel, label FROM shorts_comments WHERE video_id = ?1 AND workspace_id = ?2",
  )
    .bind(video, c.caller.workspaceId)
    .first<{ channel: string; label: string | null }>();
  if (!row) throw new ApiError(404, `${video} isn't in the Shorts list`);
  await recordCommented(c.env.DB, {
    workspaceId: c.caller.workspaceId,
    video,
    channel: row.channel,
    datePt: String(b.date_pt ?? zoneDate(c.now, tz)),
    threadId: b.thread_id ? String(b.thread_id) : null,
    label: row.label,
    source: "manual",
  });
  await audit(c, "commented_manual", video, {});
  return { video_id: video, recorded: true };
}

// ---------------------------------------------------------------- YouTube release date

/** Move a scheduled YouTube video's release. An agent key, and a CLI token alike, must leave the lead time. */
export async function youtubeReschedule(c: OpCtx, b: Record<string, unknown>) {
  const video = String(b.video ?? "");
  if (!video) throw new ApiError(400, "give the video id");
  const tz = await zoneOf(c);
  const at = askedDue(b, "video", tz);
  if (at === undefined || at === null) throw new ApiError(400, "give at, or date and time");
  try {
    return await moveRelease(c.env, c.fetch, {
      workspaceId: c.caller.workspaceId,
      videoId: video,
      at,
      nowS: nowS(c),
      tz,
      actor: { kind: "key", id: c.caller.id, name: c.caller.name },
    });
  } catch (e) {
    if (e instanceof ReleaseError) throw new ApiError(releaseStatus(e), e.message);
    throw e;
  }
}

/** Where an account lives on its platform. */
export function accountHref(a: { platform: string; handle: string }): string | null {
  if (a.platform === "instagram") return `https://www.instagram.com/${a.handle}/`;
  if (a.platform === "youtube")
    return a.handle.startsWith("UC")
      ? `https://www.youtube.com/channel/${a.handle}`
      : `https://www.youtube.com/@${a.handle}`;
  return null;
}

/** A follower count and its change since the newest sample at least 20 h older (a day, give or take a cron run). */
export function followerChange(rows: { taken_at: number; followers: number | null }[]) {
  const latest = rows.at(-1);
  const before = latest ? rows.filter((r) => r.taken_at <= latest.taken_at - 20 * 3600).at(-1) : undefined;
  return {
    followers: latest?.followers ?? null,
    change: latest?.followers != null && before?.followers != null ? latest.followers - before.followers : null,
    since: before ? utcIso(before.taken_at) : null,
  };
}

const STATS_DAYS = [7, 30, 90];
const BROUGHT_MAX = 10;

/**
 * An account's channel page: its follower series over the period (totals and each day's growth), the views its
 * posts added per day, and its posts and videos ranked by the followers they brought in the period (the follows at
 * its end less those at its start: the last sample at or before it, else the post's first sample in the period).
 * Days on the caller's clock; `analytics` says, for a YouTube channel, whether its subscribers per video can come.
 */
export async function channelStats(c: OpCtx, o: { account: string; days?: string }) {
  const days = o.days ? Number(o.days) : 30;
  if (!STATS_DAYS.includes(days)) throw new ApiError(400, "days is 7, 30 or 90");
  const ws = c.caller.workspaceId;
  const a = (await listAccounts(c.env.DB, { workspaceId: ws, all: true })).find((x) => x.id === o.account);
  if (!a) throw new ApiError(404, `no account ${o.account} in this workspace`);
  const tz = await zoneOf(c);
  const nowS = Math.floor(c.now.getTime() / 1000);
  const from = nowS - days * 86400;
  const acct = await c.env.DB.prepare(
    "SELECT taken_at, followers FROM account_metrics WHERE account = ?1 AND workspace_id = ?2 ORDER BY taken_at",
  )
    .bind(a.id, ws)
    .all<{ taken_at: number; followers: number | null }>();
  const fpts: Point[] = acct.results.map((r) => ({ at: r.taken_at, value: r.followers }));
  const mine = a.platform === "youtube" ? await workspaceBongsu(c) : new Map<string, string>();
  const byItem = await postRows(c, a.id, from - 8 * 86400);
  // a Bongsu upload counts once, under its item: an older video: series of it is left out
  for (const id of mine.keys()) byItem.delete(`video:${id}`);
  const uploads = (a.platform === "youtube" ? await cachedUploads(c, a.id) : []).filter((u) => !mine.has(u.id));
  const published = await publishedTimes(c, a.id, uploads);
  const viewDays = viewsPerDay(byItem, published, from, nowS, tz);

  const gainOf = (pts: Point[]) => {
    const valued = pts.filter((p): p is { at: number; value: number } => p.value !== null);
    const end = valued.at(-1);
    const base = valued.filter((p) => p.at <= from).at(-1) ?? valued.find((p) => p.at > from);
    return end && base && end.at > from ? end.value - base.value : null;
  };
  const periodChange = gainOf(fpts);
  const ranked = [...byItem.entries()]
    .map(([key, rows]) => ({ key, follows: gainOf(rows.map((r) => ({ at: r.taken_at, value: r.follows }))) }))
    .filter((x): x is { key: string; follows: number } => x.follows !== null && x.follows > 0)
    .sort((x, y) => y.follows - x.follows || x.key.localeCompare(y.key))
    .slice(0, BROUGHT_MAX);
  const brought = [];
  for (const r of ranked) {
    let title = r.key;
    let href: string;
    if (r.key.startsWith("video:")) {
      const id = r.key.slice(6);
      const u = uploads.find((x) => x.id === id);
      title = u?.title ?? id;
      const when = u?.when ? Date.parse(u.when) : Number.NaN;
      href = `#/video/${a.id}/${id}${Number.isFinite(when) ? `?d=${zoneDate(new Date(when), tz)}` : ""}`;
    } else {
      const base = r.key.replace(/^trial:/, "");
      const item = await getItem(c.env.DB, base, ws);
      title = `${item?.title || item?.name || base}${r.key.startsWith("trial:") ? " · Trial Reel" : ""}`;
      href = `#/item/${encodeURIComponent(base)}/results`;
    }
    brought.push({
      key: r.key,
      title,
      platform: a.platform,
      follows: r.follows,
      source: a.platform === "youtube" ? sourceOf(r.key) : undefined,
      // follows are gross and the change net (and YouTube rounds its count): a share over 100% would mislead
      share: periodChange && periodChange > 0 && r.follows <= periodChange ? r.follows / periodChange : null,
      href,
    });
  }
  return {
    account: {
      id: a.id,
      platform: a.platform,
      title: a.displayName ?? a.handle,
      url: accountHref(a),
      ...followerChange(acct.results),
    },
    followers: {
      total: fpts.filter((p) => p.at >= from),
      daily: dailyGrowth(fpts, tz).filter((p) => p.at >= from),
    },
    views: viewDays,
    brought,
    analytics: a.platform === "youtube" ? await youtubeAnalytics(c.env, a.connection) : null,
  };
}

/** Where a YouTube video row comes from: an item key is a Bongsu upload, a `video:` key one uploaded elsewhere. */
const sourceOf = (key: string): "bongsu" | "elsewhere" => (key.startsWith("video:") ? "elsewhere" : "bongsu");

const OVERVIEW_DAYS = 7;
const OVERVIEW_MAX = 10;

/**
 * The app's Stats tab: each active account of the workspace with its follower count and change (the account
 * series), and the posts and videos published in the last 7 days on the caller's clock, most viewed first
 * (list_performance), each with the page it opens: a post's Results, a video's page.
 */
export async function statsOverview(c: OpCtx) {
  const ws = c.caller.workspaceId;
  const tz = await zoneOf(c);
  const accounts = [];
  for (const a of await listAccounts(c.env.DB, { workspaceId: ws })) {
    const rows = await c.env.DB.prepare(
      "SELECT taken_at, followers FROM account_metrics WHERE account = ?1 AND workspace_id = ?2 ORDER BY taken_at",
    )
      .bind(a.id, ws)
      .all<{ taken_at: number; followers: number | null }>();
    accounts.push({
      id: a.id,
      platform: a.platform,
      handle: a.handle,
      title: a.displayName ?? a.handle,
      ...followerChange(rows.results),
    });
  }
  const today = zoneDate(c.now, tz);
  const perf = await performanceList(c, {
    from: shiftDate(today, 1 - OVERVIEW_DAYS),
    to: today,
    sort: "views",
    limit: OVERVIEW_MAX,
  });
  const recent = perf.rows.map((r) => {
    const pub = typeof r.published_at === "string" ? r.published_at : null;
    const href = r.key.startsWith("video:")
      ? `#/video/${r.account}/${r.key.slice(6)}${pub ? `?d=${zoneDate(new Date(pub), tz)}` : ""}`
      : `#/item/${encodeURIComponent(r.key.replace(/^trial:/, ""))}/results`;
    return {
      key: r.key,
      platform: r.platform as string,
      account: r.account as string,
      title: r.title as string,
      label: r.label as string | null,
      source: r.platform === "youtube" ? sourceOf(r.key) : undefined,
      published_at: pub,
      views: r.views as number | null,
      likes: r.likes as number | null,
      comments: r.comments as number | null,
      href,
    };
  });
  return { days: OVERVIEW_DAYS, accounts, recent };
}

/** When each of an account's posts went out (a Trial copy's under its `trial:` key, a video's under `video:`). */
async function publishedTimes(c: OpCtx, accountId: string, uploads: { id: string; when: string | null }[]) {
  const out = new Map<string, number>();
  const posted = await c.env.DB.prepare(
    "SELECT item_key, published_at FROM posted WHERE account = ?1 AND published_at IS NOT NULL",
  )
    .bind(accountId)
    .all<{ item_key: string; published_at: number }>();
  for (const r of posted.results) out.set(r.item_key, r.published_at);
  const trials = await c.env.DB.prepare(
    "SELECT item_key, published_at FROM trial_posts WHERE account = ?1 AND published_at IS NOT NULL",
  )
    .bind(accountId)
    .all<{ item_key: string; published_at: number }>();
  for (const r of trials.results) out.set(`trial:${r.item_key}`, r.published_at);
  for (const u of uploads) {
    const t = u.when ? Date.parse(u.when) : Number.NaN;
    if (Number.isFinite(t)) out.set(`video:${u.id}`, Math.floor(t / 1000));
  }
  return out;
}

/** A channel's uploads as the calendar last cached them (no refresh: the page needs titles, not fresh ones). */
async function cachedUploads(
  c: OpCtx,
  accountId: string,
): Promise<{ id: string; title: string; when: string | null }[]> {
  const row = await c.env.DB.prepare("SELECT value FROM settings WHERE key = ?1")
    .bind(`yt_uploads:${accountId}`)
    .first<{ value: string }>();
  try {
    return row ? JSON.parse(row.value) : [];
  } catch {
    return [];
  }
}

type PostRow = { item_key: string; taken_at: number; views: number | null; follows: number | null };

/** An account's post samples since `lo` in the caller's workspace, by item, oldest first. A weekly-sampled post's
 *  previous sample can be up to a week before a period, so callers read from 8 days before it. */
async function postRows(c: OpCtx, accountId: string, lo: number): Promise<Map<string, PostRow[]>> {
  const posts = await c.env.DB.prepare(
    "SELECT item_key, taken_at, views, follows FROM post_metrics WHERE account = ?1 AND workspace_id = ?2 AND taken_at >= ?3 ORDER BY taken_at",
  )
    .bind(accountId, c.caller.workspaceId, lo)
    .all<PostRow>();
  const byItem = new Map<string, PostRow[]>();
  for (const r of posts.results) byItem.set(r.item_key, [...(byItem.get(r.item_key) ?? []), r]);
  return byItem;
}

/** The views an account's posts added each day from `from` to `until` (days on `tz`'s clock): each post's daily
 *  growth, summed; a post sampled from its first hours counts its publishing day (a zero just before that day), an
 *  older post's first sample is its lifetime count, a base. Null for a day no post has a value. */
function viewsPerDay(
  byItem: Map<string, PostRow[]>,
  published: Map<string, number>,
  from: number,
  until: number,
  tz: string,
): Point[] {
  const views = new Map<string, number>();
  for (const [key, rows] of byItem) {
    const pts: Point[] = rows.map((r) => ({ at: r.taken_at, value: r.views }));
    const pub = published.get(key);
    const first = rows[0];
    if (pub !== undefined && first && first.taken_at >= pub && first.taken_at - pub <= METRICS_DENSE_S) {
      const start = zoneToUnix(zoneDate(new Date(pub * 1000), tz), "00:00", tz) ?? pub - 86400;
      pts.unshift({ at: start - 1, value: 0 });
    }
    for (const p of dailyGrowth(pts, tz))
      if (p.at >= from && p.value !== null) {
        const d = zoneDate(new Date(p.at * 1000), tz);
        views.set(d, (views.get(d) ?? 0) + p.value);
      }
  }
  const out: Point[] = [];
  for (let d = zoneDate(new Date(from * 1000), tz); d <= zoneDate(new Date(until * 1000), tz); d = shiftDate(d, 1))
    out.push({ at: zoneToUnix(d, "00:00", tz) ?? zoneToUnix(d, "12:00", tz) ?? 0, value: views.get(d) ?? null });
  return out;
}

/** The counts a sample carries; `metrics` picks a subset (an agent asking for less). */
export const STAT_FIELDS = [
  "views",
  "reach",
  "likes",
  "comments",
  "saves",
  "shares",
  "follows",
  "profile_visits",
] as const;

function pickMetrics(metrics: unknown): ((p: Sample) => Record<string, number | null>) | null {
  if (metrics === undefined || metrics === null || metrics === "") return null;
  const list = Array.isArray(metrics) ? metrics.map(String) : String(metrics).split(",");
  const bad = list.filter((m) => !(STAT_FIELDS as readonly string[]).includes(m));
  if (bad.length) throw new ApiError(400, `unknown metrics: ${bad.join(", ")} (known: ${STAT_FIELDS.join(", ")})`);
  return (p) => Object.fromEntries([["at", p.at], ...list.map((m) => [m, p[m as (typeof STAT_FIELDS)[number]]])]);
}

/**
 * get_metrics: one post's or video's series (totals, or each day's growth with `daily`), its 24 h numbers, and its
 * Trial Reel copy's series and 24 h numbers when it has one; `metrics` leaves the other counts out of each point.
 */
export async function agentItemMetrics(c: OpCtx, o: MetricsQuery & { key: string; metrics?: unknown }) {
  const pick = pickMetrics(o.metrics);
  const shape = (pts: Sample[]) => (pick ? pts.map(pick) : pts);
  if (o.key.startsWith("video:")) {
    const mapped = (await workspaceBongsu(c)).get(o.key.slice(6));
    if (!mapped) {
      const v = await uploadMetrics(c, { ...o, video: o.key.slice(6) });
      return { ...v, samples: shape(v.samples) };
    }
    return agentItemMetrics(c, { ...o, key: mapped }); // a Bongsu upload's series is its item's
  }
  const m = await itemMetrics(c, o);
  const posted = await getPosted(c.env.DB, o.key);
  const t = await c.env.DB.prepare("SELECT published_at, at FROM trial_posts WHERE item_key = ?1")
    .bind(o.key)
    .first<{ published_at: number | null; at: number }>();
  return {
    ...m,
    samples: shape(m.samples),
    results: posted?.published_at ? await results24h(c, o.key, posted.published_at) : null,
    ...(m.trial
      ? {
          trial: {
            samples: shape(m.trial.samples),
            results: t ? await results24h(c, `trial:${o.key}`, t.published_at ?? t.at) : null,
          },
        }
      : {}),
  };
}

/**
 * get_account_metrics: an account's followers (totals, or each day's growth with `daily`) and the views its posts
 * added per day, from `from` to `to` (dates on the caller's clock, inclusive; the last 30 days by default), at most
 * METRICS_MAX_POINTS points, the newest.
 */
export async function accountMetrics(c: OpCtx, o: MetricsQuery & { account: string }) {
  const ws = c.caller.workspaceId;
  const a = (await listAccounts(c.env.DB, { workspaceId: ws, all: true })).find((x) => x.id === o.account);
  if (!a) throw new ApiError(404, `no account ${o.account} in this workspace`);
  const tz = await zoneOf(c);
  const today = zoneDate(c.now, tz);
  dayStart(o.to, "to", tz); // a 400 for a malformed one before it is shifted
  const toDate = o.to ?? today;
  const fromDate = o.from ?? shiftDate(toDate, -29);
  const lo = dayStart(fromDate, "from", tz) as number;
  dayStart(toDate, "to", tz); // a 400 for a malformed one before shifting it
  const hi = (dayStart(shiftDate(toDate, 1), "to", tz) as number) - 1; // the end of `to`
  const rows = await c.env.DB.prepare(
    "SELECT taken_at, followers FROM account_metrics WHERE account = ?1 AND workspace_id = ?2 AND taken_at >= ?3 AND taken_at <= ?4 ORDER BY taken_at",
  )
    .bind(a.id, ws, lo - 8 * 86400, hi)
    .all<{ taken_at: number; followers: number | null }>();
  const pts: Point[] = rows.results.map((r) => ({ at: r.taken_at, value: r.followers }));
  const followers = (o.daily ? dailyGrowth(pts, tz) : pts).filter((p) => p.at >= lo).slice(-METRICS_MAX_POINTS);
  const uploads = a.platform === "youtube" ? await cachedUploads(c, a.id) : [];
  const views = viewsPerDay(
    await postRows(c, a.id, lo - 8 * 86400),
    await publishedTimes(c, a.id, uploads),
    lo,
    hi,
    tz,
  );
  return {
    account: { id: a.id, platform: a.platform, title: a.displayName ?? a.handle },
    followers,
    views: views.slice(-METRICS_MAX_POINTS),
  };
}

const PERF_SORTS = [...STAT_FIELDS, "views_24h", "published_at"] as const;

/**
 * list_performance: one row per post or video of the workspace published in the window (a post without a known
 * publishing time counts its first sample's), with its latest totals, its 24 h views and the followers it brought,
 * sorted by one of them (highest first, rows without it last), at most `limit` (50; 200 at most). A Trial copy's row
 * follows its Reel's when both are in the page.
 */
export async function performanceList(
  c: OpCtx,
  o: { account?: string; platform?: string; from?: string; to?: string; sort?: string; limit?: number },
) {
  const sort = o.sort || "views";
  if (!(PERF_SORTS as readonly string[]).includes(sort))
    throw new ApiError(400, `sort is one of ${PERF_SORTS.join(", ")}`);
  const limit = Math.min(Math.max(Math.floor(o.limit ?? 50), 1), 200);
  const ws = c.caller.workspaceId;
  const tz = await zoneOf(c);
  dayStart(o.to, "to", tz); // a 400 for a malformed one before it is shifted
  const toDate = o.to ?? zoneDate(c.now, tz);
  const fromDate = o.from ?? shiftDate(toDate, -29);
  const lo = dayStart(fromDate, "from", tz) as number;
  dayStart(toDate, "to", tz);
  const hi = (dayStart(shiftDate(toDate, 1), "to", tz) as number) - 1;
  const accounts = (await listAccounts(c.env.DB, { workspaceId: ws, all: true })).filter(
    (a) => (!o.account || a.id === o.account) && (!o.platform || a.platform === o.platform),
  );
  const published = new Map<string, number>();
  const titles = new Map<string, { title: string; label: string }>();
  const mine = await workspaceBongsu(c); // Bongsu uploads, counted under their item (D6)
  const mineVideos = new Set([...mine.keys()].map((id) => `video:${id}`));
  for (const a of accounts) {
    const uploads = (a.platform === "youtube" ? await cachedUploads(c, a.id) : []).filter((u) => !mine.has(u.id));
    for (const [k, v] of await publishedTimes(c, a.id, uploads)) published.set(k, v);
    for (const u of uploads)
      titles.set(`video:${u.id}`, { title: u.title, label: (u as { short?: boolean }).short ? "Short" : "Video" });
  }
  const accountOf = new Map(accounts.map((a) => [a.id, a]));
  // every sample of a post published in the window is in it; the first sample of each key tells the unknown ones
  const rows = await c.env.DB.prepare(
    "SELECT item_key, account, platform, taken_at, views, reach, likes, comments, saves, shares, follows, profile_visits FROM post_metrics WHERE workspace_id = ?1 AND taken_at >= ?2 ORDER BY taken_at",
  )
    .bind(ws, lo)
    .all<Sample & { item_key: string; account: string; platform: string; taken_at: number }>();
  const firsts = new Map(
    (
      await c.env.DB.prepare(
        "SELECT item_key, MIN(taken_at) AS first FROM post_metrics WHERE workspace_id = ?1 GROUP BY item_key",
      )
        .bind(ws)
        .all<{ item_key: string; first: number }>()
    ).results.map((r) => [r.item_key, r.first]),
  );
  const byKey = new Map<string, typeof rows.results>();
  for (const r of rows.results)
    if (accountOf.has(r.account) && !mineVideos.has(r.item_key))
      byKey.set(r.item_key, [...(byKey.get(r.item_key) ?? []), { ...r, at: r.taken_at }]);
  const keys = [...byKey.keys()].filter((k) => {
    const pub = published.get(k) ?? firsts.get(k);
    return pub !== undefined && pub >= lo && pub <= hi;
  });
  // the plan items' titles and formats, in one query
  const bases = [...new Set(keys.filter((k) => !k.startsWith("video:")).map((k) => k.replace(/^trial:/, "")))];
  if (bases.length) {
    const items = await c.env.DB.prepare(
      `SELECT item_key, account, name, title, format FROM plan_items WHERE workspace_id = ?1 AND item_key IN ${jsonList(c.env.DB, 2)}`,
    )
      .bind(ws, JSON.stringify(bases))
      .all<{ item_key: string; account: string; name: string; title: string | null; format: string | null }>();
    for (const i of items.results)
      titles.set(i.item_key, {
        title: i.title || i.name,
        label: formatLabel(platform(accountOf.get(i.account)?.platform ?? "instagram"), i.format as PlanItem["format"]),
      });
  }
  const all = keys.map((k) => {
    const s = byKey.get(k) as Sample[] & { account: string; platform: string }[];
    const last = s[s.length - 1] as Sample & { account: string; platform: string };
    const base = k.replace(/^trial:/, "");
    const t = titles.get(k.startsWith("video:") ? k : base);
    const pub = published.get(k) ?? firsts.get(k) ?? null;
    return {
      key: k,
      platform: last.platform,
      account: last.account,
      title: t ? `${t.title}${k.startsWith("trial:") ? " · Trial Reel" : ""}` : base,
      label: k.startsWith("trial:") ? "Trial Reel" : (t?.label ?? null),
      ...(last.platform === "youtube" ? { source: sourceOf(k) } : {}),
      published_at: iso(pub),
      at: last.at,
      ...Object.fromEntries(STAT_FIELDS.map((f) => [f, last[f]])),
      views_24h: pub === null ? null : (nearest24h(s, pub, { strict: true })?.views ?? null),
    } as Record<string, unknown> & { key: string };
  });
  const value = (r: Record<string, unknown>) => {
    const v = r[sort];
    return v === null || v === undefined ? null : typeof v === "string" ? Date.parse(v) : (v as number);
  };
  all.sort((a, b) => {
    const x = value(a);
    const y = value(b);
    if (x === null || y === null) return x === null ? (y === null ? 0 : 1) : -1;
    return y - x || a.key.localeCompare(b.key);
  });
  const page = all.slice(0, limit);
  const inPage = new Set(page.map((r) => r.key));
  const out: typeof page = [];
  for (const r of page) {
    if (r.key.startsWith("trial:") && inPage.has(r.key.slice(6))) continue; // placed after its Reel
    out.push(r);
    const t = page.find((x) => x.key === `trial:${r.key}`);
    if (t) out.push(t);
  }
  return { from: fromDate, to: toDate, sort, limit, rows: out };
}

const INGEST_MAX = 500;
const ZONED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
// a newer sample would stand in for the 24 h result the owner is notified of (results.ts reuses one within the hour)
const INGEST_MIN_AGE_S = 3600;
const POST_FIELDS = new Set(["key", "at", ...STAT_FIELDS]);
const ACCOUNT_FIELDS = new Set(["account", "at", "followers"]);

type IngestTarget = { account: string; platform: string; mediaId: string };

/** Where each post key's samples go: plan keys that went out and their trial: copies in one query each (any number
 *  of keys: one JSON parameter), video: ids from the workspace channels' upload lists, each channel refreshed at most
 *  once however many ids are unknown (only a channel's 50 latest uploads are listed). */
async function ingestTargets(c: OpCtx, keys: string[]): Promise<Map<string, IngestTarget>> {
  const ws = c.caller.workspaceId;
  const out = new Map<string, IngestTarget>();
  const plain = keys.filter((k) => !k.startsWith("trial:") && !k.startsWith("video:"));
  const trials = keys.filter((k) => k.startsWith("trial:")).map((k) => k.slice(6));
  const rows = (table: string, list: string[]) =>
    list.length
      ? c.env.DB.prepare(
          `SELECT p.item_key, p.account, p.media_id FROM ${table} p JOIN plan_items i ON i.item_key = p.item_key
            WHERE i.workspace_id = ?1 AND p.item_key IN ${jsonList(c.env.DB, 2)}`,
        )
          .bind(ws, JSON.stringify(list))
          .all<{ item_key: string; account: string; media_id: string | null }>()
          .then((r) => r.results)
      : Promise.resolve([]);
  for (const r of await rows("posted", plain))
    out.set(r.item_key, { account: r.account, platform: "instagram", mediaId: r.media_id ?? "" });
  for (const r of await rows("trial_posts", trials))
    out.set(`trial:${r.item_key}`, { account: r.account, platform: "instagram", mediaId: r.media_id ?? "" });
  const videos = new Set(keys.filter((k) => k.startsWith("video:")).map((k) => k.slice(6)));
  if (videos.size) {
    const channels = await youtubeAccounts(c.env.DB, ws);
    const look = async (refresh: boolean) => {
      for (const a of channels) {
        try {
          for (const u of await channelUploads(c.env, c.fetch, a, refresh))
            if (videos.has(u.id) && !out.has(`video:${u.id}`))
              out.set(`video:${u.id}`, { account: a.id, platform: "youtube", mediaId: u.id });
        } catch {
          // a channel that can't be read doesn't hide the others
        }
      }
    };
    await look(false);
    if ([...videos].some((id) => !out.has(`video:${id}`))) await look(true);
  }
  return out;
}

/**
 * ingest_metrics: samples collected outside Bongsu, into the same series the sampler fills. Posts by key (a plan key
 * of the workspace that went out, its trial: copy, or video:<id> of a workspace channel's 50 latest uploads),
 * accounts by id; `at` ISO 8601 with a zone and at least an hour ago. Every row is checked first: one bad row answers
 * 400 naming each problem and writes nothing. A sample already there (same key or account and time) is skipped, so an
 * upload can be sent again. Any number of keys costs a fixed number of queries (JSON list parameters, multi-row
 * inserts), within D1's bound-parameter limit.
 */
export async function ingestMetrics(c: OpCtx, b: Record<string, unknown>) {
  const ws = c.caller.workspaceId;
  const list = (v: unknown, name: string) => {
    if (v === undefined) return [];
    if (!Array.isArray(v)) throw new ApiError(400, `${name} must be a list`);
    return v as Record<string, unknown>[];
  };
  const posts = list(b.posts, "posts");
  const accounts = list(b.accounts, "accounts");
  if (!posts.length && !accounts.length) throw new ApiError(400, "nothing to ingest: send posts, accounts or both");
  if (posts.length + accounts.length > INGEST_MAX)
    throw new ApiError(400, `at most ${INGEST_MAX} rows a call (got ${posts.length + accounts.length})`);
  const nowS = Math.floor(c.now.getTime() / 1000);
  const problems: string[] = [];
  const fields = (row: Record<string, unknown>, allowed: Set<string>, where: string) => {
    if (typeof row !== "object" || row === null) return void problems.push(`${where}: not an object`);
    for (const k of Object.keys(row)) if (!allowed.has(k)) problems.push(`${where}: unknown field ${k}`);
  };
  const when = (row: Record<string, unknown>, where: string) => {
    const at = typeof row.at === "string" && ZONED.test(row.at) ? Date.parse(row.at) : Number.NaN;
    if (!Number.isFinite(at)) return void problems.push(`${where}: at must be ISO 8601 with a zone`);
    const s = Math.floor(at / 1000);
    if (s > nowS - INGEST_MIN_AGE_S)
      return void problems.push(`${where}: at must be at least an hour ago (a newer sample is the sampler's to take)`);
    return s;
  };
  const count = (row: Record<string, unknown>, f: string, where: string, required = false) => {
    const v = row[f];
    if (v === undefined || v === null) {
      if (required) problems.push(`${where}: ${f} must be a whole number, 0 or more`);
      return null;
    }
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0)
      return void problems.push(`${where}: ${f} must be a whole number, 0 or more`);
    return v;
  };
  const accountsOf = new Map(
    (await listAccounts(c.env.DB, { workspaceId: ws, all: true })).map((a) => [a.id, a] as const),
  );
  const keys = [...new Set(posts.map((r) => (typeof r?.key === "string" ? r.key : "")).filter(Boolean))];
  const targets = await ingestTargets(c, keys);
  const postRowsIn: { key: string; t: IngestTarget; at: number; v: (number | null)[] }[] = [];
  for (const [i, row] of posts.entries()) {
    const where = `posts[${i}]`;
    fields(row, POST_FIELDS, where);
    const key = typeof row?.key === "string" ? row.key : "";
    const t = targets.get(key);
    if (!t || !accountsOf.has(t.account))
      problems.push(`${where}: ${key || "a key"} isn't a post of this workspace that went out`);
    const at = when(row ?? {}, where);
    const v = STAT_FIELDS.map((f) => count(row ?? {}, f, where));
    if (v.every((x) => x === null || x === undefined)) problems.push(`${where}: no counts (views, reach, likes…)`);
    if (t && at !== undefined) postRowsIn.push({ key, t, at, v: v as (number | null)[] });
  }
  const accountRowsIn: { a: string; platform: string; at: number; followers: number | null }[] = [];
  for (const [i, row] of accounts.entries()) {
    const where = `accounts[${i}]`;
    fields(row, ACCOUNT_FIELDS, where);
    const a = typeof row?.account === "string" ? accountsOf.get(row.account) : undefined;
    if (!a) problems.push(`${where}: ${String(row?.account ?? "an account")} isn't an account of this workspace`);
    const at = when(row ?? {}, where);
    const followers = count(row ?? {}, "followers", where, true);
    if (a && at !== undefined) accountRowsIn.push({ a: a.id, platform: a.platform, at, followers: followers ?? null });
  }
  if (problems.length) throw new ApiError(400, `nothing was written: ${problems.join("; ")}`, { problems });

  const seen = async (sql: string, ids: string[]) => {
    if (!ids.length) return new Set<string>();
    const r = await c.env.DB.prepare(`${sql} ${jsonList(c.env.DB, 2)}`)
      .bind(ws, JSON.stringify(ids))
      .all<{ id: string; taken_at: number }>();
    return new Set(r.results.map((x) => `${x.id}@${x.taken_at}`));
  };
  const havePosts = await seen(
    "SELECT item_key AS id, taken_at FROM post_metrics WHERE workspace_id = ?1 AND item_key IN",
    [...new Set(postRowsIn.map((r) => r.key))],
  );
  const haveAccounts = await seen(
    "SELECT account AS id, taken_at FROM account_metrics WHERE workspace_id = ?1 AND account IN",
    [...new Set(accountRowsIn.map((r) => r.a))],
  );
  const newPosts = postRowsIn.filter((r) => {
    const k = `${r.key}@${r.at}`;
    return havePosts.has(k) ? false : (havePosts.add(k), true);
  });
  const newAccounts = accountRowsIn.filter((r) => {
    const k = `${r.a}@${r.at}`;
    return haveAccounts.has(k) ? false : (haveAccounts.add(k), true);
  });
  // multi-row inserts within D1's 100 bound parameters a statement, all in one batch (one transaction)
  const stmts = [];
  const cols = 5 + STAT_FIELDS.length; // item_key, account, platform, media_id, taken_at, the counts (+ the workspace)
  const perPost = Math.floor(99 / cols);
  for (let i = 0; i < newPosts.length; i += perPost) {
    const chunk = newPosts.slice(i, i + perPost);
    const values = chunk.map(
      (_, j) =>
        `(${Array.from({ length: cols }, (_, k) => `?${j * cols + k + 1}`).join(", ")}, ?${chunk.length * cols + 1})`,
    );
    stmts.push(
      c.env.DB.prepare(
        `INSERT INTO post_metrics (item_key, account, platform, media_id, taken_at, ${STAT_FIELDS.join(", ")}, workspace_id) VALUES ${values.join(", ")}`,
      ).bind(...chunk.flatMap((r) => [r.key, r.t.account, r.t.platform, r.t.mediaId, r.at, ...r.v]), ws),
    );
  }
  for (let i = 0; i < newAccounts.length; i += 24) {
    const chunk = newAccounts.slice(i, i + 24);
    const values = chunk.map(
      (_, j) => `(?${j * 4 + 1}, ?${j * 4 + 2}, ?${j * 4 + 3}, ?${j * 4 + 4}, ?${chunk.length * 4 + 1})`,
    );
    stmts.push(
      c.env.DB.prepare(
        `INSERT INTO account_metrics (account, platform, taken_at, followers, workspace_id) VALUES ${values.join(", ")}`,
      ).bind(...chunk.flatMap((r) => [r.a, r.platform, r.at, r.followers]), ws),
    );
  }
  if (stmts.length) await c.env.DB.batch(stmts);
  const answer = {
    posts: { added: newPosts.length, skipped: postRowsIn.length - newPosts.length },
    accounts: { added: newAccounts.length, skipped: accountRowsIn.length - newAccounts.length },
  };
  await audit(c, "ingest_metrics", null, answer);
  return answer;
}
