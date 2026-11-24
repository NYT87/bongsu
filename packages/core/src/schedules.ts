// The three named runs, for every runtime: the Cloudflare cron Worker (apps/cloudflare/src/cron.ts) and node-cron
// (apps/node) both call runDue every minute, which starts the runs whose schedule (a CRON_* variable, or its
// default) matches that minute, so the two runtimes can't drift.

import { ACCOUNTS_UNIT_CALLS, sampleAccounts } from "./account-metrics";
import { recordRun, runBudget, runSubrequests, type StepDeps } from "./budget";
import { CLEANUP_UNIT_CALLS, cleanMedia } from "./cleanup";
import { COMMENTS_UNIT_CALLS, pollComments } from "./comments";
import { CRON_INSTAGRAM, CRON_SHORTS, CRON_UPKEEP } from "./constants";
import { type Cron, firings, matcher, matches, nextFiring, parseCron, shortestGap } from "./cron";
import { DIGEST_UNIT_CALLS, dailyDigest } from "./digest";
import type { Env } from "./env";
import { INBOX_UNIT_CALLS, scanInbox } from "./inbox";
import { acquire, release } from "./lock";
import { checkStores, STORES_UNIT_CALLS } from "./media/manage";
import { METRICS_UNIT_CALLS, sampleMetrics } from "./metrics";
import { CONNECTIONS_UNIT_CALLS, refreshConnections } from "./providers/refresh";
import { postResults, RESULTS_UNIT_CALLS } from "./results";
import { tick } from "./tick";

export type RunName = "instagram" | "shorts" | "upkeep";

type Variable = "CRON_INSTAGRAM" | "CRON_SHORTS" | "CRON_UPKEEP";

export interface Schedule {
  name: RunName;
  /** The variable that sets it. */
  variable: Variable;
  expr: string;
  source: "default" | "variable";
  /** The shortest time between two firings (seconds), null when the expression is invalid. */
  gapS: number | null;
  /** Why the expression was refused, else null. */
  error: string | null;
}

const RUNS: { name: RunName; variable: Variable; fallback: string }[] = [
  { name: "instagram", variable: "CRON_INSTAGRAM", fallback: CRON_INSTAGRAM },
  { name: "shorts", variable: "CRON_SHORTS", fallback: CRON_SHORTS },
  { name: "upkeep", variable: "CRON_UPKEEP", fallback: CRON_UPKEEP },
];

const WEEK_S = 7 * 86400;
// A sparse schedule is checked to fire at all from a fixed instant, so the answer doesn't depend on the day: the year
// after 2027-03-01 holds a 29 February, so `0 0 29 2 *` is accepted and `0 0 31 2 *` refused.
const FIRES_FROM = new Date(Date.UTC(2027, 2, 1));

type Parsed = { cron: Cron; gapS: number; error: null } | { cron: null; gapS: null; error: string };
// Parsed once per expression: runDue asks every minute, and a Worker's isolate lives across many of them.
const parsed = new Map<string, Parsed>();

function parse(expr: string): Parsed {
  let p = parsed.get(expr);
  if (!p) {
    try {
      const cron = parseCron(expr);
      const gapS = shortestGap(cron);
      if (gapS >= WEEK_S) nextFiring(cron, FIRES_FROM); // throws if it never fires
      p = { cron, gapS, error: null };
    } catch (e) {
      p = { cron: null, gapS: null, error: (e as Error).message };
    }
    parsed.set(expr, p);
  }
  return p;
}

/** The three runs' schedules, in order: each from its variable when set, else the default; an invalid one carries
 *  its error (Node refuses to start on it, Cloudflare skips that run and logs it). */
export function schedules(env: Pick<Env, Variable>): Schedule[] {
  return RUNS.map(({ name, variable, fallback }) => {
    const set = env[variable]?.trim();
    const expr = set || fallback;
    const { gapS, error } = parse(expr);
    return { name, variable, expr, source: set ? "variable" : "default", gapS, error };
  });
}

/** Whether this instance runs no schedules (Node's SCHEDULES=off); Cloudflare's cron Worker always runs them. */
export const schedulesOff = (env: Pick<Env, "SCHEDULES">) => env.SCHEDULES === "off";

