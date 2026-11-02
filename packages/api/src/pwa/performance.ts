// The app's Performance screen: the latest snapshot against the day before it. The
// snapshots and reviews are in D1, imported from an earlier collector; nothing is read from a repo.
import { listAccounts } from "@bongsu/core/accounts";
import type { Env } from "@bongsu/core/env";
import { utcIso } from "@bongsu/core/formats/time";
import { accountHref, followerChange } from "../agent/ops";

/** Where each account lives (the snapshot only names it). */
export function accountUrl(platform: string, account: string): string | null {
  if (platform === "instagram") return `https://www.instagram.com/${account}/`;
  if (platform === "youtube")
    return (
      (
        { main: "https://www.youtube.com/@demo-main", vlogs: "https://www.youtube.com/@demo-vlogs" } as Record<
          string,
          string
        >
      )[account] ?? null
    );
  return null;
}

interface Account {
  platform: string;
  account: string;
  title?: string;
  followers: number | null;
}
interface Row {
  platform: string;
  account: string;
  format?: string;
  published?: string;
  title?: string;
  url?: string;
  views?: number | null;
  likes?: number | null;
  comments?: number | null;
  shares?: number | null;
  saves?: number | null;
  engagement_rate?: number | null;
  views_vs_median?: number | null;
}
interface Snapshot {
  taken: string;
  accounts: Account[];
  rows: Row[];
}

export interface Performance {
  taken: string;
  previous: string | null;
  accounts: (Account & { change: number | null; url: string | null; since?: string | null })[];
  recent: Row[]; // published in the 7 days before the snapshot, most viewed first
  best: Row[]; // the most above their account's median, any age
  /** The latest review's name (open it with /app-api/report?name=…), or null. */
  report: string | null;
}

/** The workspace's accounts from the account series: each active account with a sample, its count and change. */
async function seriesAccounts(env: Env, workspaceId: string, nowS: number) {
  const weekAgo = nowS - 8 * 86400;
  const rows = await env.DB.prepare(
    "SELECT account, taken_at, followers FROM account_metrics WHERE workspace_id = ?1 AND taken_at >= ?2 ORDER BY taken_at",
  )
    .bind(workspaceId, weekAgo)
    .all<{ account: string; taken_at: number; followers: number | null }>();
  const latestAt = rows.results.at(-1)?.taken_at ?? null;
  const out = [];
  for (const a of await listAccounts(env.DB, { workspaceId })) {
    const mine = rows.results.filter((r) => r.account === a.id);
    if (!mine.length) continue;
    out.push({
      platform: a.platform,
      account: a.id,
      title: a.displayName ?? undefined,
      url: accountHref(a),
      ...followerChange(mine),
    });
  }
  return { accounts: out, latestAt };
}

export async function performance(env: Env, workspaceId: string, nowS: number): Promise<Performance | { none: true }> {
  const series = await seriesAccounts(env, workspaceId, nowS);
  const last = await env.DB.prepare("SELECT day, data FROM snapshots WHERE workspace_id = ?1 ORDER BY day DESC LIMIT 1")
    .bind(workspaceId)
    .first<{ day: string; data: string }>();
  const latestReport = () =>
    env.DB.prepare("SELECT name FROM reports WHERE workspace_id = ?1 ORDER BY name DESC LIMIT 1")
      .bind(workspaceId)
      .first<{ name: string }>();
  if (!last) {
    if (!series.accounts.length || series.latestAt === null) return { none: true };
    return {
      taken: utcIso(series.latestAt),
      previous: null,
      accounts: series.accounts,
      recent: [],
      best: [],
      report: (await latestReport())?.name ?? null,
    };
  }
  // Compare with the day before the latest snapshot (or the nearest earlier one when that day is missing).
  const dayBefore = new Date(Date.parse(`${last.day}T00:00:00Z`) - 86400_000).toISOString().slice(0, 10);
  const [prevRow, report] = await Promise.all([
    env.DB.prepare("SELECT data FROM snapshots WHERE day <= ?1 AND workspace_id = ?2 ORDER BY day DESC LIMIT 1")
      .bind(dayBefore, workspaceId)
      .first<{ data: string }>(),
    latestReport(),
  ]);
  const cur = JSON.parse(last.data) as Snapshot;
  const prev = prevRow ? (JSON.parse(prevRow.data) as Snapshot) : null;
  const before = new Map((prev?.accounts ?? []).map((a) => [`${a.platform}:${a.account}`, a.followers]));
  const week = Date.parse(cur.taken) - 7 * 86400_000;
  const slim = (r: Row): Row => ({
    platform: r.platform,
    account: r.account,
    format: r.format,
    published: r.published?.slice(0, 10),
    title: r.title?.slice(0, 80),
    url: r.url,
    views: r.views,
    likes: r.likes,
    comments: r.comments,
    shares: r.shares,
    saves: r.saves,
    engagement_rate: r.engagement_rate,
    views_vs_median: r.views_vs_median,
  });
  return {
    taken: cur.taken,
    previous: prev?.taken ?? null,
    // the series once the workspace has one (one source of truth for followers), the snapshot's before that
    accounts: series.accounts.length
      ? series.accounts
      : cur.accounts.map((a) => {
          const b = before.get(`${a.platform}:${a.account}`);
          return {
            platform: a.platform,
            account: a.account,
            title: a.title,
            followers: a.followers,
            change: a.followers != null && b != null ? a.followers - b : null,
            url: accountUrl(a.platform, a.account),
          };
        }),
    recent: cur.rows
      .filter((r) => r.published && Date.parse(r.published.replace(/([+-]\d\d)(\d\d)$/, "$1:$2")) >= week)
      .sort((a, b) => (b.views ?? 0) - (a.views ?? 0))
      .slice(0, 10)
      .map(slim),
    best: cur.rows
      .filter((r) => (r.views_vs_median ?? 0) > 1)
      .sort((a, b) => (b.views_vs_median ?? 0) - (a.views_vs_median ?? 0))
      .slice(0, 5)
      .map(slim),
    report: report?.name ?? null,
  };
}

/** One review (markdown), and the names of all of them, newest first. */
export async function report(
  env: Env,
  name: string,
  workspaceId: string,
): Promise<{ name: string; markdown: string; all: string[] } | null> {
  const [r, all] = await Promise.all([
    env.DB.prepare("SELECT name, markdown FROM reports WHERE name = ?1 AND workspace_id = ?2")
      .bind(name, workspaceId)
      .first<{ name: string; markdown: string }>(),
    env.DB.prepare("SELECT name FROM reports WHERE workspace_id = ?1 ORDER BY name DESC")
      .bind(workspaceId)
      .all<{ name: string }>(),
  ]);
  return r ? { ...r, all: all.results.map((x) => x.name) } : null;
}
