import { describe, expect, it } from "vitest";
import { axisNumber, dayStart, dayTicks, labelAnchor, nearest, runs, valueAt, valueTicks } from "../src/Chart";

const at = (iso: string) => Date.parse(iso) / 1000;

describe("the chart's helpers", () => {
  it("finds the start of a day on the workspace's clock, across a change of offset", () => {
    expect(dayStart(at("2026-10-30T20:00:00Z"), "Asia/Seoul")).toBe(at("2026-10-30T15:00:00Z"));
    expect(dayStart(at("2026-10-30T10:00:00Z"), "UTC")).toBe(at("2026-10-30T00:00:00Z"));
    // Lisbon leaves summer time on 2026-10-25 at 02:00 local: that day starts at 00:00 WEST, 23:00 UTC the day before
    expect(dayStart(at("2026-10-25T12:00:00Z"), "Europe/Lisbon")).toBe(at("2026-10-24T23:00:00Z"));
    expect(dayStart(at("2026-10-26T12:00:00Z"), "Europe/Lisbon")).toBe(at("2026-10-26T00:00:00Z"));
  });

  it("puts x ticks on day boundaries, at most six", () => {
    const week = dayTicks(at("2026-10-20T06:00:00Z"), at("2026-10-23T06:00:00Z"), "UTC");
    expect(week).toEqual(["21", "22", "23"].map((d) => at(`2026-10-${d}T00:00:00Z`)));
    const month = dayTicks(at("2026-10-01T00:00:00Z"), at("2026-10-30T00:00:00Z"), "UTC");
    expect(month.length).toBeLessThanOrEqual(6);
    expect(month[0]).toBe(at("2026-10-01T00:00:00Z"));
  });

  it("picks three or four round y ticks from zero, whole numbers for counts", () => {
    expect(valueTicks(0, 1234)).toEqual([0, 500, 1000, 1500]);
    expect(valueTicks(0, 9)).toEqual([0, 5, 10]);
    expect(valueTicks(0, 0)).toEqual([0, 1]);
    expect(valueTicks(-40, 100)).toEqual([-50, 0, 50, 100]);
  });

  it("writes axis numbers grouped below 10,000 and compact above", () => {
    expect(axisNumber(1234)).toBe("1,234");
    expect(axisNumber(12000)).toBe("12K");
  });

  it("breaks the line at a null: a gap, not a zero", () => {
    const points = [
      { at: 1, value: 5 },
      { at: 2, value: null },
      { at: 3, value: 7 },
      { at: 4, value: 9 },
    ];
    expect(runs(points)).toEqual([
      [{ at: 1, value: 5 }],
      [
        { at: 3, value: 7 },
        { at: 4, value: 9 },
      ],
    ]);
  });
});

describe("the chart's pick and labels", () => {
  it("finds the nearest time, the earlier one on a tie", () => {
    const times = [10, 20, 40];
    expect(nearest(times, 0)).toBe(0);
    expect(nearest(times, 15)).toBe(0);
    expect(nearest(times, 16)).toBe(1);
    expect(nearest(times, 31)).toBe(2);
    expect(nearest(times, 99)).toBe(2);
    expect(nearest([5], 1)).toBe(0);
  });

  it("keeps an x label inside the chart at either edge", () => {
    expect(labelAnchor(10, 300)).toBe("start");
    expect(labelAnchor(150, 300)).toBe("middle");
    expect(labelAnchor(290, 300)).toBe("end");
  });
});

describe("a series' value at the chosen time", () => {
  const points = [
    { at: 100, value: 10 },
    { at: 200, value: null },
    { at: 300, value: 30 },
  ];

  it("total: the last known count at or before the time", () => {
    expect(valueAt(points, 100, "total", "UTC")).toBe(10);
    expect(valueAt(points, 150, "total", "UTC")).toBe(10); // sampled in another run: its latest count still holds
    expect(valueAt(points, 250, "total", "UTC")).toBe(10); // a missing sample doesn't hide the count before it
    expect(valueAt(points, 999, "total", "UTC")).toBe(30);
    expect(valueAt(points, 50, "total", "UTC")).toBeNull(); // nothing yet
    expect(valueAt([], 100, "total", "UTC")).toBeNull();
  });

  // a daily point carries the instant of its day's last sample, so two series' points differ within the same day
  const seoul = "Asia/Seoul"; // UTC+9: its midnight is 15:00 UTC
  const at = (iso: string) => Date.parse(iso) / 1000;
  const reel = [
    { at: at("2026-10-29T09:00:00Z"), value: 500 },
    { at: at("2026-10-30T11:00:00Z"), value: 300 },
  ];
  const trial = [
    { at: at("2026-10-29T13:00:00Z"), value: 90 },
    { at: at("2026-10-30T14:30:00Z"), value: null },
  ];

  it("daily: each series reads its own point of the same day, at either series' instant", () => {
    for (const t of [reel[0].at, trial[0].at]) {
      expect(valueAt(reel, t, "daily", seoul)).toBe(500);
      expect(valueAt(trial, t, "daily", seoul)).toBe(90);
    }
    expect(valueAt(reel, trial[1].at, "daily", seoul)).toBe(300);
    expect(valueAt(trial, reel[1].at, "daily", seoul)).toBeNull(); // that day has no value
  });

  it("daily: instants on either side of the zone's midnight are different days", () => {
    const before = [{ at: at("2026-10-29T14:59:00Z"), value: 7 }]; // 23:59 in Seoul
    expect(valueAt(before, at("2026-10-29T15:01:00Z"), "daily", seoul)).toBeNull(); // 00:01 the next day
    expect(valueAt(before, at("2026-10-29T15:01:00Z"), "daily", "UTC")).toBe(7); // the same UTC day
  });
});
