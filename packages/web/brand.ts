// The instance's brand, read at build time: the browser reads the manifest, the <title> and the theme colour before
// anyone signs in, so they can't come from the database. One instance is one brand. Build-time code: no Vite or DOM.
export interface Brand {
  name: string;
  themeColor: string;
}

export const DEFAULT_BRAND: Brand = { name: "Bongsu", themeColor: "#131f2a" };

const MAX_NAME = 40;

export function brand(env: Record<string, string | undefined>): Brand {
  const name = env.BONGSU_APP_NAME?.trim().slice(0, MAX_NAME).trim();
  const color = env.BONGSU_THEME_COLOR?.trim();
  return {
    name: name || DEFAULT_BRAND.name,
    // A bad colour would make an invalid manifest, so it falls back instead of failing the build.
    themeColor: color && /^#[0-9a-f]{6}$/i.test(color) ? color : DEFAULT_BRAND.themeColor,
  };
}

export function manifestFor(b: Brand): object {
  return {
    name: b.name,
    short_name: b.name,
    description: "Approve and watch the scheduled Reels, posts and Shorts comments.",
    start_url: "/#/",
    scope: "/",
    display: "standalone",
    background_color: b.themeColor,
    theme_color: b.themeColor,
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function htmlFor(html: string, b: Brand): string {
  return html
    .replace(/(<meta name="theme-color" content=")[^"]*(")/, `$1${b.themeColor}$2`)
    .replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(b.name)}</title>`);
}
