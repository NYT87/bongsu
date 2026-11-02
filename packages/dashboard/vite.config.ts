import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The dashboard: served by the same Worker as the PWA, under /dashboard/ (same host: the same passkeys). It builds into
// the PWA's dist/dashboard/ (the Worker's static files), after the PWA (it depends on @bongsu/web for the tokens).
// `pnpm dev` proxies the API to the local Worker (`pnpm --filter @bongsu/cloudflare dev`), or to BONGSU_API.
const api = process.env.BONGSU_API ?? "http://localhost:8787";
export default defineConfig({
  base: "/dashboard/",
  plugins: [react()],
  build: { outDir: "../web/dist/dashboard", emptyOutDir: true, sourcemap: false },
  server: { proxy: { "/admin-api": api, "/app-api": api } },
});
