// The instance's privacy policy and terms of service (privacy/index.html, terms/index.html, served at
// <PUBLIC_URL>/privacy/ and /terms/): the links Google's consent screen asks for. Built as pages of their own,
// branded like the app.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { htmlFor } from "../brand";
import config from "../vite.config";

const html = readFileSync(new URL("../privacy/index.html", import.meta.url), "utf8");

describe("the privacy page", () => {
  it("is built beside the app", () => {
    const input = config.build?.rollupOptions?.input as Record<string, string>;
    expect(input.privacy).toBe("privacy/index.html");
    expect(input.app).toBe("index.html");
  });

  it("takes the app's name and colour from the build", () => {
    const branded = htmlFor(html, { name: "Lighthouse", themeColor: "#112233" });
    expect(branded).toContain("<title>Lighthouse</title>");
    expect(branded).toContain('<meta name="theme-color" content="#112233" />');
  });

  it("states what Google requires of an app with Drive access: the scopes' use and Limited Use", () => {
    for (const s of ["Google Drive", "YouTube Analytics", "never deletes", "Limited Use requirements"])
      expect(html).toContain(s);
    expect(html).toContain("https://developers.google.com/terms/api-services-user-data-policy");
  });

  it("lists its cookies and browser storage, and how long it keeps things", () => {
    for (const s of ["bongsu_session", "bongsu_admin", "bongsu_oauth", "localStorage", "service worker"])
      expect(html).toContain(s);
    expect(html).toContain("No analytics, no ads, no third-party");
    for (const s of ["180 days", "30 days", "12 hours", "7 days"]) expect(html).toContain(s);
  });

  it("has a place for the operator's details, as the terms do", () => {
    expect(html).toContain("<!-- operator -->");
  });
});

describe("the terms of service page", () => {
  const terms = readFileSync(new URL("../terms/index.html", import.meta.url), "utf8");

  it("is built beside the app, branded like it", () => {
    const input = config.build?.rollupOptions?.input as Record<string, string>;
    expect(input.terms).toBe("terms/index.html");
    expect(htmlFor(terms, { name: "Lighthouse", themeColor: "#112233" })).toContain("<title>Lighthouse</title>");
  });

  it("links the terms YouTube's API Services ask for, and the two pages link each other", () => {
    expect(terms).toContain("https://www.youtube.com/t/terms");
    expect(terms).toContain("https://policies.google.com/privacy");
    expect(terms).toContain('href="/privacy/"');
    expect(html).toContain('href="/terms/"');
    expect(html).toContain("https://policies.google.com/privacy");
  });

  it("has a place for the operator's details", () => {
    expect(terms).toContain("<!-- operator -->");
  });
});
