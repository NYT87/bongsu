import { describe, expect, it } from "vitest";
import { captionRules } from "../src/accounts";
import { approvalState, dueFrom, WhenError } from "../src/data";
import { sha256Hex } from "../src/formats/approved";
import { IG_RULES, lintCaption } from "../src/formats/caption-lint";
import {
  isTimeZone,
  parseInstant,
  shiftDate,
  utcIso,
  zoneDate,
  zoneHour,
  zoneHourStart,
  zoneIso,
  zoneStamp,
  zoneToUnix,
} from "../src/formats/time";
import { instagram } from "../src/platforms/instagram";

describe("time in a workspace's zone", () => {
  it("converts wall time to unix seconds (Seoul: UTC+9 all year)", () => {
    expect(zoneToUnix("2026-10-17", "18:00", "Asia/Seoul")).toBe(Date.UTC(2026, 9, 17, 9, 0) / 1000);
    expect(zoneToUnix("2026-10-18", "08:30", "Asia/Seoul")).toBe(Date.UTC(2026, 9, 17, 23, 30) / 1000);
    expect(zoneToUnix("2026-10-17", "18:00", "UTC")).toBe(Date.UTC(2026, 9, 17, 18, 0) / 1000);
  });
  it("follows daylight saving (Madrid: UTC+2 in summer, UTC+1 in winter)", () => {
    expect(zoneToUnix("2026-07-01", "18:00", "Europe/Madrid")).toBe(Date.UTC(2026, 6, 1, 16, 0) / 1000);
    expect(zoneToUnix("2026-12-01", "18:00", "Europe/Madrid")).toBe(Date.UTC(2026, 11, 1, 17, 0) / 1000);
    // 2026-03-29 02:30 doesn't exist in Madrid (clocks jump 02:00 → 03:00): the first valid instant after it
    expect(zoneStamp(zoneToUnix("2026-03-29", "02:30", "Europe/Madrid")!, "Europe/Madrid")).toBe("2026-03-29 03:30");
    expect(zoneIso(Date.UTC(2026, 6, 1, 16, 0) / 1000, "Europe/Madrid")).toBe("2026-07-01T18:00:00+02:00");
    expect(zoneIso(Date.UTC(2026, 6, 1, 16, 0) / 1000, "America/New_York")).toBe("2026-07-01T12:00:00-04:00");
  });
  it("rejects malformed dates and times", () => {
    for (const [d, t] of [
      ["2026-02-30", "10:00"],
      ["2026-10-17", "24:00"],
      ["2026-10-17", "9:00"],
      ["-", "10:00"],
    ]) {
      expect(zoneToUnix(d, t, "Asia/Seoul")).toBeNull();
    }
  });
  it("gives today's date and hour in the zone", () => {
    expect(zoneDate(new Date("2026-10-17T14:59:00Z"), "Asia/Seoul")).toBe("2026-10-17");
    expect(zoneDate(new Date("2026-10-17T15:00:00Z"), "Asia/Seoul")).toBe("2026-10-18");
    expect(zoneDate(new Date("2026-10-17T03:00:00Z"), "America/Los_Angeles")).toBe("2026-10-16");
    expect(zoneHour(new Date("2026-10-17T23:30:00Z"), "Asia/Seoul")).toBe(8);
    expect(shiftDate("2026-12-31", 1)).toBe("2027-01-01");
    expect(isTimeZone("Asia/Seoul")).toBe(true);
    expect(isTimeZone("Mars/Base")).toBe(false);
  });
});

