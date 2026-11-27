// The build's version, compiled into the app and the dashboard (__APP_VERSION__) and written to the app's
// dist/version.json, so an installed PWA can tell it's behind the deployed one. Build-time code: Node only.
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** The commit: BONGSU_COMMIT (a Docker build arg, where there's no .git), CI's, else the local checkout's. */
const commit =
  (process.env.BONGSU_COMMIT || process.env.GITHUB_SHA)?.slice(0, 7) ||
  (() => {
    try {
      return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] })
        .toString()
        .trim();
    } catch {
      return "dev";
    }
  })();

export const version = {
  /** The release (the packages are versioned together: .changeset/config.json `fixed`). */
  version: JSON.parse(readFileSync(new URL("package.json", import.meta.url), "utf8")).version as string,
  commit,
  built: `${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`,
};
