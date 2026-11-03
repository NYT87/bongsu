// The generated files are current: CI fails when the schema changed and `generate` wasn't run.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generatedFiles, schemaDoc } from "../src/generated";

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

describe("schema doc", () => {
  it("escapes a backslash before a pipe in a note, so the table keeps its columns", () => {
    const doc = schemaDoc({
      demo: { description: "A demo table.", columns: { id: { type: "id", primaryKey: true, description: "a\\|b" } } },
    } as unknown as Parameters<typeof schemaDoc>[0]);
    expect(doc).toContain("primary key; a\\\\\\|b |");
  });
});
