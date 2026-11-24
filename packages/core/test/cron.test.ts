import { describe, expect, it } from "vitest";
import { CronError, firings, matcher, matches, nextFiring, parseCron, shortestGap } from "../src/cron";
import { upkeepDue, upkeepSharesWith } from "../src/schedules";

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

  it("reads lists out of order and crosses days and years", () => {
    expect(nextFiring(parseCron("32,2 * * * *"), at("2026-11-09T23:40:00Z")).toISOString()).toBe(
      "2026-11-10T00:02:00.000Z",
    );
    expect(nextFiring(parseCron("0 9 1 1 *"), at("2026-01-01T09:00:00Z")).toISOString()).toBe(
      "2027-01-01T09:00:00.000Z",
    );
    expect(nextFiring(parseCron("0 9 1 * 1"), at("2026-11-30T09:00:00Z")).toISOString()).toBe(
      "2026-12-01T09:00:00.000Z",
    );
  });

  it("throws when nothing matches within a year", () => {
    expect(() => nextFiring(parseCron("0 0 31 2 *"), at("2026-01-01T00:00:00Z"))).toThrow(CronError);
  });
});

describe("cost", () => {
  // A Worker on the free plan is stopped past 10 ms of CPU per invocation; the scheduler computes these on a cold
  // start. Fresh `expr` keys bypass the gap cache; the bound is generous so a slow CI machine does not flake, and
  // still far below the ~54 ms the minute-by-minute walk took.
  it("computes the defaults' gaps and next firings in well under the CPU limit, at best of three", () => {
    const fresh = (expr: string, n: number) => ({ ...parseCron(expr), expr: `${expr} #${n}` });
    let fastest = Number.POSITIVE_INFINITY;
    for (let n = 0; n < 3; n++) {
      const t0 = performance.now();
      for (const expr of ["*/5 * * * *", "2,32 * * * *", "7,22,37,52 * * * *", "0 9 1 1 *"]) {
        const cron = fresh(expr, n);
        shortestGap(cron);
        nextFiring(cron, at("2026-01-02T00:00:00Z"));
      }
      fastest = Math.min(fastest, performance.now() - t0);
    }
    expect(fastest).toBeLessThan(10);
  });
});

describe("firings and matcher", () => {
  it("agree with matches, minute by minute, across a month's end", () => {
    const from = Date.UTC(2026, 10, 29, 22, 0);
    const to = from + 3 * 86_400_000;
    for (const expr of ["*/15 * * * *", "2,32 * * * *", "0 3 1 * *", "* 23 * * 1", "59 23 30 11 *"]) {
      const cron = parseCron(expr);
      const fires = matcher(cron);
      const walked: number[] = [];
      for (let t = from + 60_000; t <= to; t += 60_000) {
        expect(fires(t), `${expr} at ${new Date(t).toISOString()}`).toBe(matches(cron, new Date(t)));
        if (matches(cron, new Date(t))) walked.push(t);
      }
      expect([...firings(cron, from, to)], expr).toEqual(walked);
    }
  });
});

describe("upkeepSharesWith", () => {
  const ticks = (instagram: string, shorts = "2,32 * * * *") => [
    { name: "instagram" as const, cron: parseCron(instagram) },
    { name: "shorts" as const, cron: parseCron(shorts) },
  ];
  const FROM = at("2026-11-09T00:00:30Z");

  it("names the ticks of the minutes where upkeepDue has it run beside one, as a minute-by-minute walk does", () => {
    const pairs: [string, string, string][] = [
      ["*/15 * * * *", "*/5 * * * *", "2,32 * * * *"],
      ["7,22,37,52 * * * *", "* * * * *", "2,32 * * * *"],
      ["*/2 * * * *", "*/3 * * * *", "*/4 * * * *"],
      ["0 3 * * *", "0,1 3 * * 1", "2,32 * * * *"],
    ];
    for (const [u, ig, sh] of pairs) {
      const t = ticks(ig, sh);
      const walked = new Set<string>();
      const start = Math.floor(FROM.getTime() / 60_000) * 60_000;
      for (let m = 1; m <= 7 * 1440; m++) {
        const d = new Date(start + m * 60_000);
        if (
          !upkeepDue(
            parseCron(u),
            t.map((x) => x.cron),
            d,
          )
        )
          continue;
        for (const x of t) if (matches(x.cron, d)) walked.add(x.name);
      }
      expect([...upkeepSharesWith(parseCron(u), t, FROM)].sort(), `${u} / ${ig} / ${sh}`).toEqual([...walked].sort());
    }
  });

  it("finds nothing when upkeep can always move, and the ticks it can't move from", () => {
    expect([...upkeepSharesWith(parseCron("*/15 * * * *"), ticks("*/5 * * * *"), FROM)]).toEqual([]);
    expect([...upkeepSharesWith(parseCron("7,22,37,52 * * * *"), ticks("* * * * *"), FROM)]).toEqual(["instagram"]);
  });

  // The dashboard's Worker has 10 ms of CPU on the free plan and computes this on every Scheduler page load.
  it("stays well under the CPU limit (best of three runs)", () => {
    let fastest = Number.POSITIVE_INFINITY;
    for (let n = 0; n < 3; n++) {
      const t0 = performance.now();
      upkeepSharesWith(parseCron("*/15 * * * *"), ticks("*/5 * * * *"), FROM);
      upkeepSharesWith(parseCron("* * * * *"), ticks("* * * * *"), FROM);
      upkeepSharesWith(parseCron("7,22,37,52 * * * *"), ticks("* * * * *"), FROM);
      fastest = Math.min(fastest, performance.now() - t0);
    }
    expect(fastest).toBeLessThan(10);
  });
});
