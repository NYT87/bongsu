/// <reference types="vitest/config" />
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { brand, htmlFor, manifestFor } from "./brand";
import { iconProblems } from "./icons";

// The app's version: the commit (CI's, else the local checkout's) and the build time. It's compiled into the app
// (__APP_VERSION__) and written to dist/version.json, so an installed PWA can tell it's behind the deployed one.
const commit =
  process.env.CI_COMMIT_SHORT_SHA ??
  (() => {
    try {
      return execSync("git rev-parse --short HEAD").toString().trim();
    } catch {
      return "dev";
    }
  })();
const version = {
  commit,
  built: `${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`,
};
const versionFile: Plugin = {
  name: "version-file",
  apply: "build",
  closeBundle() {
    mkdirSync("dist", { recursive: true });
    writeFileSync("dist/version.json", JSON.stringify(version));
  },
};

// The app's name and theme colour (BONGSU_APP_NAME, BONGSU_THEME_COLOR; site/docs/configuration.md): into index.html, the
// manifest (written to dist/) and the app itself (__APP_BRAND__).
const appBrand = brand(process.env);
const brandFiles: Plugin = {
  name: "brand-files",
  transformIndexHtml: (html) => htmlFor(html, appBrand),
  closeBundle() {
    mkdirSync("dist", { recursive: true });
    writeFileSync("dist/manifest.webmanifest", `${JSON.stringify(manifestFor(appBrand), null, 2)}\n`);
  },
};

// The icons in public/ (a fork's own, from `pnpm brand`): a build with one missing or at the wrong size fails here.
const iconCheck: Plugin = {
  name: "icon-check",
  apply: "build",
  buildStart() {
    const problems = iconProblems((file) => {
      try {
        return readFileSync(`public/${file}`);
      } catch {
        return null;
      }
    });
    if (problems.length)
      this.error(`the app's icons in packages/web/public: ${problems.join("; ")}. Run \`pnpm brand <mark.svg>\`.`);
  },
};

// The owner's app: built to dist/, served by the scheduler Worker as static assets.
// `pnpm dev` proxies the API to the local Worker (`pnpm --filter @bongsu/cloudflare dev`), or to BONGSU_API. Sign in on
// the Worker's own origin first: passkeys check the origin, and the session cookie then works here too (same host).
const api = process.env.BONGSU_API ?? "http://localhost:8787";
export default defineConfig({
  plugins: [react(), versionFile, brandFiles, iconCheck],
  define: { __APP_VERSION__: JSON.stringify(version), __APP_BRAND__: JSON.stringify(appBrand) },
  build: { outDir: "dist", emptyOutDir: true, sourcemap: false },
  server: { proxy: { "/app-api": api, "/m": api } },
  // Vitest blanks CSS imports by default; test/styles.test.ts reads the stylesheet's rules.
  test: { css: { include: [/styles\.css/] } },
});
