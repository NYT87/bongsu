import { describe, expect, it } from "vitest";
import { checkTexts, parseTexts, tagsLength } from "../src/formats/youtube-texts";
import { instagram } from "../src/platforms/instagram";
import { youtube } from "../src/platforms/youtube";

const refused = (raw: unknown, msg: string | RegExp) => expect(() => checkTexts(youtube, raw)).toThrow(msg);

describe("youtube texts", () => {
  it("null stays null", () => {
    expect(checkTexts(youtube, null)).toBeNull();
    expect(checkTexts(youtube, undefined)).toBeNull();
  });
  it("Instagram refuses texts", () => {
    expect(() => checkTexts(instagram, { title: "a" })).toThrow("Instagram posts have no title or translations");
  });
  it("a title over 100 characters is refused", () => {
    refused({ title: "x".repeat(101) }, /title/);
    expect(checkTexts(youtube, { title: "x".repeat(100) })).toEqual({ title: "x".repeat(100) });
  });
  it("an empty title is kept as empty", () => {
    expect(checkTexts(youtube, { title: " " })).toEqual({ title: "" });
  });
  it("a bad language tag is refused", () => {
    refused({ title: "a", language: "EN" }, /language/);
    refused({ title: "a", audioLanguage: "e" }, /audioLanguage/);
    expect(checkTexts(youtube, { title: "a", language: "pt-BR", audioLanguage: "en" })).toEqual({
      title: "a",
      language: "pt-BR",
      audioLanguage: "en",
    });
  });
  it("a translation needs a title of 1–100 and a description of at most 5000", () => {
    refused({ title: "a", translations: { es: { title: "", description: "" } } }, /translations\.es\.title/);
    refused(
      { title: "a", translations: { es: { title: "x".repeat(101), description: "" } } },
      /translations\.es\.title/,
    );
    refused(
      { title: "a", translations: { es: { title: "b", description: "x".repeat(5001) } } },
      /translations\.es\.description/,
    );
    refused({ title: "a", translations: { E: { title: "b", description: "" } } }, /translations\.E/);
    expect(
      checkTexts(youtube, {
        title: "a",
        language: "en",
        translations: { es: { title: " b ", description: " c\r\nd " } },
      }),
    ).toEqual({
      title: "a",
      language: "en",
      translations: { es: { title: "b", description: "c\nd" } },
    });
  });
  it("translations need the video's own language (YouTube refuses them without it)", () => {
    const texts = { title: "a", translations: { es: { title: "b", description: "" } } };
    expect(() => checkTexts(youtube, texts)).toThrow(
      "language: YouTube needs the video's own language with translations",
    );
    // a draft from the inbox has none yet: it is set before the draft is scheduled
    expect(checkTexts(youtube, texts, { languageLater: true })).toEqual(texts);
    expect(checkTexts(youtube, { ...texts, language: "en" })).toEqual({ ...texts, language: "en" });
  });
  it("a translation in the post's own language is refused", () => {
    refused({ title: "a", language: "en", translations: { en: { title: "b", description: "" } } }, /own language/);
  });
  it("angle brackets are refused in titles and translations", () => {
    refused({ title: "a <b>" }, /title/);
    refused({ title: "a", translations: { es: { title: "<b>", description: "" } } }, /translations\.es\.title/);
    refused(
      { title: "a", translations: { es: { title: "b", description: "x > y" } } },
      /translations\.es\.description/,
    );
  });
  it("tags count as YouTube counts them", () => {
    expect(tagsLength(["a b", "cd"])).toBe(5 + 2 + 1);
    refused({ title: "a", tags: Array.from({ length: 60 }, () => "abcdefgh") }, /tags/);
    expect(checkTexts(youtube, { title: "a", tags: [" x ", "", "y"] })).toEqual({ title: "a", tags: ["x", "y"] });
    expect(checkTexts(youtube, { title: "a", tags: [" "] })).toEqual({ title: "a" });
  });
  it("unknown fields are refused", () => {
    refused({ title: "a", foo: 1 }, "unknown field foo");
  });
  it("parseTexts reads stored JSON and tolerates bad JSON", () => {
    expect(parseTexts('{"title":"a"}')).toEqual({ title: "a" });
    expect(parseTexts("nope")).toBeNull();
    expect(parseTexts(null)).toBeNull();
  });
});
