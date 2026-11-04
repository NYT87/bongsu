// Starts apps/node's server on the scratch instance: localhost only, DRY_RUN (nothing is ever published), the local
// media store on the scratch media folder. The PWA and the dashboard are the built ones (packages/web/dist).
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { baseEnv, root } from "./seed.mjs";

export const PORT = 8787;
export const ORIGIN = `http://localhost:${PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Rejects when something already listens on the demo's port: /health could then be answered by that other instance
 *  (a dev server, say) and the capture would shoot it instead of the demo. */
export function assertPortFree(port = PORT) {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", () => reject(new Error(`port ${port} in use: stop what listens there and run it again`)));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve()));
  });
}

/** serve({ dbPath, mediaDir }): resolves once /health answers (30 s at most); stop() ends the server. */
export async function serve({ dbPath, mediaDir }) {
  await assertPortFree();
  const web = join(root, "packages/web/dist");
  if (!existsSync(join(root, "apps/node/dist/server.mjs")) || !existsSync(join(web, "index.html")))
    throw new Error("build first: pnpm --filter @bongsu/node build && pnpm --filter @bongsu/web build");
  const child = spawn("node", [join(root, "apps/node/dist/server.mjs")], {
    cwd: join(root, "apps/node"),
    stdio: ["ignore", "inherit", "inherit"],
    env: {
      ...baseEnv(),
      DATABASE_PATH: dbPath,
      MEDIA_DIR: mediaDir,
      MIGRATIONS_DIR: join(root, "migrations"),
      WEB_DIR: web,
      HOST: "127.0.0.1",
      PORT: String(PORT),
      PUBLIC_URL: ORIGIN,
      RP_ID: "localhost",
      DRY_RUN: "1",
      SETUP_TOKEN: "demo-setup-token",
      // /health is only ok when these exist; the demo never calls out, so any value does
      MEDIA_SIGNING_KEY: "demo-media-signing-key",
      COMPOSIO_CONSUMER_KEY: "ck_demo",
      SCHEDULES: "off", // the cron would poll comments of the seeded posted item through Composio
    },
  });
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  const stop = async () => {
    if (exited) return;
    child.kill("SIGTERM");
    await new Promise((r) => child.once("exit", r));
  };
  for (let waited = 0; waited < 30_000; waited += 250) {
    if (exited) throw new Error("the server exited before it was ready (is port 8787 in use?)");
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) return { stop, origin: ORIGIN };
    } catch {
      // not listening yet
    }
    await sleep(250);
  }
  await stop();
  throw new Error("the server did not answer /health within 30 s");
}
