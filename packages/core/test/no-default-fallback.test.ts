// No workspace and no user is chosen for anyone (docs/superpowers/specs/2026-11-04-phase13-people-roles-design.md,
// section 0): a fresh instance has no `default` workspace and no `owner` user, so code acting for a caller, an item
// or an account uses theirs. DEFAULT_WORKSPACE stays only as the exported constant (existing instances' data and the
// tests read it); "owner" as a user id appears nowhere. ('owner@app', the app's label on an edit, isn't a user id.)
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "../..");
const DIRS = ["core/src", "api/src"];
/** "owner" as a user id: a fallback (`?? "owner"`), a default (`userId = "owner"`), a field or a comparison. */
const OWNER_USER =
  /\?\?\s*["']owner["']|\b(?:userId|user_id|id)\s*(?:=|===|!==|:)\s*["']owner["']|\buser_id\s*=\s*'owner'/g;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
  });
}

const count = (re: RegExp) => {
  const found: Record<string, number> = {};
  for (const d of DIRS)
    for (const f of files(join(ROOT, d))) {
      const n = readFileSync(f, "utf8").match(re)?.length ?? 0;
      if (n) found[relative(ROOT, f)] = n;
    }
  return found;
};

describe("no silent fallback to the default workspace", () => {
  it("uses DEFAULT_WORKSPACE only where it's exported", () => {
    expect(count(/\bDEFAULT_WORKSPACE\b/g)).toEqual({ "core/src/accounts.ts": 1 });
  });

  it("never acts as the user owner", () => {
    expect(count(OWNER_USER)).toEqual({});
  });
});
