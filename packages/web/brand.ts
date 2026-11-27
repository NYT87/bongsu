// The instance's brand, read at build time: the browser reads the manifest, the <title> and the theme colour before
// anyone signs in, so they can't come from the database. One instance is one brand. Build-time code: no Vite or DOM.
export interface Brand {
  name: string;
  themeColor: string;
  /** Who runs the instance and how to reach them (BONGSU_OPERATOR_NAME, BONGSU_OPERATOR_CONTACT): shown on the privacy
   *  and terms pages when set, for operators who must name a business or a contact there. */
  operator?: { name?: string; contact?: string };
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
    ...operatorOf(env),
  };
}

function operatorOf(env: Record<string, string | undefined>): Pick<Brand, "operator"> {
  const name = env.BONGSU_OPERATOR_NAME?.trim();
  const contact = env.BONGSU_OPERATOR_CONTACT?.trim();
  return name || contact ? { operator: { ...(name && { name }), ...(contact && { contact }) } } : {};
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

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The operator's line for the privacy and terms pages: an email or a web address becomes a link. */
function operatorHtml(op: Brand["operator"]): string {
  if (!op) return "";
  const c = op.contact;
  const href = c && (/^[^@\s]+@[^@\s]+$/.test(c) ? `mailto:${c}` : /^https?:\/\//.test(c) ? c : null);
  const contact = c && (href ? `<a href="${escapeHtml(href)}">${escapeHtml(c)}</a>` : escapeHtml(c));
  const who = op.name ? `This instance is run by ${escapeHtml(op.name)}.` : "";
  return `<p class="operator">${who}${who && contact ? " " : ""}${contact ? `Contact: ${contact}.` : ""}</p>`;
}

export function htmlFor(html: string, b: Brand): string {
  return (
    html
      .replace(/(<meta name="theme-color" content=")[^"]*(")/, `$1${b.themeColor}$2`)
      .replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(b.name)}</title>`)
      // a function, so a "$&" in the operator's name is kept as written
      .replace("<!-- operator -->", () => operatorHtml(b.operator))
  );
}
