// The app's icons, checked at build: a fork replaces the files in public/ (pnpm brand makes all seven from one SVG,
// site/docs/configuration.md "Branding"), and one missing or at the wrong size breaks the install icon without an
// error anywhere. Build-time code like brand.ts: the files come in through `read`, no Node imports here.

/** The files public/ must hold, with their pixel sizes (PNG: one size; ICO: the sizes it must contain at least). */
export const ICONS = [
  { file: "favicon.svg", kind: "svg" },
  { file: "favicon.ico", kind: "ico", sizes: [16, 32, 48] },
  { file: "icon-192.png", kind: "png", sizes: [192] },
  { file: "icon-512.png", kind: "png", sizes: [512] },
  { file: "icon-maskable-192.png", kind: "png", sizes: [192] },
  { file: "icon-maskable-512.png", kind: "png", sizes: [512] },
  { file: "apple-touch-icon.png", kind: "png", sizes: [180] },
] as const;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** A PNG's width and height (its IHDR chunk), or null when the bytes aren't a PNG. */
function pngSize(b: Uint8Array): [number, number] | null {
  if (b.length < 24 || PNG_SIGNATURE.some((v, i) => b[i] !== v)) return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return [v.getUint32(16), v.getUint32(20)];
}

/** The square sizes an ICO holds (its directory: 0 means 256), or null when the bytes aren't an ICO. */
function icoSizes(b: Uint8Array): number[] | null {
  if (b.length < 6) return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (v.getUint16(0, true) !== 0 || v.getUint16(2, true) !== 1) return null;
  const n = v.getUint16(4, true);
  if (b.length < 6 + n * 16) return null;
  return Array.from({ length: n }, (_, i) => b[6 + i * 16] || 256);
}

/** What is wrong with the icons, one line each; empty when all seven are there at their sizes. */
export function iconProblems(read: (file: string) => Uint8Array | null): string[] {
  const problems: string[] = [];
  for (const icon of ICONS) {
    const bytes = read(icon.file);
    if (!bytes) {
      problems.push(`${icon.file} is missing`);
      continue;
    }
    if (icon.kind === "svg") {
      if (!new TextDecoder().decode(bytes.subarray(0, 2048)).includes("<svg"))
        problems.push(`${icon.file} isn't an SVG`);
    } else if (icon.kind === "png") {
      const size = pngSize(bytes);
      const want = icon.sizes[0];
      if (!size) problems.push(`${icon.file} isn't a PNG`);
      else if (size[0] !== want || size[1] !== want)
        problems.push(`${icon.file} is ${size[0]}×${size[1]}, not ${want}×${want}`);
    } else {
      const sizes = icoSizes(bytes);
      const missing = sizes ? icon.sizes.filter((s) => !sizes.includes(s)) : [];
      if (!sizes) problems.push(`${icon.file} isn't an ICO`);
      else if (missing.length) problems.push(`${icon.file} has no ${missing.map((s) => `${s}×${s}`).join(", ")} image`);
    }
  }
  return problems;
}
