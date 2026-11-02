import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Tests run inside the Workers runtime (Miniflare) with a local D1 that has every migration applied.
export default defineConfig(async () => {
  const migrations = await readD1Migrations("../../migrations/sqlite");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            COMPOSIO_CONSUMER_KEY: "test",
            DRIVE_SA_JSON: "{}",
            MEDIA_SIGNING_KEY: "test",
            YT_MAIN_OAUTH: "{}",
            YT_VLOGS_OAUTH: "{}",
          },
        },
      }),
    ],
    test: { setupFiles: ["./test/apply-migrations.ts"], testTimeout: 60_000, hookTimeout: 60_000 }, // multi-tick tests are slow on this drive, and much slower while ffmpeg renders load the PC
  };
});
