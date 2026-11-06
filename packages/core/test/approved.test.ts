import { describe, expect, it } from "vitest";
import { canonicalJson, textsSha } from "../src/formats/approved";

describe("texts fingerprint", () => {
  it("canonicalJson sorts keys at every level", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[2,{"y":2,"z":1}]},"b":1}',
    );
  });

  it("textsSha is null without texts and stable under key order", async () => {
    expect(await textsSha(null)).toBeNull();
    expect(await textsSha({ title: "A", tags: ["x"] })).toBe(await textsSha({ tags: ["x"], title: "A" }));
  });
});
