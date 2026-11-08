// The schedules on Node: one node-cron task every minute that calls core's runDue, as Cloudflare's one trigger does.
// Apart from main.ts so the tests reach the startup check and the task without starting a server.
import type { Env } from "@bongsu/core/env";
import { runDue, schedules, schedulesOff } from "@bongsu/core/schedules";
import cron, { type ScheduledTask } from "node-cron";
import { ConfigError } from "./env";

/** Refuses an invalid CRON_* variable before anything starts: on Node someone is watching the start, while on
 *  Cloudflare the run is skipped and logged each minute. */
export function checkSchedules(env: Env): void {
  const bad = schedules(env).filter((s) => s.error);
  if (bad.length) throw new ConfigError(bad.map((s) => `${s.variable}="${s.expr}": ${s.error}`).join("; "));
}

/** The every-minute task (none with SCHEDULES=off), in UTC like Cloudflare's cron. Each run is added to `running`,
 *  which the shutdown waits on. No `noOverlap`: a long run would make node-cron skip whole minutes, and the runs'
 *  own database locks already keep each from overlapping itself. `due` is runDue, replaced in tests. */
export function startSchedules(
  env: Env,
  fetcher: typeof fetch,
  running: Set<Promise<void>>,
  due: typeof runDue = runDue,
): ScheduledTask[] {
  if (schedulesOff(env)) return [];
  const task = cron.schedule(
    "* * * * *",
    (ctx) => {
      // the minute it was due, as Cloudflare's scheduledTime
      const at = new Date(Math.floor(ctx.date.getTime() / 60_000) * 60_000);
      const run: Promise<void> = due(env, fetcher, at)
        .then(() => undefined)
        .catch((e) => console.log(`schedules failed: ${(e as Error).stack ?? e}`))
        .finally(() => running.delete(run));
      running.add(run);
      return run;
    },
    { timezone: "UTC", name: "bongsu" },
  );
  return [task];
}