describe("instants in UTC", () => {
  it("reads ISO 8601 only with its zone, and writes UTC", () => {
    expect(parseInstant("2026-11-01T09:00:00Z")).toBe(Date.UTC(2026, 10, 1, 9) / 1000);
    expect(parseInstant("2026-11-01T18:00+09:00")).toBe(Date.UTC(2026, 10, 1, 9) / 1000);
    expect(parseInstant("2026-11-01T18:00:00+0900")).toBe(Date.UTC(2026, 10, 1, 9) / 1000);
    expect(parseInstant("2026-11-01T18:00")).toBeNull(); // whose 18:00?
    expect(parseInstant("tomorrow")).toBeNull();
    expect(utcIso(Date.UTC(2026, 10, 1, 9) / 1000)).toBe("2026-11-01T09:00:00Z");
  });

  it("finds the hour on a zone's clock, half-hour zones included", () => {
    const at = Date.UTC(2026, 10, 1, 9, 45) / 1000;
    expect(zoneHourStart(at, "Asia/Seoul")).toBe(Date.UTC(2026, 10, 1, 9) / 1000);
    expect(zoneHourStart(at, "Asia/Kolkata")).toBe(Date.UTC(2026, 10, 1, 9, 30) / 1000); // 15:15 IST → 15:00 IST
  });

  it("turns what a caller asked for into an instant", () => {
    const tz = "Asia/Seoul";
    const cur = Date.UTC(2026, 10, 1, 9) / 1000; // 18:00 in Seoul
    expect(dueFrom({}, "video", tz, cur)).toBeUndefined();
    expect(dueFrom({ date: null }, "video", tz, cur)).toBeNull();
    expect(dueFrom({ date: "2026-11-02" }, null, tz)).toBe(Date.UTC(2026, 10, 2, 10) / 1000); // posts: 19:00
    expect(dueFrom({ date: "2026-11-02" }, null, tz, cur)).toBe(Date.UTC(2026, 10, 2, 9) / 1000); // keeps 18:00
    expect(dueFrom({ time: "20:00" }, "video", tz, cur)).toBe(Date.UTC(2026, 10, 1, 11) / 1000); // keeps the date
    expect(dueFrom({ at: "2026-11-05T00:00:00Z", date: "2026-11-01" }, "video", tz)).toBe(Date.UTC(2026, 10, 5) / 1000);
    expect(() => dueFrom({ time: "20:00" }, "video", tz)).toThrow(WhenError);
    expect(() => dueFrom({ date: "2026-02-30" }, "video", tz)).toThrow(WhenError);
    expect(() => dueFrom({ at: "2026-11-05 09:00" }, "video", tz)).toThrow(WhenError);
  });
});

describe("approval fingerprints", () => {
  it("hashes text as UTF-8 sha256", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("caption lint (ported from shorts-check caption.py)", () => {
  it("matches the reference lint on synthetic captions and edge cases", async () => {
    const cases = (await import("./fixtures/caption_lint.json")).default as {
      file: string;
      text: string;
      checks: unknown[];
    }[];
    for (const c of cases)
      expect({ file: c.file, checks: lintCaption(c.text) }).toEqual({ file: c.file, checks: c.checks });
  });
});

describe("caption lint rules", () => {
  const eightTags = "A real opening line about Lisbon.\n\n#a #b #c #d #e #f #g #h";
  const status = (checks: { check: string; status: string }[], name: string) =>
    checks.find((c) => c.check === name)?.status;
  it("takes the hashtag cap from the rules", () => {
    expect(status(lintCaption(eightTags), "HASHTAGS")).toBe("FAIL");
    expect(status(lintCaption(eightTags, IG_RULES), "HASHTAGS")).toBe("FAIL");
    expect(status(lintCaption(eightTags, { ...IG_RULES, hashtagMax: 10 }), "HASHTAGS")).toBe("PASS");
  });
  it("takes the fold from the rules", () => {
    const seventy = `${"Seventy characters of first line here, counting to seventy exactly".slice(0, 70)}\n\nmore`;
    expect(status(lintCaption(seventy), "FIRST LINE")).toBe("PASS");
    expect(status(lintCaption(seventy, { ...IG_RULES, foldChars: 60 }), "FIRST LINE")).toBe("WARN");
  });
  it("drops the two language-bound checks when languageChecks is off, and nothing else", () => {
    const on = lintCaption(eightTags).map((c) => c.check);
    const off = lintCaption(eightTags, { ...IG_RULES, languageChecks: false }).map((c) => c.check);
    expect(on).toContain("CONCRETE HOOK");
    expect(on).toContain("ONE ASK");
    expect(off).toEqual(on.filter((c) => c !== "CONCRETE HOOK" && c !== "ONE ASK"));
  });
  it("merges an account's captionRules over the platform's defaults, ignoring bad fields", () => {
    expect(captionRules(instagram, { settings: {} })).toEqual(IG_RULES);
    expect(captionRules(instagram, { settings: { captionRules: { hashtagMax: 10, foldChars: "x" } } })).toEqual({
      hashtagMax: 10,
      foldChars: 125,
      languageChecks: true,
    });
    expect(captionRules(instagram, { settings: { captionRules: { languageChecks: false } } }).languageChecks).toBe(
      false,
    );
  });
});

describe("approvalState", () => {
  const a = (dueAt: number | null) =>
    ({ dueAt, captionSha256: "", commentSha256: null, altSha256: null, media: [] }) as unknown as Parameters<
      typeof approvalState
    >[0];
  it("is approved only for the item's own time; another time needs a new approval", () => {
    expect(approvalState(undefined, 100)).toBe("not approved");
    expect(approvalState(a(null), 100)).toBe("not approved");
    expect(approvalState(a(100), 100)).toBe("approved");
    expect(approvalState(a(100), 3700)).toBe("re-approve");
  });
});
