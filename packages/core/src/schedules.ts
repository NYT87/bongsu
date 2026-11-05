// The three scheduled runs, for every runtime: the Cloudflare cron Worker (apps/cloudflare/src/cron.ts) and node-cron
// (apps/node) both call runSchedule with the expression that fired and when, so the two can't drift.

import { sampleAccounts } from "./account-metrics";
import { cleanMedia } from "./cleanup";
import { pollComments } from "./comments";
import { CRON_INBOX, CRON_INSTAGRAM, CRON_SHORTS } from "./constants";
import { dailyDigest } from "./digest";
import type { Env } from "./env";
import { scanInbox } from "./inbox";
import { acquire, release } from "./lock";
import { checkStores } from "./media/manage";
import { sampleMetrics } from "./metrics";
import { refreshConnections } from "./providers/refresh";
import { postResults } from "./results";
import { tick } from "./tick";

/** Every schedule, by its cron expression (UTC). */
export const SCHEDULES = [CRON_INSTAGRAM, CRON_SHORTS, CRON_INBOX] as const;

/** Whether this instance runs no schedules (Node's SCHEDULES=off); Cloudflare's cron Worker always runs them. */
export const schedulesOff = (env: Pick<Env, "SCHEDULES">) => env.SCHEDULES === "off";

export async function runSchedule(env: Env, fetcher: typeof fetch, cron: string, at: Date): Promise<void> {
  const deps = { fetch: fetcher, now: at };
  if (cron === CRON_INBOX) {
    // The inbox in each workspace's media folder, a few workspaces a run (drafts only: nothing is published), moving posted media aside, the daily digest, the 24 h
    // results and new comments; runs while paused too (none of it publishes).
    const nowS = Math.floor(at.getTime() / 1000),
      holder = crypto.randomUUID();
    if (!(await acquire(env.DB, "inbox", holder, nowS, 600))) return console.log("inbox: locked");
    try {
      console.log(`inbox: ${JSON.stringify(await scanInbox(env, deps))}`);
      console.log(`cleanup: ${JSON.stringify(await cleanMedia(env, deps))}`); // posted media → <folder>/_posted/ (move only)
      console.log(`digest: ${await dailyDigest(env, deps)}`); // once a day, at the workspace's digest hour
      // Each in its own try: one failing (a Composio or YouTube hiccup) doesn't stop the others.
      for (const [name, run] of [
        ["results", postResults],
        ["metrics", sampleMetrics],
        ["accounts", sampleAccounts], // each account's followers, once a day
        ["comments", pollComments],
        ["connections", refreshConnections], // Instagram tokens renewed weekly
        ["media stores", checkStores], // each store still answers, weekly
      ] as const) {
        try {
          console.log(`${name}: ${JSON.stringify(await run(env, deps))}`);
        } catch (e) {
          console.log(`${name} failed: ${(e as Error).message}`);
        }
      }
    } finally {
      await release(env.DB, "inbox", holder);
    }
    return;
  }
  const r = await tick(env, deps, cron === CRON_SHORTS ? "shorts" : "instagram");
  console.log(`tick: ${JSON.stringify(r)}`);
}
