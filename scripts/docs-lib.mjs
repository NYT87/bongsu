// The public docs site's renderer: Markdown guides in, pages out. Pure (no file system), so scripts/build-docs.mjs does
// the reading and writing and the tests run on strings. `base` is "../" for a page at /docs/<name>/ and "" for the
// index at /docs/, so every link stays relative and the site works under any path (GitLab Pages project sites).
import { Marked } from "marked";

/** GitLab's heading anchors ("2. A refresh token" → "2-a-refresh-token"), so links written for the repo view still land. */
export const slug = (text) =>
  text
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .trim()
    .replace(/\s/g, "-");

const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Where a link in a guide goes on the site: another page (and its section), a section of this one, an asset, a web page,
 * a guide that isn't a page (the repository's copy). Anything else in the repo returns null: it renders as text.
 */
export function rewriteLink(href, pages, blobUrl, base) {
  if (href.startsWith("#") || /^https?:/.test(href)) return href;
  const guide = /^([\w-]+)\.md(#.*)?$/.exec(href);
  if (guide) {
    if (pages.includes(guide[1])) return `${base}${guide[1]}/${guide[2] ?? ""}`;
    return `${blobUrl}/docs/${guide[1]}.md${guide[2] ?? ""}`;
  }
  const repoGuide = /^(?:\.\.\/\.\.\/)?docs\/([\w-]+)\.md(#.*)?$/.exec(href);
  if (repoGuide) return `${blobUrl}/docs/${repoGuide[1]}.md${repoGuide[2] ?? ""}`;
  const rootFile = /^\.\.\/\.\.\/([A-Za-z_]+\.md)$/.exec(href);
  if (rootFile) return `${blobUrl}/${rootFile[1]}`;
  if (href.startsWith("assets/")) return `${base}${href}`;
  return null;
}

/** Bare `x.md` links in a guide whose x is not a public page: they must be written `../../docs/x.md`. */
export function bareGuideLinks(markdown, pages) {
  const found = [...markdown.matchAll(/\]\(([\w-]+)\.md(?:#[^)\s]*)?\)/g)].map((m) => m[1]);
  return [...new Set(found)].filter((n) => !pages.includes(n)).map((n) => `${n}.md`);
}

/**
 * Checks every in-site link of the rendered pages ({ name: html }, "" for the index) against the pages and their
 * heading ids. Returns one message per problem.
 */
export function checkLinks(pages) {
  const urlOf = (name) => `http://h/docs/${name ? `${name}/` : ""}`;
  const idsOf = (html) => new Set([...html.matchAll(/<h[1-6] id="([^"]*)"/g)].map((m) => m[1]));
  const ids = Object.fromEntries(Object.entries(pages).map(([name, html]) => [name, idsOf(html)]));
  const problems = [];
  for (const [name, html] of Object.entries(pages)) {
    for (const [, href] of html.matchAll(/<a href="([^"]*)"/g)) {
      if (/^[a-z]+:/i.test(href) || href.startsWith("{{")) continue;
      const to = new URL(href, urlOf(name));
      const m = /^\/docs\/([\w-]*)\/?$/.exec(to.pathname);
      if (!m) continue; // outside the docs (landing page, brand files, assets)
      const label = name || "index";
      if (!(m[1] in ids)) {
        if (m[1] !== "assets") problems.push(`${label}: link ${href} goes to a page that does not exist`);
        continue;
      }
      const anchor = decodeURIComponent(to.hash.slice(1));
      if (anchor && !ids[m[1]].has(anchor))
        problems.push(`${label}: link ${href} has no anchor "${anchor}" on ${m[1] || "index"}`);
    }
  }
  return problems;
}

/**
 * The in-site images of the rendered pages ({ name: html }) whose file is missing: `exists` answers for a path relative
 * to the docs root ("assets/x.png"). A missing image would ship as a broken picture, so the build fails instead.
 */
export function missingImages(pages, exists) {
  const problems = [];
  for (const [name, html] of Object.entries(pages)) {
    for (const [, src] of html.matchAll(/<img src="([^"]*)"/g)) {
      if (/^[a-z]+:/i.test(src) || src.startsWith("{{")) continue;
      const path = new URL(src, `http://h/docs/${name ? `${name}/` : ""}`).pathname;
      if (!path.startsWith("/docs/")) continue;
      if (!exists(decodeURIComponent(path.slice("/docs/".length))))
        problems.push(`${name || "index"}: image ${src} does not exist`);
    }
  }
  return problems;
}

/** The sidebar: a heading per section that has pages, a link per page. */
export function navHtml(nav, titles, current, base) {
  const sections = nav
    .filter((s) => s.pages.length > 0)
    .map((s) => {
      const items = s.pages
        .map((page) => {
          const aria = page === current ? ' aria-current="page"' : "";
          return `<li><a href="${base}${page}/"${aria}>${escapeHtml(titles[page] ?? page)}</a></li>`;
        })
        .join("");
      return `<h2>${escapeHtml(s.section)}</h2><ul>${items}</ul>`;
    })
    .join("");
  return `<nav class="docs-nav" aria-label="Docs">${sections}</nav>`;
}

/** The plain text of inline tokens (links and code lose their markup). */
const textOf = (tokens) => tokens.map((t) => (t.tokens ? textOf(t.tokens) : (t.text ?? t.raw))).join("");

const cap = (s, max) => (s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`);

export function renderPage(markdown, { name, pages, blobUrl, base }) {
  const md = new Marked({
    gfm: true,
    renderer: {
      heading({ tokens, depth, text }) {
        return `<h${depth} id="${slug(text)}">${this.parser.parseInline(tokens)}</h${depth}>\n`;
      },
      link({ href, tokens }) {
        const inner = this.parser.parseInline(tokens);
        const to = rewriteLink(href, pages, blobUrl, base);
        if (to === null) return inner;
        if (/^https?:/.test(to)) return `<a href="${to}" target="_blank" rel="noopener noreferrer">${inner}</a>`;
        return `<a href="${to}">${inner}</a>`;
      },
      // Images follow the same path rule as links (assets/ is relative to the docs root, not to the page); a src that
      // rewriteLink drops stays as written.
      image({ href, title, text }) {
        const src = rewriteLink(href, pages, blobUrl, base) ?? href;
        const t = title ? ` title="${escapeHtml(title)}"` : "";
        return `<img src="${src}" alt="${escapeHtml(text)}"${t}>`;
      },
    },
  });
  const tokens = md.lexer(markdown);
  const h1 = tokens.find((t) => t.type === "heading" && t.depth === 1);
  const para = tokens.find((t) => t.type === "paragraph");
  return {
    title: h1 ? textOf(h1.tokens).trim() : name,
    description: para ? cap(textOf(para.tokens).replace(/\s+/g, " ").trim(), 160) : "",
    html: md.parser(tokens),
  };
}

/** The whole document. {{REPO_URL}} stays for build-site.sh's sed, like the landing page's own links. */
export function pageHtml({ title, description, html, nav, blobUrl, editPath, base }) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>${escapeHtml(title)} · Bongsu docs</title>
    <meta name="description" content="${escapeHtml(description)}" />
    <meta name="theme-color" content="#131f2a" />
    <link rel="icon" href="${base}../brand/favicon.ico" sizes="any" />
    <link rel="stylesheet" href="${base}../docs.css" />
  </head>
  <body>
    <header class="docs-header">
      <nav class="nav wrap" aria-label="Main">
        <a class="nav-home" href="${base}../">Bongsu</a>
        <ul>
          <li><a href="${base}../">Home</a></li>
          <li><a href="${base || "./"}">Docs</a></li>
          <li><a href="{{REPO_URL}}">Source</a></li>
        </ul>
      </nav>
    </header>
    <div class="docs-layout wrap">
      ${nav}
      <main>
        <article class="prose">
${html}
        </article>
        <p class="docs-edit"><a href="${blobUrl}/${editPath}" target="_blank" rel="noopener noreferrer">Edit this page</a></p>
      </main>
    </div>
    <footer class="docs-footer wrap"><p>MIT License</p></footer>
  </body>
</html>
`;
}
