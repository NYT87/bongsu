import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  bareGuideLinks,
  checkLinks,
  missingImages,
  navHtml,
  pageHtml,
  renderPage,
  rewriteLink,
  slug,
} from "./docs-lib.mjs";

const B = "https://x/blob/main";

test("slug follows GitLab's heading rule", () => {
  assert.equal(slug("2. Connect the channel from the dashboard"), "2-connect-the-channel-from-the-dashboard");
  assert.equal(slug("Keeping it working"), "keeping-it-working");
  assert.equal(slug("<code>bongsu</code> export"), "bongsu-export");
});

test("rewriteLink points guides at their pages, from a page and from the index", () => {
  assert.equal(rewriteLink("youtube.md#quota", ["youtube"], B, "../"), "../youtube/#quota");
  assert.equal(rewriteLink("youtube.md#quota", ["youtube"], B, ""), "youtube/#quota");
  assert.equal(rewriteLink("youtube.md", ["youtube"], B, "../"), "../youtube/");
});

test("rewriteLink sends docs that are not pages to the repository", () => {
  assert.equal(
    rewriteLink("development.md#local-testing", ["youtube"], B, "../"),
    "https://x/blob/main/docs/development.md#local-testing",
  );
});

test("rewriteLink sends ../../docs/ guides and root files to the repository", () => {
  assert.equal(
    rewriteLink("../../docs/databases.md#backups", ["youtube"], B, "../"),
    "https://x/blob/main/docs/databases.md#backups",
  );
  assert.equal(rewriteLink("docs/schema.md", [], B, "../"), "https://x/blob/main/docs/schema.md");
  assert.equal(rewriteLink("../../SECURITY.md", [], B, "../"), "https://x/blob/main/SECURITY.md");
});

