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

describe("the operator's details", () => {
  const page = "<p>lead</p><!-- operator -->";
  it("are read from BONGSU_OPERATOR_NAME and BONGSU_OPERATOR_CONTACT, and left out when unset", () => {
    expect(
      brand({ BONGSU_OPERATOR_NAME: " Demo Travel Ltd ", BONGSU_OPERATOR_CONTACT: "privacy@example.com" }).operator,
    ).toEqual({ name: "Demo Travel Ltd", contact: "privacy@example.com" });
    expect(brand({ BONGSU_OPERATOR_NAME: " " })).not.toHaveProperty("operator");
  });

  it("go on the pages that have a place for them, an email or a web address as a link", () => {
    const op = (contact: string) => htmlFor(page, { ...custom, operator: { name: "Demo $& Co", contact } });
    expect(op("privacy@example.com")).toContain(
      'This instance is run by Demo $&amp; Co. Contact: <a href="mailto:privacy@example.com">privacy@example.com</a>.',
    );
    expect(op("https://example.com/contact")).toContain('<a href="https://example.com/contact">');
    expect(op("<b>call us</b>")).toContain("Contact: &lt;b&gt;call us&lt;/b&gt;.");
    expect(htmlFor(page, { ...custom, operator: { contact: "a@example.com" } })).toContain(
      '<p class="operator">Contact: <a href="mailto:a@example.com">',
    );
  });

  it("leave nothing behind when unset", () => {
    expect(htmlFor(page, custom)).toBe("<p>lead</p>");
  });
});
