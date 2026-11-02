import { describe, expect, it } from "vitest";
import { brand, DEFAULT_BRAND, htmlFor, manifestFor } from "../brand";

const custom = { name: "Lighthouse", themeColor: "#112233" };

describe("brand", () => {
  it("defaults to Bongsu and its dark blue", () => {
    expect(brand({})).toEqual({ name: "Bongsu", themeColor: "#131f2a" });
    expect(DEFAULT_BRAND.name).toBe("Bongsu");
  });

  it("reads the name and colour, trimming the name", () => {
    expect(brand({ BONGSU_APP_NAME: " Lighthouse ", BONGSU_THEME_COLOR: "#112233" })).toEqual(custom);
  });

  it("falls back for an empty or blank name and caps a long one at 40 characters", () => {
    expect(brand({ BONGSU_APP_NAME: "   " }).name).toBe("Bongsu");
    expect(brand({ BONGSU_APP_NAME: "x".repeat(60) }).name).toHaveLength(40);
  });

  it("falls back to the default for a colour that is not #rrggbb", () => {
    for (const bad of ["blue", "#fff", "#12345g", "112233", "#1122334"]) {
      expect(brand({ BONGSU_THEME_COLOR: bad }).themeColor).toBe("#131f2a");
    }
    expect(brand({ BONGSU_THEME_COLOR: "#AABBCC" }).themeColor).toBe("#AABBCC");
  });
});

describe("manifestFor", () => {
  it("carries the name and colours and keeps the other fields", () => {
    const m = manifestFor(custom) as Record<string, unknown>;
    expect(m).toMatchObject({
      name: "Lighthouse",
      short_name: "Lighthouse",
      theme_color: "#112233",
      background_color: "#112233",
      start_url: "/#/",
      scope: "/",
      display: "standalone",
    });
    expect(m.icons).toHaveLength(4);
    expect(m.description).toBeTypeOf("string");
  });
});

describe("htmlFor", () => {
  const html = '<meta name="theme-color" content="#131f2a" /><title>Bongsu</title>';
  it("replaces the title and the theme colour", () => {
    const out = htmlFor(html, custom);
    expect(out).toContain('content="#112233"');
    expect(out).toContain("<title>Lighthouse</title>");
  });
  it("escapes the name", () => {
    expect(htmlFor(html, { ...custom, name: "A & <B>" })).toContain("<title>A &amp; &lt;B&gt;</title>");
  });
  it("leaves the defaults as they were", () => {
    expect(htmlFor(html, DEFAULT_BRAND)).toBe(html);
  });
});
