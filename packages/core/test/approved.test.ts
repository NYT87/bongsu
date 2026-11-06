import { describe, expect, it } from "vitest";
import { canonicalJson, youtubeSha } from "../src/formats/approved";

describe("texts fingerprint", () => {
  it("canonicalJson drops undefined keys, like JSON.stringify", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it("canonicalJson sorts keys at every level", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[2,{"y":2,"z":1}]},"b":1}',
    );
  });

  it("youtubeSha is null without texts and roles, and stable under key and role order", async () => {
    expect(await youtubeSha(null, null)).toBeNull();
    expect(await youtubeSha({ title: "A", tags: ["x"] }, ["video:1", "thumbnail:2"])).toBe(
      await youtubeSha({ tags: ["x"], title: "A" }, ["thumbnail:2", "video:1"]),
    );
  });

  it("youtubeSha changes with a file's role", async () => {
    expect(await youtubeSha({ title: "A" }, ["subtitle:es:7"])).not.toBe(
      await youtubeSha({ title: "A" }, ["subtitle:fr:7"]),
    );
  });
});
