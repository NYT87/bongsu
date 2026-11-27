import { defineConfig } from "vitest/config";

// The Postgres tests boot PGlite and apply every migration, a step longer with each one: past vitest's 5 s on a busy
// CI runner. 30 s, as the CLI and Node packages give theirs.
export default defineConfig({ test: { environment: "node", testTimeout: 30_000 } });
