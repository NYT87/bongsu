// The account series (Phase 9): once a day, each active Instagram account's follower count and each YouTube
// channel's subscriber count become an account_metrics row, a few accounts per inbox run, for every workspace. The
// nightly snapshots (imported from the earlier collector) backfill it once per workspace, so the channel page's
// chart starts with their history.
import { type Account, listAccounts } from "./accounts";
import {
  ACCOUNT_BACKFILL_PER_RUN,
  ACCOUNT_METRICS_S,
  ACCOUNTS_ATTEMPTS_PER_RUN,
  ACCOUNTS_PER_RUN,
  METRICS_DENSE_S,
  METRICS_STOP_S,
} from "./constants";
import type { Env } from "./env";
import { zoneToUnix } from "./formats/time";
import { providerFor } from "./providers/index";
import { YouTubeProvider } from "./providers/youtube";
import { callerZone } from "./workspaces";

const FAILED = "account_metrics_failed:";
const BACKFILLED = "account_metrics_backfill:";

/** An account's follower (or subscriber) count now; null when the platform hides it. */
async function followersOf(env: Env, fetcher: typeof fetch, a: Account): Promise<number | null> {
  const pr = await providerFor(env, fetcher, a);
  if (!pr) throw new Error(`${a.id} has no working connection`);
  if (pr instanceof YouTubeProvider) return pr.subscriberCount();
  return (await pr.verify()).followers;
}

/** A snapshot's `taken`: with an offset as given, without one on the workspace's clock. */
function takenAt(taken: string, tz: string): number | null {
  const iso = taken.replace(/([+-]\d\d)(\d\d)$/, "$1:$2");
  if (/(Z|[+-]\d\d:\d\d)$/i.test(iso)) {
    const t = Date.parse(iso);
    return Number.isNaN(t) ? null : Math.floor(t / 1000);
  }
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::(\d{2}))?/.exec(iso);
  const base = m ? zoneToUnix(m[1], m[2], tz) : null;
  return base === null || !m ? null : base + Number(m[3] ?? 0);
}

/** Each workspace's snapshots become samples (one per snapshot account with a count that names an account of that
 *  workspace), skipping those already there. The samples there are read once and the missing ones inserted 20 to a
 *  statement, ACCOUNT_BACKFILL_PER_RUN a run, so a long history costs a few bounded runs; the flag is set once
 *  nothing is missing. */
async function backfill(env: Env, nowS: number): Promise<number> {
  const ws = await env.DB.prepare("SELECT DISTINCT workspace_id FROM snapshots").all<{ workspace_id: string }>();
  let added = 0;
  for (const { workspace_id: w } of ws.results) {
    if (added >= ACCOUNT_BACKFILL_PER_RUN) break;
    const flag = await env.DB.prepare("SELECT 1 AS x FROM settings WHERE key = ?1")
      .bind(BACKFILLED + w)
      .first();
    if (flag) continue;
    const tz = await callerZone(env.DB, w);
    const known = new Map((await listAccounts(env.DB, { workspaceId: w, all: true })).map((a) => [a.id, a.platform]));
    const there = new Set(
      (
        await env.DB.prepare("SELECT account, taken_at FROM account_metrics WHERE workspace_id = ?1")
          .bind(w)
          .all<{ account: string; taken_at: number }>()
      ).results.map((r) => `${r.account}@${r.taken_at}`),
    );
    const snaps = await env.DB.prepare("SELECT data FROM snapshots WHERE workspace_id = ?1 ORDER BY day")
      .bind(w)
      .all<{ data: string }>();
    const missing: [string, string, number, number][] = [];
    for (const { data } of snaps.results) {
      let snap: { taken?: string; accounts?: { platform?: string; account?: string; followers?: number | null }[] };
      try {
        snap = JSON.parse(data);
      } catch {
        continue;
      }
      const at = snap.taken ? takenAt(snap.taken, tz) : null;
      if (at === null) continue;
      for (const a of snap.accounts ?? []) {
        if (typeof a.followers !== "number" || !a.account || known.get(a.account) !== a.platform) continue;
        if (there.has(`${a.account}@${at}`)) continue;
        there.add(`${a.account}@${at}`);
        missing.push([a.account, a.platform as string, at, a.followers]);
      }
    }
    const now = missing.slice(0, ACCOUNT_BACKFILL_PER_RUN - added);
    for (let i = 0; i < now.length; i += 20) {
      const chunk = now.slice(i, i + 20);
      const values = chunk.map(
        (_, j) => `(?${j * 4 + 1}, ?${j * 4 + 2}, ?${j * 4 + 3}, ?${j * 4 + 4}, ?${chunk.length * 4 + 1})`,
      );
      await env.DB.prepare(
        `INSERT INTO account_metrics (account, platform, taken_at, followers, workspace_id) VALUES ${values.join(", ")}`,
      )
        .bind(...chunk.flat(), w)
        .run();
    }
    added += now.length;
    if (now.length < missing.length) continue; // more next run
    await env.DB.prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES (?1, '1', ?2) ON CONFLICT (key) DO UPDATE SET updated_at = excluded.updated_at",
    )
      .bind(BACKFILLED + w, nowS)
      .run();
  }
  return added;
}

