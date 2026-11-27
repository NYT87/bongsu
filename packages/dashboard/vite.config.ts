/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { version } from "../web/version";

// The dashboard: served by the same Worker as the PWA, under /dashboard/ (same host: the same passkeys). It builds into
// the PWA's dist/dashboard/ (the Worker's static files), after the PWA (it depends on @bongsu/web for the tokens).
// `pnpm dev` proxies the API to the local Worker (`pnpm --filter @bongsu/cloudflare dev`), or to BONGSU_API.
const api = process.env.BONGSU_API ?? "http://localhost:8787";
export default defineConfig({
  base: "/dashboard/",
  plugins: [react()],
  // the version the Settings page shows beside the server's (web/version.ts)
  define: { __APP_VERSION__: JSON.stringify(version) },
  build: { outDir: "../web/dist/dashboard", emptyOutDir: true, sourcemap: false },
  server: { proxy: { "/admin-api": api, "/app-api": api } },
  // Component tests render the pages against a faked fetch (test/fake-api.ts), in a DOM.
  test: { environment: "happy-dom" },
});
