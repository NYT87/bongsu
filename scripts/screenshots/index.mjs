// pnpm screenshots [--keep]: seeds the demo instance in .scratch/, serves it, captures the screenshots (capture.mjs)
// and stops the server. --keep leaves the server running in the foreground for a look (Ctrl-C stops it).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { seedDemo } from "./seed.mjs";
import { assertPortFree, serve } from "./serve.mjs";

const keep = process.argv.includes("--keep");
const scratch = fileURLToPath(new URL("./.scratch/", import.meta.url));
const here = fileURLToPath(new URL("./", import.meta.url));
const root = fileURLToPath(new URL("../../", import.meta.url));
const appOut = `${root}site/docs/assets/app`;
const readmeOut = `${root}docs/assets/readme`;
const IMAGE = "mcr.microsoft.com/playwright:v1.57.0-noble";
const PLAYWRIGHT = "1.57.0";
const MAX_BYTES = 600 * 1024;
const screens = JSON.parse(readFileSync(`${here}screens.json`, "utf8"));
const fileOf = (s) => s.file ?? s.name;

/** Runs capture.mjs in the Playwright image on the host network (so localhost:8787 is the demo server). The tokens
 * travel as environment variables, passed by name so they stay off the command line. */
function capture(demo) {
  mkdirSync(appOut, { recursive: true });
  mkdirSync(readmeOut, { recursive: true });
  const env = {
    ...process.env,
    ORIGIN: "http://localhost:8787",
    PWA_TOKEN: demo.pwaToken,
    DASHBOARD_TOKEN: demo.dashboardToken,
    ITEM_KEY: demo.itemKey,
    APPROVED_KEY: demo.approvedKey,
    POSTED_KEY: demo.postedKey,
    VIDEO_ID: demo.videoId,
    VIDEO_DATE: demo.videoDate,
  };
  const names = [
    "ORIGIN",
    "PWA_TOKEN",
    "DASHBOARD_TOKEN",
    "ITEM_KEY",
    "APPROVED_KEY",
    "POSTED_KEY",
    "VIDEO_ID",
    "VIDEO_DATE",
  ];
  const run = [
    "docker run --rm --network host",
    `-v "${here}":/work:ro -v "${appOut}":/out/app -v "${readmeOut}":/out/readme`,
    '--user "$(id -u):$(id -g)"',
    ...names.map((n) => `-e ${n}`),
    "-e PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 -e npm_config_cache=/tmp/npm",
    // the image has the browsers but not the playwright package: install it (same version) beside a copy of the script
    `${IMAGE} sh -c "mkdir /tmp/run && cd /tmp/run && npm init -y >/dev/null && npm i --silent playwright@${PLAYWRIGHT} && cp /work/capture.mjs /work/screens.json . && node capture.mjs"`,
  ].join(" ");
  // the shell's session may lack the docker group: sg docker runs it with the group
  const useSg = spawnSync("docker", ["info"], { stdio: "ignore" }).status !== 0;
  const r = useSg
    ? spawnSync("sg", ["docker", "-c", run], { env, stdio: "inherit" })
    : spawnSync("sh", ["-c", run], { env, stdio: "inherit" });
  if (r.status !== 0) throw new Error(`capture failed (exit ${r.status})`);
  squash();
  verify();
}

/** pngquant, when installed, shrinks the PNGs in place. */
function squash() {
  if (spawnSync("which", ["pngquant"], { stdio: "ignore" }).status !== 0) return;
  for (const dir of [appOut, readmeOut])
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".png")))
      spawnSync("pngquant", ["--force", "--ext", ".png", "--skip-if-larger", join(dir, f)], { stdio: "ignore" });
}

/** Every screen produced both themes, none over the size cap; names whatever is missing. */
function verify() {
  const problems = [];
  const check = (dir, s, theme) => {
    const file = join(dir, `${fileOf(s)}-${theme}.png`);
    try {
      const size = statSync(file).size;
      if (size > MAX_BYTES) problems.push(`${file}: ${Math.round(size / 1024)} KB, over 600 KB`);
    } catch {
      problems.push(`${s.app}/${s.name}: ${theme} is missing (${file})`);
    }
  };
  for (const s of screens)
    for (const theme of ["light", "dark"]) {
      check(appOut, s, theme);
      if (s.readme) check(readmeOut, s, theme);
    }
  if (problems.length) throw new Error(`screenshots incomplete:\n  ${problems.join("\n  ")}`);
}

mkdirSync(scratch, { recursive: true });
await assertPortFree(); // before the seed and the builds: fail fast
if (!existsSync(join(root, "packages/web/dist/index.html"))) {
  const r = spawnSync("pnpm", ["--filter", "@bongsu/web", "build"], { cwd: root, stdio: "inherit" });
  if (r.status !== 0) throw new Error("building packages/web failed");
}
const demo = await seedDemo(scratch);
const server = await serve(demo);
// never leave the server behind, whichever way this ends
for (const sig of ["SIGINT", "SIGTERM"])
  process.once(sig, async () => {
    await server.stop();
    process.exit(0);
  });
let failed = false;
try {
  capture(demo);
} catch (e) {
  failed = true;
  console.error(e);
}

if (keep && !failed) {
  console.log(`\nDemo instance: ${server.origin}/  (dashboard: ${server.origin}/dashboard/)`);
  console.log(`PWA cookie:       bongsu_session=${demo.pwaToken}`);
  console.log(`Dashboard cookie: bongsu_admin=${demo.dashboardToken}`);
  console.log(
    `item: ${demo.itemKey}   approved: ${demo.approvedKey}   posted: ${demo.postedKey}   video: ${demo.videoId} (${demo.videoDate})`,
  );
  console.log("Serving in the foreground: press Ctrl-C to stop.");
} else {
  await server.stop();
  if (failed) process.exit(1);
}
