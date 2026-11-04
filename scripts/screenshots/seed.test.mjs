// seedDemo builds a whole demo instance in a scratch folder: the rows, the media files and the two sessions.
// Needs apps/node/dist (built on first use), no network.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { seedDemo } from "./seed.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const Database = createRequire(join(root, "apps/node/package.json"))("better-sqlite3");
const sha256 = (s) => createHash("sha256").update(s).digest("hex");

const open = (path) => new Database(path, { readonly: true });
const rows = (db, sql, ...args) => db.prepare(sql).all(...args);
const count = (db, table, where = "1") => db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get().n;
const counts = (path) => {
  const db = open(path);
  try {
    return Object.fromEntries(
      ["accounts", "plan_items", "approvals", "posted", "drafts", "sessions", "passkeys", "comments"].map((t) => [
        t,
        count(db, t),
      ]),
    );
  } finally {
    db.close();
  }
};

describe("seedDemo", () => {
  const tmp = mkdtempSync(join(tmpdir(), "bongsu-seed-"));
  const now = new Date("2026-10-31T03:00:00Z");
  let first;
  let before1;
  before(async () => {
    first = await seedDemo(tmp, now);
    before1 = counts(first.dbPath);
  });
  after(() => rmSync(tmp, { recursive: true, force: true }));

  it("seeds unused recovery codes, so the overview has nothing to ask for", () => {
    const db = open(first.dbPath);
    assert.ok(count(db, "recovery_codes", "used_at IS NULL AND user_id = 'owner'") >= 5);
    db.close();
  });

  it("seeds the accounts: two Instagram, one YouTube", () => {
    const db = open(first.dbPath);
    const a = rows(db, "SELECT platform, COUNT(*) AS n FROM accounts GROUP BY platform ORDER BY platform");
    assert.deepEqual(a, [
      { platform: "instagram", n: 2 },
      { platform: "youtube", n: 1 },
    ]);
    db.close();
  });

  it("seeds a plan with approved, held, re-approve and posted items", () => {
    const db = open(first.dbPath);
    const items = rows(db, "SELECT * FROM plan_items");
    assert.ok(items.length >= 8);
    const approvals = new Map(rows(db, "SELECT * FROM approvals").map((a) => [a.item_key, a]));
    const approved = items.filter((i) => approvals.get(i.item_key)?.due_at === i.due_at && !i.hold);
    assert.ok(approved.length >= 3, `approved: ${approved.length}`);
    assert.ok(items.some((i) => i.hold === 1));
    assert.ok(items.some((i) => approvals.has(i.item_key) && approvals.get(i.item_key).due_at !== i.due_at)); // re-approve
    assert.ok(items.some((i) => !approvals.has(i.item_key) && !i.hold)); // waiting for the owner
    const posted = rows(
      db,
      "SELECT p.item_key, r.median_views FROM posted p JOIN post_results r ON r.item_key = p.item_key",
    );
    assert.equal(posted.length, 1);
    assert.equal(first.postedKey, posted[0].item_key);
    assert.ok(count(db, "comments", `item_key = '${posted[0].item_key}' AND own = 0`) >= 2);
    // its metrics series, and its Trial Reel copy's: the Results screenshot draws two lines
    assert.ok(count(db, "post_metrics", `item_key = '${posted[0].item_key}'`) >= 12);
    assert.ok(count(db, "post_metrics", `item_key = 'trial:${posted[0].item_key}'`) >= 12);
    assert.equal(count(db, "trial_posts", `item_key = '${posted[0].item_key}'`), 1);
    assert.equal(first.itemKey.startsWith("reel:"), true);
    assert.ok(approvals.has(first.approvedKey));
    assert.ok(!approvals.has(first.itemKey));
    db.close();
  });

  it("an approval's fingerprints match the item's texts", () => {
    const db = open(first.dbPath);
    const i = rows(db, "SELECT * FROM plan_items WHERE item_key = ?", first.approvedKey)[0];
    const a = rows(db, "SELECT * FROM approvals WHERE item_key = ?", first.approvedKey)[0];
    assert.equal(a.caption_sha, sha256(i.caption.trim()));
    assert.equal(a.account, i.account);
    assert.ok(JSON.parse(a.media).length >= 1);
    db.close();
  });

  it("seeds two drafts, a Shorts comment waiting and the YouTube cache", () => {
    const db = open(first.dbPath);
    assert.equal(count(db, "drafts", "status = 'draft'"), 2);
    assert.equal(count(db, "shorts_comments"), 1);
    const up = JSON.parse(rows(db, "SELECT value FROM settings WHERE key = 'yt_uploads:main'")[0].value);
    assert.ok(up.some((u) => u.id === first.videoId && u.privacy === "private" && u.short));
    assert.match(first.videoDate, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(first.videoDate > "2026-10-31");
    db.close();
  });

  it("seeds one session per app, stored as hashes, and the set-up rows", () => {
    const db = open(first.dbPath);
    const s = rows(db, "SELECT * FROM sessions ORDER BY app");
    assert.deepEqual(
      s.map((x) => x.app),
      ["dashboard", "pwa"],
    );
    assert.equal(s[0].token_hash, sha256(first.dashboardToken));
    assert.equal(s[1].token_hash, sha256(first.pwaToken));
    assert.ok(s.every((x) => x.verified_at === Math.floor(now.getTime() / 1000)));
    assert.equal(count(db, "passkeys"), 1);
    assert.equal(count(db, "settings", "key = 'bootstrap_done'"), 1);
    assert.ok(s.every((x) => x.workspace_id === "default"));
    assert.equal(count(db, "workspaces", "id = 'default'"), 1);
    const owner = rows(db, "SELECT email, instance_admin FROM users WHERE id = 'owner'")[0];
    assert.equal(owner.email, "owner@example.com");
    assert.equal(owner.instance_admin, 1);
    assert.equal(
      rows(db, "SELECT role FROM memberships WHERE workspace_id = 'default' AND user_id = 'owner'")[0].role,
      "admin",
    );
    assert.equal(rows(db, "SELECT inbox_workspace FROM media_store")[0].inbox_workspace, "default");
    assert.equal(count(db, "api_keys", "name = 'claude-code'"), 1);
    assert.equal(count(db, "api_keys", "user_id = 'owner'"), 1);
    db.close();
  });

  it("puts the media at the items' paths", () => {
    const db = open(first.dbPath);
    for (const i of rows(db, "SELECT folder, name, format FROM plan_items WHERE format != 'text'")) {
      const p =
        i.format === "video"
          ? join(first.mediaDir, "UPLOADS", i.folder, "exports/shorts/instagram", `${i.name}.mp4`)
          : join(first.mediaDir, "UPLOADS", i.folder, i.name);
      assert.ok(existsSync(p), p);
    }
    db.close();
  });

  it("is idempotent: the same rows again, fresh sessions", async () => {
    const again = await seedDemo(tmp, now); // last: it replaces the database the tests above read
    assert.deepEqual(counts(again.dbPath), before1);
    assert.notEqual(again.pwaToken, first.pwaToken);
    assert.notEqual(again.dashboardToken, first.dashboardToken);
  });

  it("ignores the caller's environment: a DATABASE_URL doesn't switch it to Postgres", async () => {
    process.env.DATABASE_URL = "postgres://nope";
    try {
      const r = await seedDemo(tmp, now);
      assert.ok(existsSync(r.dbPath));
      assert.deepEqual(counts(r.dbPath), before1);
    } finally {
      delete process.env.DATABASE_URL;
    }
  });
});
