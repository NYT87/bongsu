// A run's call budget: Workers count every fetch of an invocation (50 on the free plan), so a run counts its own and
// shares the limit among its steps, in order: a step may spend what is left less the reserve and what the steps after
// it keep (a unit of work each), then stops (BudgetSpent) instead of starving them; what it leaves unspent goes to the
// steps after it.

import { RUN_SUBREQUESTS, RUN_SUBREQUESTS_MAX, RUN_SUBREQUESTS_MIN, SUBREQUESTS_KEPT } from "./constants";
import type { Db } from "./db";
import type { Env } from "./env";

export class BudgetSpent extends Error {
  constructor(step: string) {
    super(`call budget spent for ${step}`);
    this.name = "BudgetSpent";
  }
}

// A limit as written: a whole number in range or "unlimited" (Infinity); anything else null.
function parseLimit(raw: string | undefined): number | null {
  if (raw?.toLowerCase() === "unlimited") return Number.POSITIVE_INFINITY;
  const n = raw && /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  return n >= RUN_SUBREQUESTS_MIN && n <= RUN_SUBREQUESTS_MAX ? n : null;
}

/** The run's limit from the RUN_SUBREQUESTS variable: a number in range or "unlimited" (Infinity). Unset or anything
 *  else gives the runtime's default (RUN_SUBREQUESTS_DEFAULT: Node's "unlimited"; else Cloudflare's free-plan
 *  RUN_SUBREQUESTS), with a bad value in `invalid` so the caller can say so. */
export function runSubrequests(env: Pick<Env, "RUN_SUBREQUESTS" | "RUN_SUBREQUESTS_DEFAULT">): {
  value: number;
  source: "default" | "variable";
  invalid: string | null;
} {
  const fallback = parseLimit(env.RUN_SUBREQUESTS_DEFAULT?.trim()) ?? RUN_SUBREQUESTS;
  const raw = env.RUN_SUBREQUESTS?.trim();
  if (!raw) return { value: fallback, source: "default", invalid: null };
  const n = parseLimit(raw);
  if (n !== null) return { value: n, source: "variable", invalid: null };
  return { value: fallback, source: "default", invalid: raw };
}

export interface StepBudget {
  name: string;
  fetch: typeof fetch;
  left(): number;
  canAfford(n: number): boolean;
  used(): number;
}

/** What an upkeep step is given: the step's own fetch and its budget. A direct caller (a route, a test) passes no
 *  budget: no limit but the step's own caps. */
export interface StepDeps {
  fetch: typeof fetch;
  now: Date;
  budget?: StepBudget;
  /** The run's own fetch, for the notifications (and mail) a step sends about its work: paid from the run's reserve
   *  (SUBREQUESTS_KEPT), not the step's share, so a step that spent its share still tells the owner what it did. */
  noteFetch?: typeof fetch;
}

/** The fetch a step's notifier uses: the run's (its reserve) when it has one, else the step's. */
export const noteFetch = (deps: Pick<StepDeps, "fetch" | "noteFetch">): typeof fetch => deps.noteFetch ?? deps.fetch;

/** Whether the step can spend `n` more calls on its next unit of work (no budget: always). */
export const canAfford = (deps: Pick<StepDeps, "budget">, n: number): boolean => deps.budget?.canAfford(n) ?? true;

export interface RunCalls {
  fetch: typeof fetch;
  used(): number;
  /** The run's total left, the reserve included. */
  left(): number;
  limit: number;
  /** A step's budget, made when it starts: `keepForLater` calls stay for the steps after it. */
  step(name: string, keepForLater: number): StepBudget;
  /** The steps that hit their share, in the order they did. */
  stopped(): string[];
}

export function runBudget(limit: number, fetcher: typeof fetch): RunCalls {
  let total = 0;
  const stopped: string[] = [];
  const stop = (name: string) => {
    if (!stopped.includes(name)) stopped.push(name);
  };
  const runLeft = () => Math.max(0, limit - total);

  const run: RunCalls = {
    limit,
    // outside any step: counted, and stopped only by the run's limit
    fetch: ((input, init) => {
      if (runLeft() < 1) return Promise.reject(new BudgetSpent("the run"));
      total++;
      return fetcher(input, init);
    }) as typeof fetch,
    used: () => total,
    left: runLeft,
    stopped: () => [...stopped],
    step(name, keepForLater) {
      // the reserve stays out of the shares, for what the run does after its steps
      const share = Number.isFinite(limit)
        ? Math.max(0, limit - total - SUBREQUESTS_KEPT - keepForLater)
        : Number.POSITIVE_INFINITY;
      let used = 0;
      // a step never goes past the run's limit either, whatever the run's own calls spent meanwhile
      const left = () => Math.min(share - used, runLeft());
      return {
        name,
        used: () => used,
        left,
        canAfford(n) {
          if (n <= left()) return true;
          stop(name);
          return false;
        },
        fetch: ((input, init) => {
          if (left() < 1) {
            stop(name);
            return Promise.reject(new BudgetSpent(name));
          }
          used++;
          total++;
          return fetcher(input, init);
        }) as typeof fetch,
      };
    },
  };
  return run;
}

/** What a run spent of its calls (`run_last:<name>`), for the dashboard: the variable lives on the cron side, not the
 *  API's, so a RUN_SUBREQUESTS it refused (`invalid`) is told there too. An unlimited run's limit is the word: JSON has
 *  no Infinity. */
export async function recordRun(db: Db, name: string, nowS: number, calls: RunCalls, invalid: string | null) {
  const limit = Number.isFinite(calls.limit) ? calls.limit : "unlimited";
  const value = { at: nowS, used: calls.used(), limit, stopped: calls.stopped(), invalid };
  await db
    .prepare("INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = ?2")
    .bind(`run_last:${name}`, JSON.stringify(value))
    .run();
}
