import { describe, expect, it } from "vitest";
import {
  dailyGrowth,
  isDue,
  nearest24h,
  nextSampleAt,
  type Sample,
  sampleInterval,
  sampleOf,
  series,
} from "../src/metrics";

const H = 3600;
const D = 86400;

function sample(at: number, views: number | null, rest: Partial<Sample> = {}): Sample {
  return {
    at,
    views,
    reach: null,
    likes: null,
    comments: null,
    saves: null,
    shares: null,
    follows: null,
    profile_visits: null,
    ...rest,
  };
}

describe("sampleInterval", () => {
  it("is 6 h until 3 days, daily until 30 days, weekly until 90 days, then never", () => {
    expect(sampleInterval(0)).toBe(6 * H);
    expect(sampleInterval(3 * D - 1)).toBe(6 * H);
    expect(sampleInterval(3 * D)).toBe(D);
    expect(sampleInterval(30 * D - 1)).toBe(D);
    expect(sampleInterval(30 * D)).toBe(7 * D);
    expect(sampleInterval(90 * D - 1)).toBe(7 * D);
    expect(sampleInterval(90 * D)).toBeNull();
  });
});

describe("nextSampleAt and isDue", () => {
  const p = 1_000_000;

  it("is due at once when there is no sample", () => {
    expect(nextSampleAt(p, null, p + 10)).toBe(p);
    expect(isDue(p, null, p + 10)).toBe(true);
  });

  it("waits the full 6 h in the dense band", () => {
    expect(isDue(p, p + 5 * H, p + 5 * H + H - 1)).toBe(false);
    expect(isDue(p, p + 5 * H, p + 6 * H + 5 * H)).toBe(true);
    expect(isDue(p, p, p + 6 * H - 1)).toBe(false);
    expect(isDue(p, p, p + 6 * H)).toBe(true);
  });

  it("uses the interval of the age now: daily from 3 days", () => {
    const last = p + 3 * D - 7 * H;
    expect(isDue(p, last, p + 3 * D + H)).toBe(false);
    expect(isDue(p, last, p + 3 * D - 7 * H + D - 1)).toBe(false);
    expect(isDue(p, last, p + 3 * D - 7 * H + D)).toBe(true);
  });

  it("never again after 90 days", () => {
    expect(nextSampleAt(p, p, p + 90 * D)).toBeNull();
    expect(nextSampleAt(p, null, p + 90 * D)).toBeNull();
    expect(isDue(p, null, p + 90 * D)).toBe(false);
    expect(isDue(p, null, p + 90 * D - 1)).toBe(true);
  });
});

describe("series", () => {
  const tz = "Asia/Seoul";
  // 2026-01-01 12:00 in Seoul (03:00 UTC)
  const day1 = Date.UTC(2026, 0, 1, 3) / 1000;
  const rows = [sample(day1, 10), sample(day1 + D, 30), sample(day1 + 3 * D, 70)];

  it("a sampled day's growth since the previous sampled day; days without a sample are gaps", () => {
    // days 1, 2 and 4: day 3 is null, day 4 is what came since day 2
    const out = series(rows, { daily: true, tz });
    expect(out.map((r) => r.views)).toEqual([20, null, 40]);
    expect(out[0]?.at).toBe(day1 + D);
    expect(out[2]?.at).toBe(day1 + 3 * D);
    expect(out[1]?.at).toBe(Date.UTC(2026, 0, 2, 15) / 1000); // start of the day on the zone's clock
  });

  it("in the weekly band: one point a week, gaps between", () => {
    const weekly = [sample(day1, 100), sample(day1 + 7 * D, 170), sample(day1 + 14 * D, 200)];
    const out = series(weekly, { daily: true, tz });
    expect(out).toHaveLength(14);
    expect(out.map((r) => r.views)).toEqual([...Array(6).fill(null), 70, ...Array(6).fill(null), 30]);
    expect(out[6]?.at).toBe(day1 + 7 * D);
  });

  it("keeps the last sample of each day, on the zone's clock", () => {
    const morning = Date.UTC(2026, 0, 1, 0) / 1000; // 09:00 Seoul, day 1
    const lateUtcPrev = Date.UTC(2026, 0, 1, 16) / 1000; // 01:00 Seoul on day 2
    const out = series(
      [sample(morning, 5), sample(day1, 10), sample(lateUtcPrev, 12), sample(lateUtcPrev + 10 * H, 40)],
      { daily: true, tz },
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.views).toBe(30);
  });

  it("is null for a metric missing on either day", () => {
    const out = series([sample(day1, null, { likes: 1 }), sample(day1 + D, 5, { likes: 4 })], { daily: true, tz });
    expect(out[0]).toMatchObject({ views: null, likes: 3 });
  });

  it("returns nothing for fewer than two sampled days", () => {
    expect(series([sample(day1, 1), sample(day1 + H, 2)], { daily: true, tz })).toEqual([]);
    expect(series([], { daily: true, tz })).toEqual([]);
  });

  it("total mode returns the samples sorted by time, unchanged", () => {
    const shuffled = [rows[2], rows[0], rows[1]] as Sample[];
    expect(series(shuffled, { daily: false, tz })).toEqual(rows);
  });
});

