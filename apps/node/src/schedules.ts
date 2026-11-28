// The schedules on Node: one timer firing at the start of every minute that calls core's runDue, as Cloudflare's one
// trigger does. Apart from main.ts so the tests reach the startup check and the timer without starting a server.
import type { Env } from "@bongsu/core/env";
import { runDue, schedules, schedulesOff } from "@bongsu/core/schedules";
import { ConfigError } from "./env";

/** Refuses an invalid CRON_* variable before anything starts: on Node someone is watching the start, while on
 *  Cloudflare the run is skipped and logged each minute. */
export function checkSchedules(env: Env): void {
  const bad = schedules(env).filter((s) => s.error);
  if (bad.length) throw new ConfigError(bad.map((s) => `${s.variable}="${s.expr}": ${s.error}`).join("; "));
}

/** Frees the locks of runs left unfinished (a crash, a kill -9) at start, and this process's own at shutdown. Only the
 *  process that runs the schedules does: a SCHEDULES=off replica on the same database would free the main process's
 *  locks while they're held, and let its runs overlap. */
export async function clearLocks(env: Env): Promise<void> {
  if (!schedulesOff(env)) await env.DB.prepare("DELETE FROM locks").run();
}

const MINUTE = 60_000;

/** The every-minute timer (none with SCHEDULES=off), in UTC minutes like Cloudflare's cron; returns its stop. Each run
 *  is added to `running`, which the shutdown waits on. A run never delays the next minute's: the runs' own database
 *  locks keep each from overlapping itself. A minute the process missed (asleep, blocked) is skipped, not caught up.
 *  `due` is runDue, replaced in tests. */
export function startSchedules(
  env: Env,
  fetcher: typeof fetch,
  running: Set<Promise<void>>,
  due: typeof runDue = runDue,
): (() => void) | null {
  if (schedulesOff(env)) return null;
  let timer: ReturnType<typeof setTimeout>;
  let last = 0;
  const next = () => {
    // the next minute's start, never the same one twice (a timer may fire a moment early)
    const at = Math.max(last + MINUTE, (Math.floor(Date.now() / MINUTE) + 1) * MINUTE);
    timer = setTimeout(() => {
      last = at;
      next();
      // the minute it was due, as Cloudflare's scheduledTime
      const run: Promise<void> = due(env, fetcher, new Date(at))
        .then(() => undefined)
        .catch((e) => console.log(`schedules failed: ${(e as Error).stack ?? e}`))
        .finally(() => running.delete(run));
      running.add(run);
    }, at - Date.now());
  };
  next();
  return () => clearTimeout(timer);
}
