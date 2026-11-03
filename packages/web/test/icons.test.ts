// The build's icon check (icons.ts): the committed icons pass; a missing, foreign or wrongly sized file is named.
import { describe, expect, it } from "vitest";
import { ICONS, iconProblems } from "../icons";

// public/'s files as data URLs (no Node types in the app's tsconfig), decoded to bytes
const files = import.meta.glob("../public/*.{svg,ico,png}", { query: "?inline", import: "default", eager: true });
const bytes = (url: string) => {
  const [head, data] = [url.slice(0, url.indexOf(",")), url.slice(url.indexOf(",") + 1)];
  return head.endsWith(";base64")
    ? Uint8Array.from(atob(data), (c) => c.charCodeAt(0))
    : new TextEncoder().encode(decodeURIComponent(data)); // Vite inlines an SVG as text
};
const real = (file: string): Uint8Array | null => {
  const url = files[`../public/${file}`] as string | undefined;
  return url ? bytes(url) : null;
};
const swap = (name: string, bytes: Uint8Array | null) => (file: string) => (file === name ? bytes : real(file));

describe("iconProblems", () => {
  it("passes the committed icons", () => {
    expect(iconProblems(real)).toEqual([]);
    expect(ICONS).toHaveLength(7);
  });

  it("names a missing file", () => {
    expect(iconProblems(swap("icon-maskable-512.png", null))).toEqual(["icon-maskable-512.png is missing"]);
  });

  it("names a PNG at the wrong size, and a file that isn't one", () => {
    expect(iconProblems(swap("icon-512.png", real("icon-192.png")))).toEqual(["icon-512.png is 192×192, not 512×512"]);
    expect(iconProblems(swap("apple-touch-icon.png", real("favicon.svg")))).toEqual([
      "apple-touch-icon.png isn't a PNG",
    ]);
  });

  it("names an ICO without the tab sizes, and an SVG that isn't one", () => {
    // a valid ICO directory holding only one 64×64 image
    const ico = new Uint8Array([0, 0, 1, 0, 1, 0, 64, 64, 0, 0, 1, 0, 32, 0, 0, 0, 0, 0, 22, 0, 0, 0]);
    expect(iconProblems(swap("favicon.ico", ico))).toEqual(["favicon.ico has no 16×16, 32×32, 48×48 image"]);
    expect(iconProblems(swap("favicon.ico", real("icon-192.png")))).toEqual(["favicon.ico isn't an ICO"]);
    expect(iconProblems(swap("favicon.svg", real("icon-192.png")))).toEqual(["favicon.svg isn't an SVG"]);
  });
});
