import { describe, expect, it } from "vitest";
import { approvedSettings, canonicalJson, settingsApproved, youtubeSha } from "../src/formats/approved";

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
    expect(await youtubeSha(null, null, null)).toBeNull();
    expect(await youtubeSha({ title: "A", tags: ["x"] }, ["video:1", "thumbnail:2"], null)).toBe(
      await youtubeSha({ tags: ["x"], title: "A" }, ["thumbnail:2", "video:1"], null),
    );
  });

  it("youtubeSha changes with a file's role", async () => {
    expect(await youtubeSha({ title: "A" }, ["subtitle:es:7"], null)).not.toBe(
      await youtubeSha({ title: "A" }, ["subtitle:fr:7"], null),
    );
  });

  it("youtubeSha covers made for kids and privacy, not the category", async () => {
    const at = (madeForKids: boolean, privacy: "public" | "unlisted", category = "22") =>
      youtubeSha({ title: "A" }, ["video:1"], approvedSettings({ madeForKids, privacy, category }));
    expect(await at(false, "public")).toBe(await at(false, "public", "10"));
    expect(await at(false, "public")).not.toBe(await at(false, "unlisted"));
    expect(await at(false, "public")).not.toBe(await at(true, "public"));
    expect(await at(false, "public")).not.toBe(await youtubeSha({ title: "A" }, ["video:1"], null));
  });

  it("settingsApproved finds the settings an approval covered when only they changed", async () => {
    const sha = await youtubeSha({ title: "A" }, ["video:1"], { madeForKids: true, privacy: "unlisted" });
    expect(await settingsApproved({ title: "A" }, ["video:1"], sha)).toEqual({
      madeForKids: true,
      privacy: "unlisted",
    });
    expect(await settingsApproved({ title: "B" }, ["video:1"], sha)).toBeNull();
  });
});