/**
 * The inbox run's account sampling: the backfill first (once per workspace), then every active Instagram and
 * YouTube account whose last sample is a day old, oldest first, ACCOUNTS_PER_RUN recorded at most. A failure is
 * stamped and waits METRICS_DENSE_S, so a broken connection doesn't hold up the others; ACCOUNTS_ATTEMPTS_PER_RUN
 * bounds the calls a run makes.
 */
export async function sampleAccounts(
  env: Env,
  deps: { fetch: typeof fetch; now: Date },
): Promise<{ sampled: string[]; backfilled: number }> {
  const nowS = Math.floor(deps.now.getTime() / 1000);
  const backfilled = await backfill(env, nowS);
  await env.DB.prepare("DELETE FROM settings WHERE key LIKE ?1 AND updated_at < ?2")
    .bind(`${FAILED}%`, nowS - METRICS_STOP_S)
    .run();
  // not an archived workspace's: it stops completely (a paused one only stops publishing)
  const accounts = (await listAccounts(env.DB, { working: true })).filter(
    (a) => a.platform === "instagram" || a.platform === "youtube",
  );
  const last = new Map(
    (
      await env.DB.prepare("SELECT account, MAX(taken_at) AS at FROM account_metrics GROUP BY account").all<{
        account: string;
        at: number;
      }>()
    ).results.map((r) => [r.account, r.at]),
  );
  const failed = new Map(
    (
      await env.DB.prepare("SELECT key, updated_at FROM settings WHERE key LIKE ?1")
        .bind(`${FAILED}%`)
        .all<{ key: string; updated_at: number }>()
    ).results.map((r) => [r.key.slice(FAILED.length), r.updated_at]),
  );
  const due = accounts
    .map((a) => {
      const l = last.get(a.id);
      const f = failed.get(a.id);
      return {
        a,
        next: Math.max(l === undefined ? 0 : l + ACCOUNT_METRICS_S, f === undefined ? 0 : f + METRICS_DENSE_S),
      };
    })
    .filter((x) => x.next <= nowS)
    .sort((x, y) => x.next - y.next || x.a.id.localeCompare(y.a.id));
  const sampled: string[] = [];
  let attempts = 0;
  for (const { a } of due) {
    if (sampled.length >= ACCOUNTS_PER_RUN || attempts >= ACCOUNTS_ATTEMPTS_PER_RUN) break;
    attempts++;
    try {
      const followers = await followersOf(env, deps.fetch, a);
      await env.DB.prepare(
        "INSERT INTO account_metrics (account, platform, taken_at, followers, workspace_id) VALUES (?1, ?2, ?3, ?4, ?5)",
      )
        .bind(a.id, a.platform, nowS, followers, a.workspaceId)
        .run();
      if (failed.has(a.id))
        await env.DB.prepare("DELETE FROM settings WHERE key = ?1")
          .bind(FAILED + a.id)
          .run();
      sampled.push(a.id);
    } catch (e) {
      console.log(`accounts ${a.id}: ${(e as Error).message}`);
      await env.DB.prepare(
        "INSERT INTO settings (key, value, updated_at) VALUES (?1, '1', ?2) ON CONFLICT (key) DO UPDATE SET updated_at = excluded.updated_at",
      )
        .bind(FAILED + a.id, nowS)
        .run();
    }
  }
  return { sampled, backfilled };
}
