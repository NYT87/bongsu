// A run's call budget: Workers count every fetch of an invocation (50 on the free plan), so a run counts its own and
// shares the limit among its steps. A step may spend its fair share of what is left, then stops (BudgetSpent) instead
// of starving the steps after it; what it leaves unspent goes back to the shares of the later steps.

import { RUN_SUBREQUESTS, RUN_SUBREQUESTS_MAX, RUN_SUBREQUESTS_MIN, SUBREQUESTS_KEPT } from "./constants";
import type { Db } from "./db";
import type { Env } from "./env";

export class BudgetSpent extends Error {
  constructor(step: string) {
    super(`call budget spent for ${step}`);
    this.name = "BudgetSpent";
  }
}

/** The run's limit from the RUN_SUBREQUESTS variable: a number in range or "unlimited" (Infinity). Anything else
 *  falls back to the default, with the bad value in `invalid` so the caller can say so. */
export function runSubrequests(env: Pick<Env, "RUN_SUBREQUESTS">): {
  value: number;
  source: "default" | "variable";
  invalid: string | null;
} {
  const raw = env.RUN_SUBREQUESTS?.trim();
  if (!raw) return { value: RUN_SUBREQUESTS, source: "default", invalid: null };
  if (raw.toLowerCase() === "unlimited") return { value: Number.POSITIVE_INFINITY, source: "variable", invalid: null };
  const n = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (n >= RUN_SUBREQUESTS_MIN && n <= RUN_SUBREQUESTS_MAX) return { value: n, source: "variable", invalid: null };
  return { value: RUN_SUBREQUESTS, source: "default", invalid: raw };
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
}

/** Whether the step can spend `n` more calls on its next unit of work (no budget: always). */
export const canAfford = (deps: Pick<StepDeps, "budget">, n: number): boolean => deps.budget?.canAfford(n) ?? true;

export interface RunCalls {
  fetch: typeof fetch;
  used(): number;
  /** The run's total left, the reserve included. */
  left(): number;
  limit: number;
  step(name: string, stepsLeft: number): StepBudget;
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
    step(name, stepsLeft) {
      // the reserve stays out of the shares, for what the run does after its steps
      const share = Number.isFinite(limit)
        ? Math.max(0, Math.floor((limit - SUBREQUESTS_KEPT - total) / Math.max(1, stepsLeft)))
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
