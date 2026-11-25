import { describe, expect, it } from "vitest";
import { platform, publishing } from "../src/platforms/index";

const bluesky = () => {
  const p = platform("bluesky");
  if (!p) throw new Error("bluesky is not registered");
  return p;
};

describe("bluesky platform", () => {
  it("is registered and publishes", () => {
    expect(publishing().map((p) => p.id)).toContain("bluesky");
    expect(bluesky().limits.imageBytesMax).toBe(1_000_000);
  });

  it("passes 300 characters and fails 301", () => {
    expect(
      bluesky()
        .lint("a".repeat(300))
        .some((c) => c.status === "FAIL"),
    ).toBe(false);
    const fail = bluesky()
      .lint("a".repeat(301))
      .find((c) => c.status === "FAIL");
    expect(fail?.detail).toBe("301/300");
  });

  it("counts a family emoji as one character", () => {
    expect(
      bluesky()
        .lint("👨‍👩‍👧".repeat(300))
        .some((c) => c.status === "FAIL"),
    ).toBe(false);
  });
});
