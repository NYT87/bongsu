// The generated files are current: CI fails when the schema changed and `generate` wasn't run.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generatedFiles } from "../src/generated";

describe("generated files", () => {
  for (const [path, content] of Object.entries(generatedFiles()))
    it(`${path} is current (pnpm --filter @bongsu/schema generate)`, () => {
      let committed = "";
      try {
        committed = readFileSync(join(__dirname, "../../..", path), "utf8");
      } catch {}
      expect(committed === content, `${path} is stale or missing`).toBe(true);
    });
});
