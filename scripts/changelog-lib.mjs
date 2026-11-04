// The site's changelog page, built from the packages' CHANGELOG.md files (written by Changesets) and the release commits
// ("chore(release): version packages (#N)": one per release pull request). Pure: build-docs.mjs reads git and the files.
// A release is one block: the versions each package reached, then each change once, with the packages it went into.

/** The order packages are named in: the server's five (one version), then node, schema and the command line tool. */
const ORDER = [
  "@bongsu/core",
  "@bongsu/api",
  "@bongsu/web",
  "@bongsu/dashboard",
  "@bongsu/cloudflare",
  "@bongsu/node",
  "@bongsu/schema",
  "bongsu",
];
const rank = (pkg) => (ORDER.includes(pkg) ? ORDER.indexOf(pkg) : ORDER.length);
const byOrder = (a, b) => rank(a) - rank(b) || a.localeCompare(b);
const KINDS = { "Major Changes": "major", "Minor Changes": "minor", "Patch Changes": "patch" };
const KIND_ORDER = ["major", "minor", "patch"];

/** A package as the page names it: "@bongsu/core" → "core", the CLI's "bongsu" → "bongsu (command line)". */
export const shortName = (pkg) => (pkg === "bongsu" ? "bongsu (command line)" : pkg.replace(/^@bongsu\//, ""));

/**
 * One CHANGELOG.md → version → its entries, in file order: `{ kind, hash, text }`. `text` is the entry's Markdown
 * without the bullet and the commit prefix, its continuation lines un-indented. "Updated dependencies" entries (and
 * the package lines under them) are left out: the release block already lists every package's version.
 */
export function parseChangelog(markdown) {
  const versions = new Map();
  let entries = null;
  let kind = null;
  let current = null;
  const close = () => {
    if (current && !/^Updated dependencies\b/.test(current.lines[0])) {
      entries.push({ kind, hash: current.hash, text: current.lines.join("\n").replace(/\n+$/, "") });
    }
    current = null;
  };
  for (const line of markdown.split("\n")) {
    const version = /^## (\S+)\s*$/.exec(line);
    const section = /^### (.+?)\s*$/.exec(line);
    if (version) {
      if (entries) close();
      entries = [];
      kind = null;
      versions.set(version[1], entries);
    } else if (section && entries) {
      close();
      kind = KINDS[section[1]] ?? null;
    } else if (entries && kind && /^- /.test(line)) {
      close();
      const m = /^- (?:([0-9a-f]{7,40}): )?(.*)$/.exec(line);
      current = { hash: m[1] ?? null, lines: [m[2]] };
    } else if (current) {
      // continuation: two spaces of the bullet's indent, or a blank line inside the entry
      current.lines.push(line.startsWith("  ") ? line.slice(2) : line);
    }
  }
  if (entries) close();
  return versions;
}

/**
 * The release blocks, in the order given (newest first): each release names the commit, its date, its pull request and
 * the version each package reached (`bumps`). Changes are gathered from those packages' changelog sections for those
 * versions, each once (by commit, else by text), with the packages it appears in.
 */
export function releaseBlocks(releases, changelogs) {
  const parsed = Object.fromEntries(Object.entries(changelogs).map(([pkg, md]) => [pkg, parseChangelog(md)]));
  return releases.map((r) => {
    const pkgs = Object.keys(r.bumps).sort(byOrder);
    const versions = [];
    for (const pkg of pkgs) {
      const row = versions.find((v) => v.version === r.bumps[pkg]);
      if (row) row.packages.push(pkg);
      else versions.push({ version: r.bumps[pkg], packages: [pkg] });
    }
    const changes = [];
    for (const pkg of pkgs) {
      for (const e of parsed[pkg]?.get(r.bumps[pkg]) ?? []) {
        const same = changes.find((c) => (e.hash ? c.hash === e.hash : c.text === e.text) && c.kind === e.kind);
        if (same) same.packages.push(pkg);
        else changes.push({ ...e, packages: [pkg] });
      }
    }
    changes.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
    return { sha: r.sha, date: r.date, pr: r.pr, versions, changes };
  });
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
/** "2026-11-04" → "4 November 2026" (the date as written, no time zone involved). */
const longDate = (iso) => {
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
};
const HEADINGS = { major: "Breaking", minor: "New", patch: "Fixes" };

/** An entry's links to a guide in the repository ("site/docs/s3.md") point at the site's page ("s3.md"). */
const siteLinks = (text) => text.replace(/\]\(site\/docs\/([\w-]+\.md(?:#[\w-]+)?)\)/g, "]($1)");

/** The changelog page's Markdown: rendered by renderPage like the hand-written guides. */
export function changelogMarkdown(blocks, { repoUrl }) {
  const out = [
    "# Changelog",
    "",
    "What changed in each release, newest first. A release is one pull request that publishes several packages at",
    "once: the table says which version each reached, and each change names the packages it went into. Read a",
    "release's notes before updating ([Updating](updating.md)).",
    "",
  ];
  if (blocks.length === 0) out.push("No release yet.", "");
  for (const b of blocks) {
    // the heading stays plain text, so its anchor reads "4-november-2026--release-55"; the links go under it
    const name = b.pr ? `Release #${b.pr}` : `Release ${b.sha.slice(0, 7)}`;
    const link = b.pr
      ? `[The release's pull request](${repoUrl}/pull/${b.pr})`
      : `[The release](${repoUrl}/commit/${b.sha})`;
    out.push(`## ${longDate(b.date)} · ${name}`, "", link, "", "| Packages | Version |", "|---|---|");
    for (const v of b.versions) out.push(`| ${v.packages.map(shortName).join(", ")} | ${v.version} |`);
    out.push("");
    for (const kind of KIND_ORDER) {
      const list = b.changes.filter((c) => c.kind === kind);
      if (list.length === 0) continue;
      out.push(`### ${HEADINGS[kind]}`, "");
      for (const c of list) {
        const [first, ...rest] = siteLinks(c.text).split("\n");
        const meta = [`_${c.packages.map(shortName).join(", ")}_`];
        if (c.hash) meta.push(`[${c.hash}](${repoUrl}/commit/${c.hash})`);
        out.push(`- ${first}`, ...rest.map((l) => (l ? `  ${l}` : "")), "", `  ${meta.join(" · ")}`, "");
      }
    }
  }
  return `${out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd()}\n`;
}
