import { describe, expect, it } from "vitest";
import { platform, platforms, publishing, registerPlatform, requirePlatform } from "../src/platforms/index";
import { NO_FEATURES, NO_LINT, OptionsError, validateOptions } from "../src/platforms/types";

describe("platforms", () => {
  it("knows Instagram and YouTube by their capabilities", () => {
    expect(platforms().map((p) => p.id)).toEqual(expect.arrayContaining(["instagram", "youtube"]));
    const ig = requirePlatform("instagram");
    expect(ig.formats).toContain("story");
    expect(ig.features).toMatchObject({ firstComment: true, trial: true, coverFrame: true });
    expect(requirePlatform("youtube").features.commentOnExisting).toBe(true);
    expect(publishing().map((p) => p.id)).toContain("instagram");
    expect(publishing().map((p) => p.id)).toContain("youtube");
    expect(platform("myspace")).toBeNull();
    expect(() => requirePlatform("myspace")).toThrow(/unknown platform/);
  });

  it("checks a post's options against the platform and format", () => {
    const ig = requirePlatform("instagram");
    expect(validateOptions(ig, "video", { trial: true, coverMs: 2300, location: "111" })).toEqual({
      trial: true,
      coverMs: 2300,
      location: "111",
    });
    expect(validateOptions(ig, "video", { trial: null })).toEqual({}); // null removes
    expect(() => validateOptions(ig, "image", { trial: true })).toThrow(OptionsError); // Trial Reels are videos
    expect(() => validateOptions(ig, "video", { coverMs: -1 })).toThrow(/between/);
    expect(() => validateOptions(ig, "video", { privacy: "public" })).toThrow(/no option privacy/);
    expect(() => validateOptions(ig, "image", { location: "Seoul" })).toThrow(/isn't valid/);
  });

  it("takes a new network without changes elsewhere", () => {
    registerPlatform({
      id: "fakenet",
      name: "FakeNet",
      formats: ["text", "image"],
      labels: { text: { name: "Note", plural: "Notes" }, post: { name: "Note", plural: "Notes" } },
      accountNoun: "profile",
      limits: { mediaMax: 4, videoSecondsMax: 0, captionMax: 300 },
      features: { ...NO_FEATURES, firstComment: true },
      options: [{ key: "audience", type: "string", label: "Audience", maxLength: 20 }],
      lint: (c) => (c.length > 300 ? [{ check: "LENGTH", status: "FAIL", detail: `${c.length}/300` }] : []),
      lintDefaults: NO_LINT,
    });
    expect(publishing().map((p) => p.id)).toContain("fakenet");
    expect(requirePlatform("fakenet").lint("x".repeat(301))[0].status).toBe("FAIL");
  });
});
