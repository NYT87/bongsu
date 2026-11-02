// Types for the tests: the Worker's own Env, the migrations the config injects, and the main module's exports.
import type { D1Migration } from "cloudflare:test";
import type { Env as WorkerEnv } from "@bongsu/core/env";

declare global {
  namespace Cloudflare {
    interface Env extends Omit<WorkerEnv, "DB"> {
      DB: D1Database;
      TEST_MIGRATIONS: D1Migration[];
    }
    interface GlobalProps {
      mainModule: typeof import("../src/index");
    }
  }
}
