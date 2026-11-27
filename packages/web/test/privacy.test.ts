// The instance's privacy page (privacy/index.html, served at <PUBLIC_URL>/privacy/): the link Google's consent screen
// needs before an app asking for Drive can be published. Built as a page of its own, branded like the app.
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
});
