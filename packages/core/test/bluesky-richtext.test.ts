import { describe, expect, it } from "vitest";
import { facetsOf, graphemeCount } from "../src/providers/bluesky-richtext";

describe("bluesky rich text", () => {
  it("counts graphemes, not code units", () => {
    expect(graphemeCount("👨‍👩‍👧".repeat(300))).toBe(300);
    expect(graphemeCount("abc")).toBe(3);
  });

  it("makes a link facet without the trailing punctuation", () => {
    const [f, ...rest] = facetsOf("see https://example.com/a.");
    expect(rest).toEqual([]);
    expect(f.index).toEqual({ byteStart: 4, byteEnd: 25 });
    expect(f.features).toEqual([{ $type: "app.bsky.richtext.facet#link", uri: "https://example.com/a" }]);
  });

  it("counts UTF-8 bytes for a Korean hashtag", () => {
    const fs = facetsOf("여행 #여행");
    expect(fs).toHaveLength(1);
    expect(fs[0].index).toEqual({ byteStart: 7, byteEnd: 14 });
    expect(fs[0].features).toEqual([{ $type: "app.bsky.richtext.facet#tag", tag: "여행" }]);
  });

  it("has no facets in plain text", () => {
    expect(facetsOf("no links")).toEqual([]);
  });

  it("keeps a tag and a link in text order", () => {
    const fs = facetsOf("#trip https://example.com");
    expect(fs.map((f) => f.features[0].$type)).toEqual(["app.bsky.richtext.facet#tag", "app.bsky.richtext.facet#link"]);
  });

  it("does not read a link's fragment as a hashtag", () => {
    const fs = facetsOf("https://example.com/page#top");
    expect(fs).toHaveLength(1);
    expect(fs[0].features[0].$type).toBe("app.bsky.richtext.facet#link");
  });
});
