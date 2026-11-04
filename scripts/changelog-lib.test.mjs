import assert from "node:assert/strict";
import { test } from "node:test";
import { changelogMarkdown, parseChangelog, releaseBlocks } from "./changelog-lib.mjs";

const CORE = `# @bongsu/core

## 0.4.0

### Minor Changes

- de54272: Media stores are set up in the dashboard.

  - **S3-compatible buckets** ([S3-compatible buckets](site/docs/s3.md)).

  To update: set the store up again.

### Patch Changes

- 18c6031: Push notifications go only to the members of their workspace.
- Updated dependencies [de54272]
  - @bongsu/schema@0.3.0

## 0.3.0

### Minor Changes

- 1a2b3c4: The stats tab.
`;

const API = `# @bongsu/api

## 0.4.0

### Minor Changes

- de54272: Media stores are set up in the dashboard.

  - **S3-compatible buckets** ([S3-compatible buckets](site/docs/s3.md)).

  To update: set the store up again.

### Patch Changes

- 18c6031: Push notifications go only to the members of their workspace.
`;

const CLI = `# bongsu

## 0.2.0

### Major Changes

- 9f9f9f9: \`bongsu login\` replaces \`bongsu auth\`.

### Minor Changes

- 839cc12: Stats for agents.
`;

test("parseChangelog reads each version's entries with their kind, commit and whole text", () => {
  const v = parseChangelog(CORE);
  assert.deepEqual([...v.keys()], ["0.4.0", "0.3.0"]);
  const e = v.get("0.4.0");
  assert.deepEqual(
    e.map((x) => [x.kind, x.hash]),
    [
      ["minor", "de54272"],
      ["patch", "18c6031"],
    ],
  );
  assert.equal(
    e[0].text,
    "Media stores are set up in the dashboard.\n\n- **S3-compatible buckets** ([S3-compatible buckets](site/docs/s3.md)).\n\nTo update: set the store up again.",
  );
});

test("parseChangelog drops the Updated dependencies lines and their sub-items", () => {
  const all = [...parseChangelog(CORE).values()].flat();
  assert.ok(all.every((x) => !/Updated dependencies|@bongsu\/schema@/.test(x.text)));
});

test("parseChangelog reads major changes", () => {
  assert.deepEqual(
    parseChangelog(CLI)
      .get("0.2.0")
      .map((x) => x.kind),
    ["major", "minor"],
  );
});

const RELEASES = [
  {
    sha: "6cccc47aaa",
    date: "2026-11-04",
    pr: 55,
    bumps: { "@bongsu/core": "0.4.0", "@bongsu/api": "0.4.0", "@bongsu/schema": "0.3.0" },
  },
  { sha: "b913c81bbb", date: "2026-11-03", pr: 47, bumps: { "@bongsu/core": "0.3.0", bongsu: "0.2.0" } },
];
const LOGS = {
  "@bongsu/core": CORE,
  "@bongsu/api": API,
  bongsu: CLI,
  "@bongsu/schema": "# @bongsu/schema\n\n## 0.3.0\n",
};

test("releaseBlocks lists each change once per release, with the packages it went into", () => {
  const [b] = releaseBlocks(RELEASES, LOGS);
  assert.equal(b.pr, 55);
  const minor = b.changes.filter((c) => c.kind === "minor");
  assert.equal(minor.length, 1);
  assert.deepEqual(minor[0].packages, ["@bongsu/core", "@bongsu/api"]);
  assert.equal(b.changes.filter((c) => c.hash === "18c6031").length, 1);
});

test("releaseBlocks groups packages that reached the same version", () => {
  const [b] = releaseBlocks(RELEASES, LOGS);
  assert.deepEqual(b.versions, [
    { version: "0.4.0", packages: ["@bongsu/core", "@bongsu/api"] },
    { version: "0.3.0", packages: ["@bongsu/schema"] },
  ]);
});

test("releaseBlocks keeps the releases' order, newest first, and puts the CLI in its own release", () => {
  const blocks = releaseBlocks(RELEASES, LOGS);
  assert.deepEqual(
    blocks.map((b) => b.pr),
    [55, 47],
  );
  assert.deepEqual(
    blocks[1].changes.map((c) => [c.kind, c.hash, c.packages.join()]),
    [
      ["major", "9f9f9f9", "bongsu"],
      ["minor", "1a2b3c4", "@bongsu/core"],
      ["minor", "839cc12", "bongsu"],
    ],
  );
});

test("changelogMarkdown writes a block per release with its versions, its changes and links to GitHub", () => {
  const md = changelogMarkdown(releaseBlocks(RELEASES, LOGS), { repoUrl: "https://github.com/NYT87/bongsu" });
  assert.match(md, /^# Changelog\n/);
  assert.ok(md.indexOf("4 November 2026") < md.indexOf("3 November 2026"), "newest first");
  assert.match(md, /^## 4 November 2026 · Release #55$/m);
  assert.match(md, /\(https:\/\/github\.com\/NYT87\/bongsu\/pull\/55\)/);
  assert.match(md, /\| core, api \| 0\.4\.0 \|/);
  assert.match(md, /\| bongsu \(command line\) \| 0\.2\.0 \|/);
  assert.match(md, /### Breaking/);
  // a guide link becomes the site's own page; the commit links to GitHub
  assert.match(md, /\]\(s3\.md\)/);
  assert.doesNotMatch(md, /site\/docs\/s3\.md/);
  assert.match(md, /\[de54272\]\(https:\/\/github\.com\/NYT87\/bongsu\/commit\/de54272\)/);
  assert.match(md, /_core, api_/);
});

test("changelogMarkdown says so when there is no release yet", () => {
  assert.match(changelogMarkdown([], { repoUrl: "https://github.com/NYT87/bongsu" }), /No release yet/);
});
