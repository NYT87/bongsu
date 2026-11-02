// The `bongsu` Worker: the HTTP app (packages/api) on Cloudflare. The cron runs in the separate `bongsu-cron` Worker
// (src/cron.ts), so this bundle's size doesn't count against the cron's CPU.
import { createApp } from "@bongsu/api/app";
import type { Env } from "@bongsu/core/env";

// The global fetch must be called unbound: clients call `this.fetcher(…)`, and the runtime throws "Illegal
// invocation" when fetch runs with a client as `this`. So clients always get this wrapper, never `fetch` itself.
export const realFetch: typeof fetch = (input, init) => fetch(input, init);

export const app = createApp(realFetch);

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<Env>;
