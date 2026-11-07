import { describe, expect, it } from "vitest";
import { changedSettings, ytBlocked } from "../src/youtube-form";

const channel = { madeForKids: false, privacy: "public" as const, category: "22" };

describe("changedSettings", () => {
  it("sends only what the form changed", () => {
    const start = { ...channel, category: "10" };
    expect(changedSettings(start, start, channel)).toEqual({});
    expect(changedSettings({ ...start, madeForKids: true }, start, channel)).toEqual({ madeForKids: true });
  });

  it("a value set back to the channel's default is sent as null, so the item follows the channel again", () => {
    const start = { madeForKids: true, privacy: "unlisted" as const, category: "10" };
    expect(changedSettings(channel, start, channel)).toEqual({ madeForKids: null, privacy: null, category: null });
  });
});

describe("ytBlocked", () => {
  const tr = { es: { title: "Hola", description: "" } };

  it("blocks translations without the video's language, as the server's checkTexts does", () => {
    expect(ytBlocked({ title: "Hello", translations: tr })).toBe(true);
    expect(ytBlocked({ title: "Hello", language: " ", translations: tr })).toBe(true);
    expect(ytBlocked({ title: "Hello", language: "en", translations: tr })).toBe(false);
  });

  it("an empty language without translations saves", () => {
    expect(ytBlocked({ title: "Hello" })).toBe(false);
    expect(ytBlocked({ title: "Hello", translations: {} })).toBe(false);
  });
});
