import { describe, expect, it } from "vitest";
import { csv, table } from "../src/output";

describe("table", () => {
  it("pads the columns under a header row and leaves null empty", () => {
    const rows = [
      { a: "one", b: 1 },
      { a: "three", b: null },
    ];
    expect(table(rows, ["a", "b"])).toBe("a      b\none    1\nthree\n");
  });
});

describe("csv", () => {
  it("quotes commas, quotes and newlines, with CRLF and a header row", () => {
    const rows = [
      { a: 'say "hi"', b: "x,y" },
      { a: "two\nlines", b: undefined },
      { a: true, b: null },
    ];
    expect(csv(rows, ["a", "b"])).toBe('a,b\r\n"say ""hi""","x,y"\r\n"two\nlines",\r\ntrue,\r\n');
  });

  it("quotes a field holding a quote, a comma and a newline", () => {
    expect(csv([{ a: 'a "b", c\nd' }], ["a"])).toBe('a\r\n"a ""b"", c\nd"\r\n');
  });

  it("writes booleans as true and false and null as empty", () => {
    expect(csv([{ a: true, b: false, c: null }], ["a", "b", "c"])).toBe("a,b,c\r\ntrue,false,\r\n");
  });
});
