// WCAG AA contrast for the colours the app and the dashboard draw text in, in both themes, read from the stylesheets
// themselves so a token change can't quietly drop below 4.5:1. Two checks: the token pairs every screen uses (text
// tokens on the page and on a card), and every rule that sets both a text colour and a background, its tinted
// backgrounds (`color-mix`) included. A see-through background is checked over both surfaces it can sit on.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const tokens = read("../src/tokens.css");
const files = { app: read("../src/styles.css"), dashboard: read("../../dashboard/src/styles.css") };

const DARK = ':root[data-theme="dark"]';

/** A stylesheet split in two: the dark theme's blocks (theme.ts sets data-theme), and the rest. */
function split(css: string): { light: string; dark: string } {
  let light = css;
  let dark = "";
  for (let at = light.indexOf(DARK); at >= 0; at = light.indexOf(DARK)) {
    let depth = 0;
    let end = light.indexOf("{", at);
    do {
      if (light[end] === "{") depth++;
      else if (light[end] === "}") depth--;
      end++;
    } while (depth > 0);
    dark += `:root {${light.slice(light.indexOf("{", at) + 1, end - 1)}}`;
    light = light.slice(0, at) + light.slice(end);
  }
  return { light, dark };
}

const rootVars = (css: string) => {
  const vars: Record<string, string> = {};
  for (const [, body] of css.matchAll(/:root\s*\{([^}]*)\}/g))
    for (const [, k, v] of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) vars[k] = v.trim();
  return vars;
};

const sheets = [split(tokens), split(files.dashboard)];
const themes = {
  light: Object.assign({}, ...sheets.map((s) => rootVars(s.light))) as Record<string, string>,
  dark: Object.assign({}, ...sheets.flatMap((s) => [rootVars(s.light), rootVars(s.dark)])) as Record<string, string>,
};
type Theme = keyof typeof themes;

type Rgba = [number, number, number, number];

/** A colour value as the browser would compute it: hex, rgb(), var() and `color-mix(in srgb, …)`; null otherwise. */
function color(value: string, vars: Record<string, string>): Rgba | null {
  const v = value.trim();
  const ref = /^var\((--[\w-]+)\)$/.exec(v);
  if (ref) return vars[ref[1]] ? color(vars[ref[1]], vars) : null;
  if (v === "transparent") return [0, 0, 0, 0];
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v)?.[1];
  if (hex) {
    const h = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex;
    return [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16)).concat(1) as Rgba;
  }
  const rgb = /^rgba?\((\d+)[ ,]+(\d+)[ ,]+(\d+)(?:\s*[/,]\s*([\d.]+))?\)$/.exec(v);
  if (rgb) return [+rgb[1], +rgb[2], +rgb[3], rgb[4] === undefined ? 1 : +rgb[4]];
  const mix = /^color-mix\(in srgb,\s*(.+?)\s+([\d.]+)%,\s*(.+)\)$/.exec(v);
  if (mix) {
    const a = color(mix[1], vars);
    const b = color(mix[3], vars);
    if (!a || !b) return null;
    const p = +mix[2] / 100;
    // premultiplied, as CSS mixes: a colour mixed with transparent keeps its hue and takes the share as its alpha
    const alpha = a[3] * p + b[3] * (1 - p);
    if (alpha === 0) return [0, 0, 0, 0];
    const ch = (i: number) => (a[i] * a[3] * p + b[i] * b[3] * (1 - p)) / alpha;
    return [ch(0), ch(1), ch(2), alpha];
  }
  return null;
}

const over = (top: Rgba, under: Rgba): Rgba =>
  [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3])).concat(1) as Rgba;

const luminance = (c: Rgba) =>
  [0, 1, 2]
    .map((i) => c[i] / 255)
    .map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4))
    .reduce((sum, x, i) => sum + x * [0.2126, 0.7152, 0.0722][i], 0);

const ratio = (a: Rgba, b: Rgba) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

/** The lowest contrast of a text colour on a background, over each surface a see-through background can sit on. */
function contrast(text: string, background: string, theme: Theme): number | null {
  const vars = themes[theme];
  const fg = color(text, vars);
  const bg = color(background, vars);
  if (!fg || !bg) return null;
  const surfaces = ["var(--bg)", "var(--card)"].map((s) => color(s, vars) as Rgba);
  return Math.min(...surfaces.map((s) => ratio(over(fg, over(bg, s)), over(bg, s))));
}

const AA = 4.5;

describe("contrast (WCAG AA, 4.5:1)", () => {
  const pairs: [string, string][] = [
    ...["--fg", "--muted", "--accent", "--ok", "--warn", "--bad"].flatMap((t): [string, string][] => [
      [t, "--bg"],
      [t, "--card"],
    ]),
    ["--accent-ink", "--bg"],
    ["--ok-ink", "--card"],
    ["--warn-ink", "--card"],
    ["--on-accent", "--accent"],
    ["--on-warn", "--warn"],
    ["--on-banner", "--banner-bad"],
  ];

  it("reads the dark theme's own palette", () => {
    expect(themes.dark["--bg"]).not.toBe(themes.light["--bg"]);
    expect(themes.dark["--muted-ink"]).not.toBe(themes.light["--muted-ink"]);
  });

  for (const theme of ["light", "dark"] as Theme[])
    it(`holds for the token pairs in the ${theme} theme`, () => {
      const low = pairs
        .map(([t, b]) => ({ pair: `${t} on ${b}`, r: contrast(`var(${t})`, `var(${b})`, theme) }))
        .filter(({ r }) => r === null || r < AA);
      expect(low).toEqual([]);
    });

  for (const [name, css] of Object.entries(files))
    for (const theme of ["light", "dark"] as Theme[])
      it(`holds for every ${name} rule with its own text colour and background, in the ${theme} theme`, () => {
        const low: string[] = [];
        let checked = 0;
        for (const [, selector, body] of split(css).light.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
          const text = /(?:^|;)\s*color:\s*([^;]+)/.exec(body)?.[1];
          const background = /(?:^|;)\s*background(?:-color)?:\s*([^;]+)/.exec(body)?.[1];
          if (!text || !background) continue;
          const r = contrast(text, background, theme);
          if (r === null) continue; // not a plain colour (an image, a gradient, currentColor)
          checked++;
          if (r < AA) low.push(`${selector.trim()}: ${r.toFixed(2)}`);
        }
        expect(checked).toBeGreaterThan(5);
        expect(low).toEqual([]);
      });
});