test("checkLinks reports dead anchors and unknown pages, and passes good links", () => {
  const pages = {
    "": '<h1 id="d">D</h1><a href="a/#x">a</a>',
    a: '<h1 id="a">A</h1><h2 id="x">x</h2><a href="../b/#y">b</a><a href="#x">self</a><a href="../../brand/f.ico">f</a>',
    b: '<h1 id="b">B</h1><h2 id="y">y</h2><a href="../">idx</a><a href="https://example.com/#z">w</a>',
  };
  assert.deepEqual(checkLinks(pages), []);
  const bad = checkLinks({
    ...pages,
    b: '<h2 id="y">y</h2><a href="../a/#nope">a</a><a href="#gone">g</a><a href="../ghost/">x</a>',
  });
  assert.equal(bad.length, 3);
  assert.match(bad[0], /b.*\.\.\/a\/#nope.*nope/);
  assert.match(bad[1], /#gone/);
  assert.match(bad[2], /ghost/);
});

test("missingImages reports in-site images that are not there, and skips web images", () => {
  const pages = {
    "": '<img src="assets/a.png" alt="a">',
    x: '<img src="../assets/a.png" alt="a"><img src="../assets/gone.png" alt="g"><img src="https://e.com/w.png">',
  };
  const exists = (path) => path === "assets/a.png";
  assert.deepEqual(missingImages(pages, exists), ["x: image ../assets/gone.png does not exist"]);
  assert.deepEqual(missingImages({ x: '<img src="../assets/a.png">' }, exists), []);
});

test("bareGuideLinks finds links to guides that are not public pages", () => {
  const md = "[a](a.md#x) [n](nope.md) [r](../../docs/schema.md) [w](https://e.com/z.md)";
  assert.deepEqual(bareGuideLinks(md, ["a"]), ["nope.md"]);
});

test("rewriteLink keeps anchors and web links, and drops other repo files", () => {
  assert.equal(rewriteLink("#here", ["youtube"], B, "../"), "#here");
  assert.equal(rewriteLink("https://example.com/a", ["youtube"], B, "../"), "https://example.com/a");
  assert.equal(rewriteLink("../CONTRIBUTING.md", ["youtube"], B, "../"), null);
});

test("rewriteLink resolves assets relative to the page", () => {
  assert.equal(rewriteLink("assets/a.png", [], B, "../"), "../assets/a.png");
  assert.equal(rewriteLink("assets/a.png", [], B, ""), "assets/a.png");
});

test("navHtml lists the sections that have pages and marks the current one", () => {
  const html = navHtml(
    [
      { section: "Install", pages: ["deploy-cloudflare"] },
      { section: "Use Bongsu", pages: [] },
    ],
    { "deploy-cloudflare": "Deploy on Cloudflare" },
    "deploy-cloudflare",
    "../",
  );
  assert.match(html, /<nav class="docs-nav" aria-label="Docs">/);
  assert.match(html, /<h2>Install<\/h2>/);
  assert.match(html, /href="\.\.\/deploy-cloudflare\/"/);
  assert.match(html, /aria-current="page"/);
  assert.doesNotMatch(html, /Use Bongsu/);
});

test("renderPage takes title and description and anchors headings and links", () => {
  const out = renderPage("# YouTube\n\nFirst para.\n\n## 2. Quota\n\nSee [Drive](drive.md).", {
    name: "youtube",
    pages: ["youtube", "drive"],
    blobUrl: B,
    base: "../",
  });
  assert.equal(out.title, "YouTube");
  assert.equal(out.description, "First para.");
  assert.match(out.html, /<h2 id="2-quota">/);
  assert.match(out.html, /href="\.\.\/drive\/"/);
});

test("renderPage opens web links in a new tab and keeps other repo files as text", () => {
  const out = renderPage("[a](https://example.com) and [b](../CONTRIBUTING.md)", {
    name: "x",
    pages: [],
    blobUrl: B,
    base: "",
  });
  assert.match(out.html, /<a href="https:\/\/example\.com" target="_blank" rel="noopener noreferrer">a<\/a>/);
  assert.doesNotMatch(out.html, /CONTRIBUTING/);
});

test("renderPage falls back to the name and caps the description", () => {
  const out = renderPage(`No heading here, with \`code\` and [a link](x.md).\n\n${"word ".repeat(80)}`, {
    name: "plain",
    pages: [],
    blobUrl: B,
    base: "",
  });
  assert.equal(out.title, "plain");
  assert.equal(out.description, "No heading here, with code and a link.");
  const long = renderPage("# T\n\n" + "word ".repeat(80), { name: "t", pages: [], blobUrl: B, base: "" });
  assert.ok(long.description.length <= 160);
});

test("pageHtml builds the document with the site's header and an edit link", () => {
  const p = {
    title: "YouTube",
    description: 'Say "hi" <b>',
    html: "<h1>YouTube</h1>",
    name: "youtube",
    nav: '<nav class="docs-nav"></nav>',
    siteUrl: "https://example.com",
    blobUrl: B,
    editPath: "site/docs/youtube.md",
    base: "../",
  };
  const html = pageHtml(p);
  assert.match(html, /<title>YouTube · Bongsu docs<\/title>/);
  assert.match(html, /href="\.\.\/\.\.\/docs\.css"/);
  assert.match(html, /href="\.\.\/\.\.\/brand\/favicon\.ico"/);
  assert.match(html, /href="\{\{REPO_URL\}\}"/);
  assert.match(html, /content="#131f2a"/);
  assert.match(html, /content="Say &quot;hi&quot; &lt;b&gt;"/);
  assert.match(html, /<article class="prose">/);
  assert.match(html, /href="https:\/\/x\/blob\/main\/site\/docs\/youtube\.md"/);
  assert.match(html, /MIT License/);
  assert.match(pageHtml({ ...p, base: "" }), /href="\.\.\/docs\.css"/);
});

test("renderPage prefixes image paths like links", () => {
  const md = '![s](assets/x.png "T") ![w](https://example.com/y.png)';
  const page = renderPage(md, { name: "x", pages: [], blobUrl: B, base: "../" });
  assert.match(page.html, /<img src="\.\.\/assets\/x\.png" alt="s" title="T">/);
  assert.match(page.html, /<img src="https:\/\/example\.com\/y\.png" alt="w">/);
  const index = renderPage(md, { name: "x", pages: [], blobUrl: B, base: "" });
  assert.match(index.html, /<img src="assets\/x\.png" alt="s" title="T">/);
});

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), "docs-build-"));
  const src = join(root, "src");
  mkdirSync(src);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(src, name), text);
  return { src, out: join(root, "out") };
}