/** Whether upkeep runs in `minute`, given the ticks' (instagram, shorts) schedules. It makes way for them: a tick
 *  needs most of a shared limit and the inbox the rest, so a split starves both, while a minute later costs nothing.
 *  Due when its expression matches the minute and no tick is due in it; or when it matched the minute before, a tick
 *  took that one and none takes this one. When a tick is due both in its minute and the next, it can't move: it runs
 *  in its own minute, sharing it. From the expressions only, so a minute with nothing due still reads nothing. */
export function upkeepDue(upkeep: Cron, ticks: readonly Cron[], minute: Date): boolean {
  const tickAt = (t: Date) => ticks.some((c) => matches(c, t));
  const before = new Date(minute.getTime() - 60_000);
  const after = new Date(minute.getTime() + 60_000);
  if (matches(upkeep, minute)) return !tickAt(minute) || tickAt(after);
  return matches(upkeep, before) && tickAt(before) && !tickAt(minute);
}

/** The ticks upkeep shares a minute with in the week after `from`, by `upkeepDue`'s rule: only at its own firings
 *  where a tick is due in that minute and the next (where it can't move), so a schedule it merely moves a minute for
 *  shares nothing. For the dashboard, whose Worker has 10 ms of CPU too: it walks upkeep's firings only, from the sets,
 *  and stops once every tick is found. */
export function upkeepSharesWith(
  upkeep: Cron,
  ticks: readonly { name: RunName; cron: Cron }[],
  from: Date,
): Set<RunName> {
  const out = new Set<RunName>();
  if (!ticks.length) return out;
  const at = ticks.map((t) => ({ name: t.name, fires: matcher(t.cron) }));
  const start = Math.floor(from.getTime() / 60_000) * 60_000;
  for (const m of firings(upkeep, start, start + 7 * 86_400_000)) {
    if (!at.some((t) => t.fires(m + 60_000))) continue; // the next minute is free: it moves there, alone
    for (const t of at) if (t.fires(m)) out.add(t.name);
    if (out.size === at.length) break;
  }
  return out;
}

/** Starts every run due in the minute `at` falls in, side by side (each guarded by its own lock, so a long tick never
 *  holds up upkeep), and returns their names. A failing run is logged and doesn't stop the others. */
export async function runDue(env: Env, fetcher: typeof fetch, at: Date): Promise<RunName[]> {
  const minute = new Date(Math.floor(at.getTime() / 60_000) * 60_000);
  const all = schedules(env);
  for (const s of all) if (s.error) console.log(`schedule ${s.variable}: ${s.error}`);
  const valid = all.filter((s) => !s.error);
  const ticks = valid.filter((s) => s.name !== "upkeep").map((s) => parse(s.expr).cron as Cron);
  const due = valid.filter((s) => {
    const cron = parse(s.expr).cron as Cron;
    return s.name === "upkeep" ? upkeepDue(cron, ticks, minute) : matches(cron, minute);
  });
  // Most minutes stop here, without touching the database: Workers cap D1 queries per invocation, and this runs
  // 1,440 times a day.
  if (!due.length) return [];
  try {
    await recordSchedules(env, all, minute);
  } catch (e) {
    console.log(`schedules not recorded: ${(e as Error).message}`);
  }
  // Workers count calls per invocation, not per run: runs sharing a minute share one invocation's limit, equally (two
  // ticks, or upkeep when it couldn't move to a free minute).
  const limit = runSubrequests(env).value;
  const share = due.length > 1 && Number.isFinite(limit) ? Math.floor(limit / due.length) : undefined;
  const results = await Promise.allSettled(
    due.map((s) => runSchedule(env, fetcher, s.name, minute, s.gapS as number, share)),
  );
  results.forEach((r, i) => {
    if (r.status === "rejected") console.log(`${due[i].name} failed: ${(r.reason as Error)?.stack ?? r.reason}`);
  });
  return due.map((s) => s.name);
}

/** The schedules in use, for the dashboard, which runs in the other Worker and can't read this one's variables.
 *  Written only when they changed, in the same one statement that compares. */
async function recordSchedules(env: Env, all: Schedule[], at: Date): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES ('schedules', ?1, ?2) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at WHERE settings.value <> excluded.value",
  )
    .bind(JSON.stringify(all), Math.floor(at.getTime() / 1000))
    .run();
}

/** One run by name, for the minute `at`. `gapS` is its schedule's shortest gap between firings: the ticks size their
 *  lock and upload deadline from it. `subrequests` is the run's part of RUN_SUBREQUESTS when it shares the minute
 *  (and so the invocation) with other runs; unset, the whole limit. */
