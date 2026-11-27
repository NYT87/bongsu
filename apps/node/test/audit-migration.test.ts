// Migration 0028 (#142) on both databases: audit rows from before, which named people by email, come out naming them
// by id. Its SQL is run again on rows written the old way, after the full set of migrations built the schema.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pgliteDriver } from "@bongsu/core/pglite";
import { PGlite } from "@electric-sql/pglite";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { SqliteDb } from "../src/db";
import { migrate, migratePostgres } from "../src/migrate";

const root = join(import.meta.dirname, "../../../migrations");
const sql = (dialect: string) => readFileSync(join(root, dialect, "0028_audit_no_emails.sql"), "utf8");

/** The rows as they were written before: an invite by its email, the bootstrap with it, a workspace for an email. */
const OLD = [
  "INSERT INTO workspaces (id, name, created_at) VALUES ('w1', 'Demo Travel', 0)",
  "INSERT INTO users (id, email, name, created_at) VALUES ('u_ben', 'ben@example.com', 'Ben', 0)",
  `INSERT INTO invites (token_hash, workspace_id, email, role, invited_by, created_at, expires_at)
     VALUES ('abcdef0123456789ffff', 'w1', 'new@example.com', 'editor', 'u_ben', 100, 900)`,
  `INSERT INTO audit (at, actor, action, target, detail, user_id, workspace_id) VALUES
     (101, 'user:u_ben', 'invite_create', 'new@example.com', '{"role":"editor"}', 'u_ben', 'w1'),
     (102, 'user:u_ben', 'invite_revoke', 'gone@example.com', '{"role":"editor"}', 'u_ben', 'w1'),
     (1, 'user:u_ben', 'bootstrap', 'user:u_ben', '{"email":"ben@example.com"}', 'u_ben', NULL),
     (2, 'user:u_ben', 'workspace_create', 'w1', '{"name":"Demo Travel","admin":"ben@example.com"}', 'u_ben', NULL),
     (3, 'user:u_ben', 'workspace_create', 'w2', '{"name":"Other","admin":"stranger@example.com"}', 'u_ben', NULL),
     (4, 'user:u_ben', 'workspace_create', 'w3', '{"name":"Mine","admin":"me"}', 'u_ben', NULL)`,
];

const expected = [
  { action: "invite_create", target: "invite:abcdef0123456789", detail: { role: "editor" } },
  { action: "invite_revoke", target: "invite:?", detail: { role: "editor" } },
  { action: "bootstrap", target: "user:u_ben", detail: {} },
  { action: "workspace_create", target: "w1", detail: { name: "Demo Travel", admin: "user:u_ben" } },
  { action: "workspace_create", target: "w2", detail: { name: "Other", admin: "invite" } },
  { action: "workspace_create", target: "w3", detail: { name: "Mine", admin: "me" } },
];

const shape = (rows: Record<string, unknown>[]) =>
  rows.map((r) => ({ action: r.action, target: r.target, detail: JSON.parse(String(r.detail)) }));

describe("migration 0028: no emails in the audit", () => {
  it("rewrites the old rows on SQLite", () => {
    const db = new SqliteDb(new Database(":memory:"));
    migrate(db, join(root, "sqlite"));
    for (const q of OLD) db.sqlite.exec(q);
    db.sqlite.exec(sql("sqlite"));
    const rows = db.sqlite.prepare("SELECT action, target, detail FROM audit ORDER BY id").all();
    expect(shape(rows as Record<string, unknown>[])).toEqual(expected);
    expect(JSON.stringify(rows)).not.toContain("@");
  });

  it("rewrites the old rows on Postgres", async () => {
    const driver = pgliteDriver(new PGlite());
    await migratePostgres(driver, join(root, "postgres"));
    for (const q of OLD) await driver.exec(q);
    await driver.exec(sql("postgres"));
    const rows = await driver.query("SELECT action, target, detail FROM audit ORDER BY id", []);
    expect(shape(rows)).toEqual(expected);
    expect(JSON.stringify(rows)).not.toContain("@");
  });
});
