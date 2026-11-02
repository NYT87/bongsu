// Builds the public docs (site/docs/*.md) into <out>/docs/: an index and one folder per page. Only I/O here; the
// rendering lives in docs-lib.mjs. Usage: node scripts/build-docs.mjs <out> <blobUrl> <siteUrl> [<srcDir>]
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bareGuideLinks, checkLinks, missingImages, navHtml, pageHtml, renderPage } from "./docs-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [out, blobUrl, siteUrl, srcArg] = process.argv.slice(2);
if (!out || !blobUrl) {
  console.error("usage: build-docs.mjs <out> <blobUrl> <siteUrl> [<srcDir>]");
  process.exit(1);
}
const src = srcArg ?? join(root, "site/docs");

const fail = (message) => {
  console.error(`build-docs: ${message}`);
  process.exit(1);
};

const nav = existsSync(join(src, "nav.json")) ? JSON.parse(readFileSync(join(src, "nav.json"), "utf8")) : [];
const files = readdirSync(src).filter((f) => f.endsWith(".md"));
const names = files.map((f) => f.replace(/\.md$/, "")).filter((n) => n !== "README");
for (const page of nav.flatMap((s) => s.pages)) {
  if (!names.includes(page)) fail(`${join(src, `${page}.md`)}: listed in nav.json but missing`);
}
// Pages not in nav.json still get built, just without a sidebar entry.
const render = (file, name, base) => {
  const markdown = readFileSync(join(src, file), "utf8");
  if (!/^# \S/m.test(markdown)) fail(`${join(src, file)}: no "# " title`);
  for (const bare of bareGuideLinks(markdown, names)) {
    fail(`${join(src, file)}: link to ${bare} is not a public page; write it ../../docs/${bare}`);
  }
  return renderPage(markdown, { name, pages: names, blobUrl, base });
};
const rendered = Object.fromEntries(
  files.map((f) => [f, render(f, f.replace(/\.md$/, ""), f === "README.md" ? "" : "../")]),
);
const htmlByPage = Object.fromEntries(
  files.map((f) => [f === "README.md" ? "" : f.replace(/\.md$/, ""), rendered[f].html]),
);
const problems = checkLinks(htmlByPage);
if (problems.length > 0) fail(`broken links:\n  ${problems.join("\n  ")}`);
const missing = missingImages(htmlByPage, (path) => existsSync(join(src, path)));
if (missing.length > 0) fail(`missing images:\n  ${missing.join("\n  ")}`);
const titles = Object.fromEntries(names.map((n) => [n, rendered[`${n}.md`].title]));

const write = (dir, file, name, base) => {
  const page = rendered[file];
  const html = pageHtml({
    ...page,
    name,
    nav: navHtml(nav, titles, name, base),
    siteUrl,
    blobUrl,
    editPath: `site/docs/${file}`,
    base,
  });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.html"), html);
};

const docsOut = join(out, "docs");
if (existsSync(join(src, "README.md"))) write(docsOut, "README.md", "", "");
for (const name of names) write(join(docsOut, name), `${name}.md`, name, "../");
if (existsSync(join(src, "assets"))) cpSync(join(src, "assets"), join(docsOut, "assets"), { recursive: true });
cpSync(join(root, "site/docs.css"), join(out, "docs.css"));
