// Post metrics: the schedule rule and the series math (pure), then the sampler that takes the samples (database and
// providers, run by the inbox cron).
import { type Account, instagramAccounts, youtubeAccounts } from "./accounts";
import { channelUploads, YT_TTL_S } from "./calendar";
import type { Upload } from "./clients/youtube";
import {
  METRICS_ATTEMPTS_PER_RUN,
  METRICS_DAILY_S,
  METRICS_DAILY_UNTIL_S,
  METRICS_DENSE_S,
  METRICS_DENSE_UNTIL_S,
  METRICS_PER_RUN,
  METRICS_REFRESH_PER_RUN,
  METRICS_STOP_S,
  METRICS_WEEKLY_S,
} from "./constants";
import type { Env } from "./env";
import { shiftDate, zoneDate, zoneToUnix } from "./formats/time";
import { providerFor } from "./providers/index";
import type { Provider } from "./providers/types";
import { YouTubeProvider, youtubeAnalytics } from "./providers/youtube";

/** The Instagram insight names; `saved` is stored in the `saves` column. */
export const METRICS = ["views", "reach", "likes", "comments", "saved", "shares"] as const;
/** The followers a post brought: Instagram answers them for feed posts and Reels, not for every media type or
 *  account, so they are asked for together with METRICS and dropped on a refusal (insightsOf). */
export const FOLLOW_METRICS = ["follows", "profile_visits"] as const;
const NO_FOLLOWS = "metrics_nofollows:";
/** Analytics publishes a video's numbers a day or more late: before this age a missing row is "not yet", after it
 *  "none gained". */
const ANALYTICS_LAG_S = 72 * 3600;

/** A post's insights, with the follow metrics when the media type has them: one call for all; when Instagram refuses
 *  the metrics ("metric[n] must be one of …", a 400 that names them), one retry without them, so an older post or an
 *  account type without them still gets its counts. Any other failure is the caller's. */
export async function insightsOf(
  env: Env,
  pr: Pick<Provider, "results">,
  itemKey: string,
  mediaId: string,
): Promise<Record<string, number | null>> {
  if (!pr.results) throw new Error("this provider has no insights");
  // a refusal is remembered per post (a media's type doesn't change), so it pays the retry once, not every sample
  const key = NO_FOLLOWS + itemKey;
  if (await env.DB.prepare("SELECT 1 AS x FROM settings WHERE key = ?1").bind(key).first())
    return pr.results(mediaId, [...METRICS]);
  try {
    return await pr.results(mediaId, [...METRICS, ...FOLLOW_METRICS]);
  } catch (e) {
    if (!/metric/i.test((e as Error).message)) throw e;
    const nowS = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES (?1, '1', ?2) ON CONFLICT (key) DO UPDATE SET updated_at = excluded.updated_at",
    )
      .bind(key, nowS)
      .run();
    return pr.results(mediaId, [...METRICS]);
  }
}

/** One `post_metrics` row. A metric is null when the platform doesn't report it (YouTube has no reach, saves or shares). */
export interface Sample {
  at: number;
  views: number | null;
  reach: number | null;
  likes: number | null;
  comments: number | null;
  saves: number | null;
  shares: number | null;
  /** Accounts that followed (Instagram) or subscribed (YouTube) because of the post, lifetime. */
  follows: number | null;
  /** Profile visits from the post, lifetime (Instagram only). */
  profile_visits: number | null;
}

const FIELDS = ["views", "reach", "likes", "comments", "saves", "shares", "follows", "profile_visits"] as const;

/** Seconds to wait between samples at this age; null once the post is too old to sample. Each band starts inclusive. */
export function sampleInterval(ageS: number): number | null {
  if (ageS >= METRICS_STOP_S) return null;
  if (ageS >= METRICS_DAILY_UNTIL_S) return METRICS_WEEKLY_S;
  if (ageS >= METRICS_DENSE_UNTIL_S) return METRICS_DAILY_S;
  return METRICS_DENSE_S;
}

/** When the next sample is due: right away without one, never (null) past the last band, sampled or not. */
export function nextSampleAt(publishedAt: number, lastAt: number | null, nowS: number): number | null {
  const interval = sampleInterval(nowS - publishedAt);
  if (interval === null) return null;
  return lastAt === null ? publishedAt : lastAt + interval;
}

