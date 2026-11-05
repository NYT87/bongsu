import { describe, expect, it } from "vitest";
import { checkName, NAME_MAX, NameError } from "../src/workspaces";

// memberName and memberNames run SQL: apps/cloudflare/test/names.test.ts checks them on D1.
describe("checkName", () => {
  it("trims, and an empty name is none", () => {
    expect(checkName("  Jo  ")).toBe("Jo");
    expect(checkName("   ")).toBeNull();
    expect(checkName("")).toBeNull();
  });
  it("takes 60 characters and refuses 61", () => {
    expect(NAME_MAX).toBe(60);
    expect(checkName("a".repeat(60))).toBe("a".repeat(60));
    expect(() => checkName("a".repeat(61))).toThrow(NameError);
    expect(() => checkName("a".repeat(61))).toThrow("a name is 1 to 60 characters");
  });
  it("refuses what isn't text", () => {
    expect(() => checkName(7)).toThrow("a name is 1 to 60 characters");
    expect(() => checkName({})).toThrow(NameError);
  });
});