export async function runSchedule(
  env: Env,
  fetcher: typeof fetch,
  name: RunName,
  at: Date,
  gapS: number,
  subrequests?: number,
): Promise<void> {
  if (name === "upkeep") return runUpkeep(env, fetcher, at, UPKEEP_STEPS, subrequests);
  const deps = { fetch: fetcher, now: at, intervalS: gapS, subrequests };
  console.log(`${name}: ${JSON.stringify(await tick(env, deps, name))}`);
}

/** The upkeep steps, in order: the inbox in each workspace's media folder, a few workspaces a run (drafts only:
 *  nothing is published), moving posted media aside, the daily digest, the 24 h results, the metrics, the followers,
 *  new comments, the connections and the media stores. */
export const UPKEEP_STEPS: readonly (readonly [string, (env: Env, deps: StepDeps) => Promise<unknown>])[] = [
  ["inbox", scanInbox],
  ["cleanup", cleanMedia], // posted media → <folder>/_posted/ (move only)
  ["digest", dailyDigest], // once a day, at the workspace's digest hour
  ["results", postResults],
  ["metrics", sampleMetrics],
  ["accounts", sampleAccounts], // each account's followers, once a day
  ["comments", pollComments],
  ["connections", refreshConnections], // Instagram tokens renewed weekly
  ["media stores", checkStores], // each store still answers, weekly
];

/** The most calls one unit of each step's work makes: while a step runs, the steps after it keep one unit each, so
 *  none is starved while the ones before it (the inbox first) can use the rest of the run. A step not named here
 *  (a test's) keeps one call. */
export const UPKEEP_UNIT_CALLS: Readonly<Record<string, number>> = {
  inbox: INBOX_UNIT_CALLS,
  // one move, not a first move's cost (CLEANUP_TARGET_CALLS more, for finding _posted/): kept for every run, that
  // would take the inbox's room; cleanup's own check still counts it, so a store's first move waits for a run with
  // calls to spare and an item is never half moved
  cleanup: CLEANUP_UNIT_CALLS,
  digest: DIGEST_UNIT_CALLS,
  results: RESULTS_UNIT_CALLS,
  metrics: METRICS_UNIT_CALLS,
  accounts: ACCOUNTS_UNIT_CALLS,
  comments: COMMENTS_UNIT_CALLS,
  connections: CONNECTIONS_UNIT_CALLS,
  "media stores": STORES_UNIT_CALLS,
};

/** The upkeep run: runs while paused too (none of it publishes). Its lock is `upkeep`: a leftover `inbox` lock from
 *  before the rename expires on its own. The steps share the run's calls (RUN_SUBREQUESTS) in order, each keeping a
 *  unit of work for every step after it (UPKEEP_UNIT_CALLS), and each runs in its own try: one failing (a Composio
 *  or YouTube hiccup, or a BudgetSpent past its share) doesn't stop the others. `subrequests`: its part of the limit
 *  when it shares the minute with other runs (runDue). */
export async function runUpkeep(
  env: Env,
  fetcher: typeof fetch,
  at: Date,
  steps: typeof UPKEEP_STEPS = UPKEEP_STEPS,
  subrequests?: number,
): Promise<void> {
  const nowS = Math.floor(at.getTime() / 1000),
    holder = crypto.randomUUID();
  if (!(await acquire(env.DB, "upkeep", holder, nowS, 600))) return console.log("upkeep: locked");
  const limit = runSubrequests(env);
  const calls = runBudget(subrequests ?? limit.value, fetcher);
  try {
    for (const [i, [step, run]] of steps.entries()) {
      // made only when the step starts, so its share counts what the steps before it left
      const keep = steps.slice(i + 1).reduce((n, [later]) => n + (UPKEEP_UNIT_CALLS[later] ?? 1), 0);
      const budget = calls.step(step, keep);
      try {
        const out = await run(env, { fetch: budget.fetch, now: at, budget, noteFetch: calls.fetch });
        const stopped = calls.stopped().includes(step) ? " (stopped: out of calls for this run)" : "";
        console.log(`upkeep: ${step} ${typeof out === "string" ? out : JSON.stringify(out)}${stopped}`);
      } catch (e) {
        console.log(`upkeep: ${step} failed: ${(e as Error).message}`);
      }
    }
  } finally {
    try {
      await recordRun(env.DB, "upkeep", nowS, calls, limit.invalid, subrequests !== undefined);
    } finally {
      await release(env.DB, "upkeep", holder);
    }
  }
}
