// 24-hour results, in the inbox's cron run: a day after an Instagram post went out, its insights become a sample of
// the post_metrics series (a sample the sampler took within the hour is reused), compared with the median 24 h views
// of the account's earlier results; post_results keeps the marker that the notification went out and that median.
// A few posts per run; a post older than 3 days without a result is skipped.
// A Trial Reel copy (trial_posts) gets its own row, 'trial:<key>', compared with its regular Reel instead
// (it reaches a different audience, so it stays out of the account's median).

import { instagramAccounts } from "./accounts";
import type { Env } from "./env";
import { insightsOf, nearest24h, recordSample, type Sample, sampleOf } from "./metrics";
import { notifier } from "./notify";
import { providerFor } from "./providers/index";
import { results as resultsNote } from "./texts/notifications";

const AFTER_S = 24 * 3600;
const GIVE_UP_S = 72 * 3600;
const PER_RUN = 3;
const REUSE_S = 3600; // a sample taken within the hour is the 24 h result
const MEDIAN_OF = 20; // earlier posts the median covers

interface Due {
  item_key: string;
  account: string;
  media_id: string;
  published: number;
  title: string | null;
  name: string | null;
}

interface SampleRow {
  item_key: string;
  taken_at: number;
  views: number | null;
  reach: number | null;
  likes: number | null;
  comments: number | null;
  saves: number | null;
  shares: number | null;
  follows: number | null;
  profile_visits: number | null;
}
const asSample = (r: SampleRow): Sample => ({ ...r, at: r.taken_at });

/** The 24 h views of each key's post: its series' nearest sample to publishing + 24 h, within the window only (a
 *  post sampled only minutes after publishing has no 24 h views to compare). */
async function views24h(env: Env, published: Map<string, number>): Promise<number[]> {
  const keys = [...published.keys()];
  if (!keys.length) return [];
  const rows = await env.DB.prepare(
    `SELECT item_key, taken_at, views, reach, likes, comments, saves, shares, follows, profile_visits FROM post_metrics
      WHERE item_key IN (${keys.map((_, i) => `?${i + 1}`).join(",")})`,
  )
    .bind(...keys)
    .all<SampleRow>();
  return keys.flatMap((k) => {
    const at = published.get(k) as number;
    const v = nearest24h(rows.results.filter((r) => r.item_key === k).map(asSample), at, { strict: true })?.views;
    return typeof v === "number" ? [v] : [];
  });
}

/** What to compare a post's views with: its regular Reel's 24 h views for a Trial copy, else the median of the
 *  account's previous posts' 24 h views (Trial copies stay out). */
