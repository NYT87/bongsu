// Writes the generated files (generated.ts) into the repository: `pnpm --filter @bongsu/schema generate`.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { generatedFiles } from "./generated";

const root = process.argv[2] ?? join(process.cwd(), "../..");
for (const [path, content] of Object.entries(generatedFiles())) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
  console.log(`wrote ${path}`);
}
