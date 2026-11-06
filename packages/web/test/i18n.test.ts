import { afterEach, describe, expect, it } from "vitest";
import appSource from "../src/App.tsx?raw";
import chartSource from "../src/Chart.tsx?raw";
import { dateLocale, en, type Key, setLocale, t } from "../src/i18n";

afterEach(() => setLocale("en"));

describe("t", () => {
  it("reads the English catalogue", () => {
    expect(t("tabs.today")).toBe("Today");
    expect(t("status.scheduled")).toBe("Goes public");
  });

  it("answers the key itself for an unknown key", () => {
    expect(t("x.unknown" as Key)).toBe("x.unknown");
  });

  it("interpolates {name}", () => {
    expect(t("settings.unblockAndroid", { name: "Lighthouse" })).toContain("Apps → Lighthouse (or");
    expect(t("header.brandToday", { name: "Lighthouse" })).toBe("Lighthouse: Today");
  });

  it("picks one or other of a plural by n", () => {
    expect(t("count.items", { n: 1 })).toBe("1 item");
    expect(t("count.items", { n: 3 })).toBe("3 items");
  });
});

describe("setLocale", () => {
  it("falls back to en for a locale without a catalogue", () => {
    expect(setLocale("xx")).toBe("en");
    expect(dateLocale()).toBe("en");
    if (typeof document !== "undefined") expect(document.documentElement.lang).toBe("en");
  });

  it("keeps a known locale", () => {
    expect(setLocale("en")).toBe("en");
  });
});

// Every string of the app goes through t() (#37): what is left in the sources is code, example values and names.

describe("the app's text", () => {
  it("has no JSX text of plain English words left in App.tsx", () => {
    const left = [...appSource.matchAll(/>\s*([A-Z][a-z]+(?:\s+[a-z]+)+[.:…]?)\s*</g)].map((m) => m[1]);
    expect(left).toEqual([]);
  });

  it("uses only keys the English catalogue has", () => {
    const used = [...`${appSource}\n${chartSource}`.matchAll(/\bt\("([a-zA-Z0-9_.]+)"/g)].map((m) => m[1]);
    expect(used.length).toBeGreaterThan(300);
    expect(used.filter((k) => !(k in en))).toEqual([]);
  });
});

describe("a YouTube upload's progress", () => {
  it("reads as the spec words it", () => {
    expect(t("upload.uploading", { percent: 40 })).toBe("Uploading, 40%");
    expect(t("upload.extras")).toBe("Adding subtitles");
    expect(t("upload.processing")).toBe("YouTube is processing");
    expect(t("upload.ready", { time: "18:00" })).toBe("Ready: goes public at 18:00");
    expect(t("upload.locked")).toBe("Private: needs YouTube's audit");
  });
});
