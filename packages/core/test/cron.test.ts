import { describe, expect, it } from "vitest";
import { CronError, matches, nextFiring, parseCron, shortestGap } from "../src/cron";

const at = (iso: string) => new Date(iso);

describe("cron matches", () => {
  it("matches the default expressions", () => {
    expect(matches(parseCron("*/5 * * * *"), at("2026-11-09T10:05:00Z"))).toBe(true);
    expect(matches(parseCron("*/5 * * * *"), at("2026-11-09T10:06:00Z"))).toBe(false);
    expect(matches(parseCron("2,32 * * * *"), at("2026-11-09T10:32:00Z"))).toBe(true);
    expect(matches(parseCron("7,22,37,52 * * * *"), at("2026-11-09T10:52:00Z"))).toBe(true);
  });

  it("handles ranges and steps", () => {
    const c = parseCron("0-10/5 9-17 * * 1-5");
    expect(matches(c, at("2026-11-09T09:10:00Z"))).toBe(true); // Monday
    expect(matches(c, at("2026-11-14T09:10:00Z"))).toBe(false); // Saturday
    expect(matches(c, at("2026-11-09T18:00:00Z"))).toBe(false);
  });

  it("matches day of month or day of week when both are restricted", () => {
    const c = parseCron("0 9 1 * 1");
    expect(matches(c, at("2026-12-01T09:00:00Z"))).toBe(true); // Tuesday the 1st
    expect(matches(c, at("2026-12-07T09:00:00Z"))).toBe(true); // Monday
    expect(matches(c, at("2026-12-02T09:00:00Z"))).toBe(false);
  });

  it("reads 7 as Sunday", () => {
    expect(matches(parseCron("0 0 * * 7"), at("2026-11-08T00:00:00Z"))).toBe(true);
  });
});

describe("cron parsing", () => {
  it.each([
    ["* * * *", /5 fields/],
    ["60 * * * *", /minute/],
    ["*/0 * * * *", /minute/],
    ["0 0 * * MON", /day of week/],
    ["@hourly", /5 fields/],
    ["0 0 0 * * *", /5 fields/],
  ])("refuses %s", (expr, message) => {
    expect(() => parseCron(expr)).toThrow(CronError);
    expect(() => parseCron(expr)).toThrow(message);
  });
});

describe("shortestGap", () => {
  it.each([
    ["*/5 * * * *", 300],
    ["2,32 * * * *", 1800],
    ["7,22,37,52 * * * *", 900],
    ["* * * * *", 60],
    ["0 9 * * 1", 604800],
    ["0 9 1 * *", 604800],
    ["0 9 * 12 *", 604800],
  ])("%s is %i seconds", (expr, gap) => {
    expect(shortestGap(parseCron(expr))).toBe(gap);
  });
});

describe("nextFiring", () => {
  it("finds the first matching minute strictly after", () => {
    expect(nextFiring(parseCron("*/5 * * * *"), at("2026-11-09T10:05:30Z")).toISOString()).toBe(
      "2026-11-09T10:10:00.000Z",
    );
  });

  it("throws when nothing matches within a year", () => {
    expect(() => nextFiring(parseCron("0 0 31 2 *"), at("2026-01-01T00:00:00Z"))).toThrow(CronError);
  });
});