test("build-docs renders a folder into pages", () => {
  const { src, out } = fixture({
    "README.md": "# Docs\n\n[A](a.md)",
    "a.md": "# A\n\nSee [B](b.md#x) and [dev](../../docs/development.md).",
    "b.md": "# B\n\n## x",
    "nav.json": '[{"section":"S","pages":["a","b"]}]',
  });
  execFileSync("node", ["scripts/build-docs.mjs", out, "https://x/blob/main", "https://s", src]);
  const read = (f) => readFileSync(join(out, f), "utf8");
  assert.match(read("docs/index.html"), /href="a\/"/);
  const a = read("docs/a/index.html");
  assert.match(a, /href="\.\.\/b\/#x"/);
  assert.match(a, /href="https:\/\/x\/blob\/main\/docs\/development\.md"/);
  assert.match(read("docs/b/index.html"), /<h2 id="x">/);
  assert.ok(existsSync(join(out, "docs.css")));
});

test("build-docs names the file when a page has no title or a nav entry has no file", () => {
  const run = (files) => {
    const { src, out } = fixture(files);
    return spawnSync("node", ["scripts/build-docs.mjs", out, "https://x/blob/main", "https://s", src], {
      encoding: "utf8",
    });
  };
  const untitled = run({ "README.md": "# D", "a.md": "no heading", "nav.json": "[]" });
  assert.equal(untitled.status, 1);
  assert.match(untitled.stderr, /a\.md/);
  const missing = run({ "README.md": "# D", "nav.json": '[{"section":"S","pages":["ghost"]}]' });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /ghost\.md/);
});

test("build-docs fails on a dead anchor and on a bare link to a guide that is not a page", () => {
  const run = (files) => {
    const { src, out } = fixture(files);
    return spawnSync("node", ["scripts/build-docs.mjs", out, "https://x/blob/main", "https://s", src], {
      encoding: "utf8",
    });
  };
  const dead = run({ "README.md": "# D", "a.md": "# A\n\n[b](b.md#missing)", "b.md": "# B\n\n## here" });
  assert.equal(dead.status, 1);
  assert.match(dead.stderr, /a.*b\/#missing.*missing/);
  const bare = run({ "README.md": "# D", "a.md": "# A\n\n[n](nope.md)" });
  assert.equal(bare.status, 1);
  assert.match(bare.stderr, /nope\.md/);
  const good = run({ "README.md": "# D\n\n[a](a.md#a)", "a.md": "# A\n\n[d](../../docs/x.md#q)" });
  assert.equal(good.status, 0, good.stderr);
});

test("build-docs fails on a missing image and passes an existing one", () => {
  const { src, out } = fixture({ "README.md": "# D", "a.md": "# A\n\n![x](assets/missing.png)" });
  const missing = spawnSync("node", ["scripts/build-docs.mjs", out, "https://x/blob/main", "https://s", src], {
    encoding: "utf8",
  });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /a: image \.\.\/assets\/missing\.png/);
  const ok = fixture({ "README.md": "# D", "a.md": "# A\n\n![x](assets/here.png)" });
  mkdirSync(join(ok.src, "assets"));
  writeFileSync(join(ok.src, "assets/here.png"), "");
  const here = spawnSync("node", ["scripts/build-docs.mjs", ok.out, "https://x/blob/main", "https://s", ok.src], {
    encoding: "utf8",
  });
  assert.equal(here.status, 0, here.stderr);
});
