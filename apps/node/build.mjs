// Bundles the server into dist/server.mjs: core and api are TypeScript sources (their exports point at .ts files),
// so Node can't import them as they are. Only the native SQLite driver stays outside the bundle.
import { build } from "esbuild";

await build({
  entryPoints: ["src/main.ts"],
  outfile: "dist/server.mjs",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  external: ["better-sqlite3"],
  // CommonJS dependencies bundled into ESM still call require()
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  logLevel: "warning",
});
console.log("built dist/server.mjs");
