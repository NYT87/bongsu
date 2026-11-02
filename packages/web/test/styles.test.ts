import { describe, expect, it } from "vitest";
import css from "../src/styles.css?raw";

const at = (selector: string) => css.indexOf(`\n${selector} {`);

describe("styles", () => {
  // No DOM here, so this pins the rule itself: `.list li > div { display: block }` outranks `.row`, and a row that
  // sits right in a list item (the Drafts page) lost its gap ("Recovery runReel").
  it("keeps a row straight in a list item a flex row", () => {
    expect(at(".list li > div")).toBeGreaterThan(-1);
    const row = at(".list li > .row");
    expect(row).toBeGreaterThan(-1);
    expect(css.slice(row, css.indexOf("}", row))).toMatch(/display:\s*flex/);
  });
});
