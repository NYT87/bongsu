// Builds the public docs (site/docs/*.md) into <out>/docs/: an index and one folder per page. Only I/O here; the
// rendering lives in docs-lib.mjs. Usage: node scripts/build-docs.mjs <out> <blobUrl> <siteUrl> [<srcDir>]
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { changelogMarkdown, releaseBlocks } from "./changelog-lib.mjs";
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
// The changelog is generated (scripts/changelog-lib.mjs), not a file: built when nav.json lists it.
const CHANGELOG = "changelog";
const withChangelog = nav.some((s) => s.pages.includes(CHANGELOG));
if (withChangelog) names.push(CHANGELOG);
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
if (withChangelog) {
  const repoUrl = blobUrl.replace(/\/blob\/.*$/, "");
  const markdown = changelogMarkdown(releaseBlocks(...releasesFromGit()), { repoUrl });
  rendered[`${CHANGELOG}.md`] = renderPage(markdown, { name: CHANGELOG, pages: names, blobUrl, base: "../" });
}
const htmlByPage = Object.fromEntries(
  Object.keys(rendered).map((f) => [f === "README.md" ? "" : f.replace(/\.md$/, ""), rendered[f].html]),
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
    // the changelog is written by the changesets in .changeset/, not by hand
    editPath: file === `${CHANGELOG}.md` ? ".changeset/README.md" : `site/docs/${file}`,
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

/**
 * The release commits from git, newest first ("chore(release): version packages (#N)", one per release pull request),
 * each with the version every package reached in it (package.json before and after), and every package's changelog.
 * A shallow clone has no history to read: the Pages workflow checks out with fetch-depth 0.
 */
function releasesFromGit() {
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (git("rev-parse", "--is-shallow-repository").trim() === "true")
    fail(
      "the changelog needs the git history: fetch it (actions/checkout with fetch-depth: 0, or git fetch --unshallow)",
    );
  const dirs = ["packages", "apps"].flatMap((d) =>
    readdirSync(join(root, d))
      .map((n) => `${d}/${n}`)
      .filter((p) => existsSync(join(root, p, "package.json")) && existsSync(join(root, p, "CHANGELOG.md"))),
  );
  const names = Object.fromEntries(
    dirs.map((d) => [d, JSON.parse(readFileSync(join(root, d, "package.json"), "utf8")).name]),
  );
  const versionAt = (rev, dir) => {
    try {
      return JSON.parse(git("show", `${rev}:${dir}/package.json`)).version;
    } catch {
      return null; // the package didn't exist yet
    }
  };
  const log = git("log", "--format=%H%x09%cs%x09%s", "--grep=^chore(release): version packages", "HEAD");
  const releases = log
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha, date, subject] = line.split("\t");
      const bumps = {};
      for (const d of dirs) {
        const now = versionAt(sha, d);
        if (now && now !== versionAt(`${sha}^`, d)) bumps[names[d]] = now;
      }
      const pr = /\(#(\d+)\)\s*$/.exec(subject);
      return { sha, date, pr: pr ? Number(pr[1]) : null, bumps };
    })
    .filter((r) => Object.keys(r.bumps).length > 0);
  const changelogs = Object.fromEntries(
    dirs.map((d) => [names[d], readFileSync(join(root, d, "CHANGELOG.md"), "utf8")]),
  );
  return [releases, changelogs];
}
