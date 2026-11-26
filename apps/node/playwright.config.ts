// The smoke test (e2e/): the Node build (dist/server.mjs, serving packages/web/dist) on a fresh SQLite database and
// local media folder, driven by Chromium. Build both first: pnpm build && pnpm --filter @bongsu/node build.
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";

const PORT = 8799;
const DATA = join(tmpdir(), "bongsu-e2e");

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  forbidOnly: !!process.env.CI,
  reporter: "list",
  use: { baseURL: `http://localhost:${PORT}`, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: {
    // a new instance every run: the test goes through its first-run setup
    command: `rm -rf "${DATA}" && mkdir -p "${DATA}/media" && node dist/server.mjs`,
    // /health is 503 until the instance is set up; a static file answers as soon as it serves
    url: `http://localhost:${PORT}/manifest.webmanifest`,
    reuseExistingServer: false,
    env: {
      PORT: String(PORT),
      HOST: "127.0.0.1",
      PUBLIC_URL: `http://localhost:${PORT}`,
      DATABASE_PATH: join(DATA, "bongsu.db"),
      MEDIA_DIR: join(DATA, "media"),
      SETUP_TOKEN: "e2e-setup-token",
      SCHEDULES: "off",
    },
  },
});