export function isDue(publishedAt: number, lastAt: number | null, nowS: number): boolean {
  const next = nextSampleAt(publishedAt, lastAt, nowS);
  return next !== null && next <= nowS;
}

const dayOf = (at: number, tz: string) => zoneDate(new Date(at * 1000), tz);

/** A day without a sample still gets a point (all null), stamped at its start; noon if midnight doesn't exist there. */
function emptyPoint(day: string, tz: string): Sample {
  const at = zoneToUnix(day, "00:00", tz) ?? zoneToUnix(day, "12:00", tz) ?? 0;
  return {
    at,
    views: null,
    reach: null,
    likes: null,
    comments: null,
    saves: null,
    shares: null,
    follows: null,
    profile_visits: null,
  };
}

/**
 * Total mode: the samples by time. Daily mode: the last sample of each day on `tz`, then what each sampled day added
 * since the previous sampled day, one point per calendar day from the second sampled day to the last. A day without
 * a sample is null (a gap): past day 3 the schedule samples daily, then weekly, so the weekly band shows one point a
 * week, each the week's growth.
 */
export function series(rows: Sample[], o: { daily: boolean; tz: string }): Sample[] {
  const sorted = [...rows].sort((a, b) => a.at - b.at);
  if (!o.daily) return sorted;
  const lastOfDay = new Map<string, Sample>();
  for (const r of sorted) lastOfDay.set(dayOf(r.at, o.tz), r);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (!first || !last) return [];
  const lastDay = dayOf(last.at, o.tz);
  const out: Sample[] = [];
  let prev = lastOfDay.get(dayOf(first.at, o.tz));
  for (let day = shiftDate(dayOf(first.at, o.tz), 1); day <= lastDay; day = shiftDate(day, 1)) {
    const cur = lastOfDay.get(day);
    const point = cur ? { ...cur } : emptyPoint(day, o.tz);
    for (const f of FIELDS) {
      const a = cur?.[f];
      const b = prev?.[f];
      point[f] = typeof a === "number" && typeof b === "number" ? a - b : null;
    }
    out.push(point);
    if (cur) prev = cur;
  }
  return out;
}

/** One value over time (an account's followers, a post's views…). */
export interface Point {
  at: number;
  value: number | null;
}

/** Each sampled day's growth since the previous sampled day, on `tz`'s clock (the last point of a day stands for
 *  it; a point without a value counts as no sample); `null` for a day without one, from the second sampled day on.
 *  The rule `series` follows for a post's counts. */
export function dailyGrowth(points: Point[], tz: string): Point[] {
  const sorted = points.filter((p): p is { at: number; value: number } => typeof p.value === "number");
  sorted.sort((a, b) => a.at - b.at);
  const lastOfDay = new Map<string, { at: number; value: number }>();
  for (const p of sorted) lastOfDay.set(dayOf(p.at, tz), p);
  const first = sorted[0];
  // the range runs to the last point, valued or not, as series' does
  const last = points.reduce<Point | undefined>((m, p) => (!m || p.at > m.at ? p : m), undefined);
  if (!first || !last) return [];
  const out: Point[] = [];
  let prev = lastOfDay.get(dayOf(first.at, tz)) ?? first;
  for (let day = shiftDate(dayOf(first.at, tz), 1); day <= dayOf(last.at, tz); day = shiftDate(day, 1)) {
    const cur = lastOfDay.get(day);
    if (!cur) {
      out.push({ at: emptyPoint(day, tz).at, value: null }); // the day start (noon where midnight is skipped)
      continue;
    }
    out.push({ at: cur.at, value: cur.value - prev.value });
    prev = cur;
  }
  return out;
}

/** The sample closest to 24 h after publishing within ±6 h, else (unless `strict`) the latest, else null. Strict is
 *  for "the 24 h result": a first sample minutes after publishing isn't one. */
export function nearest24h(rows: Sample[], publishedAt: number, o: { strict?: boolean } = {}): Sample | null {
  const target = publishedAt + 86400;
  let best: Sample | null = null;
  for (const r of rows) {
    if (Math.abs(r.at - target) <= 6 * 3600 && (!best || Math.abs(r.at - target) < Math.abs(best.at - target)))
      best = r;
  }
  if (best || o.strict) return best;
  return rows.reduce<Sample | null>((l, r) => (!l || r.at > l.at ? r : l), null);
}

