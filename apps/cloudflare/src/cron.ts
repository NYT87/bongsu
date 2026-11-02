// The cron Worker (`bongsu-cron`, wrangler.cron.toml): only the scheduled runs (core/schedules.ts), so each run starts
// a small bundle and stays inside the free plan's 10 ms CPU. The app, the agent API and the media links live in
// `bongsu` (src/index.ts), which keeps its hostname (the owner's passkeys and the MCP registration are tied to it).
import type { Env } from "@bongsu/core/env";
import { runSchedule } from "@bongsu/core/schedules";

// The global fetch must be called unbound (see index.ts): clients call `this.fetcher(…)`.
export const realFetch: typeof fetch = (input, init) => fetch(input, init);

export default {
  async fetch(): Promise<Response> {
    return new Response(JSON.stringify({ ok: true, worker: "bongsu-cron", note: "cron only; the app is bongsu" }), {
      headers: { "Content-Type": "application/json" },
    });
  },
  async scheduled(event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    await runSchedule(env, realFetch, event.cron, new Date(event.scheduledTime));
  },
} satisfies ExportedHandler<Env>;
