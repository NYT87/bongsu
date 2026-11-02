// Bundles the command into one file, dist/cli.mjs, so `npx bongsu` needs nothing else installed: the workspace
// packages are TypeScript sources Node can't import as they are.
import { build } from "esbuild";

await build({
  entryPoints: ["src/bin.ts"],
  outfile: "dist/cli.mjs",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  // CommonJS dependencies bundled into ESM still call require()
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  logLevel: "warning",
});
console.log("built dist/cli.mjs");