describe("nearest24h", () => {
  const p = 5_000_000;

  it("picks the sample closest to 24 h", () => {
    const a = sample(p + 23 * H, 1);
    const b = sample(p + 30 * H, 2);
    expect(nearest24h([b, a], p)).toBe(a);
  });

  it("falls back to the latest when none is within 6 h", () => {
    const a = sample(p + 2 * H, 1);
    const b = sample(p + 40 * H, 2);
    expect(nearest24h([a, b], p)).toBe(b);
  });

  it("accepts exactly 6 h away and returns null for no samples", () => {
    const a = sample(p + 18 * H, 1);
    const b = sample(p + 48 * H, 2);
    expect(nearest24h([a, b], p)).toBe(a);
    expect(nearest24h([], p)).toBeNull();
  });

  it("strict: only a sample within 6 h of 24 h, else null", () => {
    const early = sample(p + H, 1);
    const late = sample(p + 31 * H, 2);
    expect(nearest24h([early, late], p, { strict: true })).toBeNull();
    const inWindow = sample(p + 25 * H, 3);
    expect(nearest24h([early, inWindow, late], p, { strict: true })).toBe(inWindow);
    expect(nearest24h([], p, { strict: true })).toBeNull();
  });
});

describe("follows and profile visits", () => {
  it("sampleOf keeps them like the other counts", () => {
    const s = sampleOf({ views: 1, follows: 12, profile_visits: 85 }, 10);
    expect(s.follows).toBe(12);
    expect(s.profile_visits).toBe(85);
    expect(sampleOf({ views: 1 }, 10).follows).toBeNull();
  });

  it("daily mode shows the followers a day brought, null when a sample lacks them", () => {
    const day1 = Date.UTC(2026, 0, 1, 3) / 1000;
    const rows = [
      sample(day1, 10, { follows: 10 }),
      sample(day1 + D, 30, { follows: 15 }),
      sample(day1 + 2 * D, 50, { follows: null }),
    ];
    const out = series(rows, { daily: true, tz: "Asia/Seoul" });
    expect(out.map((r) => r.follows)).toEqual([5, null]);
  });
});

describe("dailyGrowth", () => {
  const tz = "Asia/Seoul";
  const day1 = Date.UTC(2026, 0, 1, 3) / 1000; // 12:00 in Seoul

  it("each sampled day's growth since the previous sampled day; a day without a sample is a gap", () => {
    const out = dailyGrowth(
      [
        { at: day1, value: 100 },
        { at: day1 + D, value: 103 },
        { at: day1 + 3 * D, value: 110 },
      ],
      tz,
    );
    expect(out.map((p) => p.value)).toEqual([3, null, 7]);
  });

  it("keeps the last sample of a day on the zone's clock", () => {
    // 23:30 and 00:30 in Seoul are two days though the same UTC day
    const late = Date.UTC(2026, 0, 1, 14, 30) / 1000;
    const out = dailyGrowth(
      [
        { at: day1, value: 100 },
        { at: late, value: 101 },
        { at: late + H, value: 105 },
      ],
      tz,
    );
    expect(out.map((p) => p.value)).toEqual([4]);
  });

  it("a null value counts as no sample", () => {
    const out = dailyGrowth(
      [
        { at: day1, value: 100 },
        { at: day1 + D, value: null },
      ],
      tz,
    );
    expect(out.map((p) => p.value)).toEqual([null]);
  });
});
