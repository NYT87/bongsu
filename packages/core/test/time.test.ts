import { describe, expect, it } from "vitest";
import { nextPacificMidnight } from "../src/formats/time";

const s = (iso: string) => Date.parse(iso) / 1000;

describe("nextPacificMidnight", () => {
  it("is the next midnight in Los Angeles, across the change back to standard time (2026-11-01)", () => {
    // 05:00 PDT on Oct 31: midnight starting Nov 1 is still daylight time (UTC−7)
    expect(nextPacificMidnight(s("2026-10-31T12:00:00Z"))).toBe(s("2026-11-01T07:00:00Z"));
    // 02:00 PST on Nov 1, after the change: the next midnight is in standard time (UTC−8)
    expect(nextPacificMidnight(s("2026-11-01T10:00:00Z"))).toBe(s("2026-11-02T08:00:00Z"));
    // at midnight itself: the next one, a 25-hour day later
    expect(nextPacificMidnight(s("2026-11-01T07:00:00Z"))).toBe(s("2026-11-02T08:00:00Z"));
    // a second before it: that midnight
    expect(nextPacificMidnight(s("2026-11-01T06:59:59Z"))).toBe(s("2026-11-01T07:00:00Z"));
  });
});