async function comparison(env: Env, d: Due, trial: boolean): Promise<number | null> {
  const published = new Map<string, number>();
  if (trial) {
    const key = d.item_key.slice("trial:".length);
    const p = await env.DB.prepare("SELECT COALESCE(published_at, at) AS at FROM posted WHERE item_key = ?1")
      .bind(key)
      .first<{ at: number }>();
    if (p) published.set(key, p.at);
  } else {
    const prev = await env.DB.prepare(
      `SELECT r.item_key, COALESCE(x.published_at, x.at) AS at FROM post_results r JOIN posted x ON x.item_key = r.item_key
        WHERE r.account = ?1 AND r.item_key != ?2 AND r.item_key NOT LIKE 'trial:%' ORDER BY r.fetched_at DESC LIMIT ?3`,
    )
      .bind(d.account, d.item_key, MEDIAN_OF)
      .all<{ item_key: string; at: number }>();
    for (const r of prev.results) published.set(r.item_key, r.at);
  }
  return median(await views24h(env, published));
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b),
    m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const nice = (name: string) =>
  name
    .replace(/^.*\//, "")
    .replace(/^(short|reel|carousel|cello)\d+_/, "")
    .replace(/_/g, " ")
    .replace(/^./, (c) => c.toUpperCase());

export async function postResults(env: Env, deps: { fetch: typeof fetch; now: Date }): Promise<{ fetched: string[] }> {
  const nowS = Math.floor(deps.now.getTime() / 1000);
  const accounts = new Map((await instagramAccounts(env.DB)).map((a) => [a.id, a]));
  const due = await env.DB.prepare(
    `SELECT x.item_key, x.account, x.media_id, x.published, p.title, p.name
       FROM (SELECT item_key, item_key AS plan_key, account, media_id, COALESCE(published_at, at) AS published FROM posted
             UNION ALL SELECT 'trial:' || item_key, item_key, account, media_id, COALESCE(published_at, at) FROM trial_posts) x
       LEFT JOIN post_results r ON r.item_key = x.item_key LEFT JOIN plan_items p ON p.item_key = x.plan_key
      WHERE r.item_key IS NULL AND x.media_id IS NOT NULL AND x.published BETWEEN ?1 AND ?2
        AND COALESCE(p.format, 'feed') != 'story'
      ORDER BY published, x.item_key LIMIT ?3`,
  )
    .bind(nowS - GIVE_UP_S, nowS - AFTER_S, PER_RUN)
    .all<Due>();
  if (!due.results.length) return { fetched: [] };
  /** Per workspace: its lines and items (one message each, to that workspace's devices). */
  const byWs = new Map<string, { lines: string[]; keys: string[] }>();
  const fetched: string[] = [];
  for (const d of due.results) {
    const acc = accounts.get(d.account);
    const pr = acc && (await providerFor(env, deps.fetch, acc));
    if (!acc || !pr?.results) continue;
    const trial = d.item_key.startsWith("trial:");
    const row = {
      itemKey: d.item_key,
      account: d.account,
      platform: "instagram",
      mediaId: d.media_id,
      workspaceId: acc.workspaceId,
    };
    const recent = await env.DB.prepare(
      `SELECT item_key, taken_at, views, reach, likes, comments, saves, shares, follows, profile_visits FROM post_metrics
        WHERE item_key = ?1 AND taken_at >= ?2 ORDER BY taken_at DESC LIMIT 1`,
    )
      .bind(d.item_key, nowS - REUSE_S)
      .first<SampleRow>();
    let v: Sample;
    if (recent) v = asSample(recent);
    else {
      try {
        v = sampleOf(await insightsOf(env, pr, d.item_key, d.media_id), nowS);
      } catch (e) {
        console.log(`results ${d.item_key}: ${(e as Error).message}`);
        continue; // tried again next run, until it's 3 days old
      }
      await recordSample(env, row, v);
    }
    const med = await comparison(env, d, trial);
    await env.DB.prepare(
      `INSERT INTO post_results (item_key, account, media_id, median_views, fetched_at, workspace_id)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT (item_key) DO NOTHING`,
    )
      .bind(d.item_key, d.account, d.media_id, med, nowS, acc.workspaceId)
      .run();
    const vs =
      med && v.views != null ? ` (${(v.views / med).toFixed(1)}× ${trial ? "the regular Reel" : "usual"})` : "";
    // the followers the post brought, when the platform reported them (a Trial copy's line shows its own)
    const grew =
      (v.follows != null ? ` · +${v.follows} followers` : "") +
      (v.profile_visits != null ? ` · ${v.profile_visits} profile visits` : "");
    const mine = byWs.get(acc.workspaceId) ?? { lines: [], keys: [] };
    byWs.set(acc.workspaceId, mine);
    mine.keys.push(d.item_key);
    mine.lines.push(
      `${trial ? "Trial: " : ""}${d.title || nice(d.name ?? d.item_key)} @${d.account}: ${v.views ?? "?"} views${vs}, ${v.likes ?? 0} likes, ${v.comments ?? 0} comments, ${v.saves ?? 0} saves${grew}`,
    );
    fetched.push(d.item_key);
  }
  const note = notifier(env.DB, deps.fetch, env.NOTIFY_URL, nowS, env);
  for (const [ws, { lines, keys }] of byWs)
    await note.send(resultsNote(lines, keys.length === 1 ? `results:${keys[0]}` : undefined), ws);
  return { fetched };
}
