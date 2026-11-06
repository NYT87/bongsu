import { describe, expect, it } from "vitest";
import { changedSettings } from "../src/youtube-form";

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
