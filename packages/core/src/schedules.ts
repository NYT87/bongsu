// The three named runs, for every runtime: the Cloudflare cron Worker (apps/cloudflare/src/cron.ts) and node-cron
// (apps/node) both call runDue every minute, which starts the runs whose schedule (a CRON_* variable, or its
// default) matches that minute, so the two runtimes can't drift.

import { ACCOUNTS_UNIT_CALLS, sampleAccounts } from "./account-metrics";
import { recordRun, runBudget, runSubrequests, type StepDeps } from "./budget";
import { CLEANUP_UNIT_CALLS, cleanMedia } from "./cleanup";
import { COMMENTS_UNIT_CALLS, pollComments } from "./comments";
import { CRON_INSTAGRAM, CRON_SHORTS, CRON_UPKEEP } from "./constants";
import { type Cron, matches, nextFiring, parseCron, shortestGap } from "./cron";
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

/** Starts every run due in the minute `at` falls in, side by side (each guarded by its own lock, so a long tick never
 *  holds up upkeep), and returns their names. A failing run is logged and doesn't stop the others. */
export async function runDue(env: Env, fetcher: typeof fetch, at: Date): Promise<RunName[]> {
  const minute = new Date(Math.floor(at.getTime() / 60_000) * 60_000);
  const all = schedules(env);
  const due: Schedule[] = [];
  for (const s of all) {
    if (s.error) console.log(`schedule ${s.variable}: ${s.error}`);
    else if (matches(parse(s.expr).cron as Cron, minute)) due.push(s);
  }
  // Most minutes stop here, without touching the database: Workers cap D1 queries per invocation, and this runs
  // 1,440 times a day.
  if (!due.length) return [];
  try {
    await recordSchedules(env, all, minute);
  } catch (e) {
    console.log(`schedules not recorded: ${(e as Error).message}`);
  }
  const results = await Promise.allSettled(due.map((s) => runSchedule(env, fetcher, s.name, minute, s.gapS as number)));
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
 *  lock and upload deadline from it. */
export async function runSchedule(
  env: Env,
  fetcher: typeof fetch,
  name: RunName,
  at: Date,
  gapS: number,
): Promise<void> {
  if (name === "upkeep") return runUpkeep(env, fetcher, at);
  console.log(`${name}: ${JSON.stringify(await tick(env, { fetch: fetcher, now: at, intervalS: gapS }, name))}`);
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
 *  unit of work for every step after it (UPKEEP_UNIT_CALLS), and each runs in its own try: one failing (a Composio or YouTube hiccup, or a BudgetSpent past its share) doesn't stop the
 *  others. */
export async function runUpkeep(
  env: Env,
  fetcher: typeof fetch,
  at: Date,
  steps: typeof UPKEEP_STEPS = UPKEEP_STEPS,
): Promise<void> {
  const nowS = Math.floor(at.getTime() / 1000),
    holder = crypto.randomUUID();
  if (!(await acquire(env.DB, "upkeep", holder, nowS, 600))) return console.log("upkeep: locked");
  const limit = runSubrequests(env);
  const calls = runBudget(limit.value, fetcher);
  try {
    for (const [i, [step, run]] of steps.entries()) {
      // made only when the step starts, so its share counts what the steps before it left
      const keep = steps.slice(i + 1).reduce((n, [later]) => n + (UPKEEP_UNIT_CALLS[later] ?? 1), 0);
      const budget = calls.step(step, keep);
      try {
        const out = await run(env, { fetch: budget.fetch, now: at, budget });
        const stopped = calls.stopped().includes(step) ? " (stopped: out of calls for this run)" : "";
        console.log(`upkeep: ${step} ${typeof out === "string" ? out : JSON.stringify(out)}${stopped}`);
      } catch (e) {
        console.log(`upkeep: ${step} failed: ${(e as Error).message}`);
      }
    }
  } finally {
    try {
      await recordRun(env.DB, "upkeep", nowS, calls, limit.invalid);
    } finally {
      await release(env.DB, "upkeep", holder);
    }
  }
}