/** What a provider answered (Instagram insight names, `saved` for saves) as a sample taken at `at`. */
export function sampleOf(v: Record<string, number | null | undefined>, at: number): Sample {
  const n = (x: number | null | undefined) => (typeof x === "number" ? x : null);
  return {
    at,
    views: n(v.views),
    reach: n(v.reach),
    likes: n(v.likes),
    comments: n(v.comments),
    saves: n(v.saved ?? v.saves),
    shares: n(v.shares),
    follows: n(v.follows),
    profile_visits: n(v.profile_visits),
  };
}

/** Appends one sample to the series. */
export async function recordSample(
  env: Env,
  row: { itemKey: string; account: string; platform: string; mediaId: string; workspaceId: string },
  s: Sample,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO post_metrics (item_key, account, platform, media_id, taken_at, views, reach, likes, comments, saves, shares, follows, profile_visits, workspace_id)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`,
  )
    .bind(
      row.itemKey,
      row.account,
      row.platform,
      row.mediaId,
      s.at,
      s.views,
      s.reach,
      s.likes,
      s.comments,
      s.saves,
      s.shares,
      s.follows,
      s.profile_visits,
      row.workspaceId,
    )
    .run();
}

interface Candidate {
  itemKey: string;
  account: Account;
  mediaId: string;
  publishedAt: number;
  next: number;
}

const FAILED = "metrics_failed:";

/** Settings rows whose key starts with `prefix` (its `_` is LIKE's any-character, harmless: the keys are exact). */
async function settingsLike(env: Env, prefix: string) {
  const r = await env.DB.prepare("SELECT key, value, updated_at FROM settings WHERE key LIKE ?1")
    .bind(`${prefix}%`)
    .all<{ key: string; value: string; updated_at: number }>();
  return new Map(r.results.map((x) => [x.key.slice(prefix.length), x]));
}

/** Marks failed attempts: each post waits one sampling interval from now before it is tried again. One statement
 *  per 50 keys (a channel's whole due list fails at once; D1 binds at most 100 parameters), so a failed channel costs
 *  one write, not one per video, on the budget the attempt cap protects. */
async function stampFailure(env: Env, itemKeys: string[], nowS: number) {
  for (let i = 0; i < itemKeys.length; i += 50) {
    const keys = itemKeys.slice(i, i + 50);
    const now = keys.length + 1;
    const rows = keys.map((_, j) => `(?${j + 1}, ?${now}, ?${now})`).join(", ");
    await env.DB.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES ${rows} ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
      .bind(...keys.map((k) => FAILED + k), String(nowS))
      .run();
  }
}

/**
 * The YouTube accounts' upload lists for this run: the cached list when fresh; of the stale (or missing) ones, the
 * METRICS_REFRESH_PER_RUN oldest are refreshed, the rest keep their cached list (if any) until a later run, so a
 * workspace with many channels doesn't refresh them all at once.
 */
async function uploadLists(env: Env, deps: { fetch: typeof fetch }, nowS: number) {
  const cached = await settingsLike(env, "yt_uploads:");
  const accounts = await youtubeAccounts(env.DB);
  const age = (a: Account) => cached.get(a.id)?.updated_at ?? Number.NEGATIVE_INFINITY;
  const refresh = new Set(
    accounts
      .filter((a) => nowS - age(a) >= YT_TTL_S)
      .sort((a, b) => age(a) - age(b))
      .slice(0, METRICS_REFRESH_PER_RUN)
      .map((a) => a.id),
  );
  const out: { account: Account; uploads: Upload[] }[] = [];
  for (const account of accounts) {
    const c = cached.get(account.id);
    let uploads = c ? (JSON.parse(c.value) as Upload[]) : null;
    if (refresh.has(account.id)) {
      try {
        uploads = await channelUploads(env, deps.fetch, account, true, nowS);
      } catch (e) {
        console.log(`metrics ${account.id}: ${(e as Error).message}`); // its cached list, if any, still serves
      }
    }
    if (uploads) out.push({ account, uploads });
  }
  return out;
}

/**
 * The inbox run's sampler: of the published Instagram posts (and Trial copies, stories left out) and the public
 * YouTube uploads of every workspace, the ones due by the schedule, oldest due first, a few per run; each becomes a
 * post_metrics row. A failed attempt is stamped in settings (`metrics_failed:<key>`): the post waits a sampling
 * interval and ranks behind the others, so a few broken posts can't take every run's attempts; one failure of an
 * account (or channel) ends its turn for the run.
 */
export async function sampleMetrics(
  env: Env,
  deps: { fetch: typeof fetch; now: Date },
): Promise<{ sampled: string[] }> {
  const nowS = Math.floor(deps.now.getTime() / 1000);
  // a stamp older than the sampling stop belongs to a post past sampling: no success would ever clear it
  await env.DB.prepare("DELETE FROM settings WHERE (key LIKE ?1 OR key LIKE ?2) AND updated_at < ?3")
    .bind(`${FAILED}%`, `${NO_FOLLOWS}%`, nowS - METRICS_STOP_S)
    .run();
  const failedAt = new Map<string, number>();
  for (const [k, r] of await settingsLike(env, FAILED)) failedAt.set(k, Number(r.value));
  const found: Candidate[] = [];
  const consider = (c: Omit<Candidate, "next">, lastAt: number | null) => {
    let next = nextSampleAt(c.publishedAt, lastAt, nowS);
    if (next === null) return;
    const failed = failedAt.get(c.itemKey);
    if (failed !== undefined) next = Math.max(next, failed + (sampleInterval(nowS - c.publishedAt) ?? 0));
    if (next <= nowS) found.push({ ...c, next });
  };

  const accounts = new Map((await instagramAccounts(env.DB)).map((a) => [a.id, a]));
  const rows = await env.DB.prepare(
    `SELECT x.item_key, x.account, x.media_id, x.published,
            (SELECT MAX(m.taken_at) FROM post_metrics m WHERE m.item_key = x.item_key) AS last_at
       FROM (SELECT item_key, item_key AS plan_key, account, media_id, COALESCE(published_at, at) AS published FROM posted
             UNION ALL SELECT 'trial:' || item_key, item_key, account, media_id, COALESCE(published_at, at) FROM trial_posts) x
       LEFT JOIN plan_items p ON p.item_key = x.plan_key
      WHERE x.media_id IS NOT NULL AND x.published > ?1 AND COALESCE(p.format, 'feed') != 'story'`,
  )
    .bind(nowS - METRICS_STOP_S)
    .all<{ item_key: string; account: string; media_id: string; published: number; last_at: number | null }>();
  for (const r of rows.results) {
    const account = accounts.get(r.account);
    if (account) consider({ itemKey: r.item_key, account, mediaId: r.media_id, publishedAt: r.published }, r.last_at);
  }

  // A video's last sample by its key alone, as for Instagram: a change in the account order mustn't start a second
  // series. (A sample older than METRICS_STOP_S belongs to a video too old to sample anyway.)
  const lastVideo = new Map(
    (
      await env.DB.prepare(
        "SELECT item_key, MAX(taken_at) AS last_at FROM post_metrics WHERE platform = 'youtube' AND taken_at > ?1 GROUP BY item_key",
      )
        .bind(nowS - METRICS_STOP_S)
        .all<{ item_key: string; last_at: number }>()
    ).results.map((r) => [r.item_key, r.last_at]),
  );
  // Global across accounts and workspaces on purpose: one series per video, owned by the first account in the order.
  const seenVideos = new Set<string>();
  for (const { account, uploads } of await uploadLists(env, deps, nowS)) {
    for (const u of uploads) {
      const publishedAt = u.when ? Math.floor(Date.parse(u.when) / 1000) : Number.NaN;
      // two accounts on one channel list the same videos: the first account's candidate stands
      if (u.privacy !== "public" || !Number.isFinite(publishedAt) || seenVideos.has(u.id)) continue;
      seenVideos.add(u.id);
      consider(
        { itemKey: `video:${u.id}`, account, mediaId: u.id, publishedAt },
        lastVideo.get(`video:${u.id}`) ?? null,
      );
    }
  }

  const due = found.sort((a, b) => a.next - b.next);
  const sampled: string[] = [];
  const row = (c: Candidate, platform: string) => ({
    itemKey: c.itemKey,
    account: c.account.id,
    platform,
    mediaId: c.mediaId,
    workspaceId: c.account.workspaceId,
  });
  // One videos.list per channel: its due videos asked together the first time one of them comes up; with the
  // analytics scope, one Analytics query for the subscribers they gained since the oldest of them was published.
  type ChannelStats = Map<
    string,
    { views: number | null; likes: number | null; comments: number | null; follows: number | null }
  >;
  const stats = new Map<string, Promise<ChannelStats | null>>();
  const day = (unix: number) => new Date(unix * 1000).toISOString().slice(0, 10);
  const statsOf = (c: Candidate) => {
    let p = stats.get(c.account.id);
    if (!p) {
      const mine = due.filter((d) => d.account.id === c.account.id);
      const ids = mine.map((d) => d.mediaId);
      p = providerFor(env, deps.fetch, c.account).then(async (pr) => {
        if (!(pr instanceof YouTubeProvider)) throw new Error("no YouTube provider");
        const st = await pr.statistics(ids);
        let subs: Map<string, { gained: number }> | null = null;
        if (await youtubeAnalytics(env, c.account.connection)) {
          try {
            // Analytics days are Pacific Time: start the UTC day before, or a video published early in a UTC day
            // loses its first (Pacific) day; days before an upload count nothing anyway
            subs = await pr.subscribers(ids, day(Math.min(...mine.map((d) => d.publishedAt)) - 86400), day(nowS));
          } catch (e) {
            console.log(`metrics ${c.account.id}: ${(e as Error).message}`); // the counts still get sampled
          }
        }
        const out: ChannelStats = new Map();
        const age = new Map(mine.map((d) => [d.mediaId, nowS - d.publishedAt]));
        const gained = (id: string) => {
          if (!subs) return null;
          const r = subs.get(id);
          if (r) return r.gained;
          return (age.get(id) ?? 0) < ANALYTICS_LAG_S ? null : 0; // no row yet vs none gained
        };
        for (const [id, v] of st) out.set(id, { ...v, follows: gained(id) });
        return out;
      });
      p = p.catch((e: Error) => {
        console.log(`metrics ${c.account.id}: ${e.message}`);
        return null;
      });
      stats.set(c.account.id, p);
    }
    return p;
  };
  // A failing post doesn't use a METRICS_PER_RUN slot (it would starve everyone else); the attempts are bounded
  // instead, and an account that failed once this run gets no more of them.
  let attempts = 0;
  const failedAccounts = new Set<string>();
  const fail = async (c: Candidate, why: string) => {
    console.log(`metrics ${c.itemKey}: ${why}`);
    await stampFailure(env, [c.itemKey], nowS);
  };
  for (const c of due) {
    if (sampled.length >= METRICS_PER_RUN || attempts >= METRICS_ATTEMPTS_PER_RUN) break;
    if (failedAccounts.has(c.account.id)) continue;
    attempts++;
    try {
      if (c.account.platform === "youtube") {
        const all = await statsOf(c);
        if (!all) {
          // the one call asked for all the channel's due videos: they all failed (logged once by statsOf)
          failedAccounts.add(c.account.id);
          await stampFailure(
            env,
            due.filter((d) => d.account.id === c.account.id).map((d) => d.itemKey),
            nowS,
          );
          continue;
        }
        const st = all.get(c.mediaId);
        if (!st) {
          await fail(c, "no statistics"); // deleted or hidden since the uploads list was cached
          continue;
        }
        await recordSample(env, row(c, "youtube"), sampleOf(st, nowS));
      } else {
        const pr = await providerFor(env, deps.fetch, c.account);
        if (!pr?.results) {
          failedAccounts.add(c.account.id);
          await fail(c, `${c.account.id} has no insights`);
          continue;
        }
        await recordSample(env, row(c, "instagram"), sampleOf(await insightsOf(env, pr, c.itemKey, c.mediaId), nowS));
      }
      sampled.push(c.itemKey);
      if (failedAt.has(c.itemKey))
        await env.DB.prepare("DELETE FROM settings WHERE key = ?1")
          .bind(FAILED + c.itemKey)
          .run();
    } catch (e) {
      failedAccounts.add(c.account.id);
      await fail(c, (e as Error).message);
    }
  }
  return { sampled };
}
