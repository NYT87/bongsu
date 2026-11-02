import { afterEach, describe, expect, it } from "vitest";
import { dateLocale, type Key, setLocale, t } from "../src/i18n";

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
