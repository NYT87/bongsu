// The SQL in core and api stays in the subset SQLite and Postgres share (docs/PLAN.md, section 2.9): no SQLite-only
// functions. What differs between databases lives in core/src/sql.ts (per-dialect helpers); anything new fails.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "../..");
const DIRS = ["core/src", "api/src"];
const SQLITE_ONLY = /unixepoch\(|json_each\(|INSERT OR [A-Z]+|strftime\(|datetime\(|julianday\(|sqlite_master/g;

// file → how many SQLite-only uses it may still have (each to be replaced in Phase 5b)
const ALLOWED: Record<string, number> = {
  "core/src/sql.ts": 2, // the per-dialect helpers: json_each, sqlite_master
};

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
  });
}

// A parameter whose only use is `?n IS NULL` has no type Postgres can infer: write `CAST(?n AS TEXT) IS NULL`.
const UNTYPED_NULL = /[(\s]\?\d+ IS (NOT )?NULL/g;

describe("portable SQL", () => {
  it("casts a parameter tested with IS NULL (Postgres can't infer its type)", () => {
    const found: string[] = [];
    for (const d of DIRS)
      for (const f of files(join(ROOT, d)))
        if (UNTYPED_NULL.test(readFileSync(f, "utf8"))) found.push(relative(ROOT, f));
    expect(found).toEqual([]);
  });

  it("adds no SQLite-only functions to core and api", () => {
    const found: Record<string, number> = {};
    for (const d of DIRS)
      for (const f of files(join(ROOT, d))) {
        const n = readFileSync(f, "utf8").match(SQLITE_ONLY)?.length ?? 0;
        if (n) found[relative(ROOT, f)] = n;
      }
    expect(found).toEqual(ALLOWED);
  });
});
