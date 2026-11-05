// Moving an instance between databases: SQLite → Postgres → SQLite through the neutral export, with nothing lost.
import { join } from "node:path";
import type { Db } from "@bongsu/core/db";
import { pgliteDriver } from "@bongsu/core/pglite";
import { PostgresDb } from "@bongsu/core/postgres";
import { exportData, importData, TransferError } from "@bongsu/schema/transfer";
import { PGlite } from "@electric-sql/pglite";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { SqliteDb } from "../src/db";
import { migrate, migratePostgres } from "../src/migrate";

const MIGRATIONS = join(__dirname, "../../../migrations");

const sqliteDb = () => {
  const db = new SqliteDb(new Database(":memory:"));
  db.sqlite.pragma("foreign_keys = ON");
  migrate(db, join(MIGRATIONS, "sqlite"));
  return db;
};
const postgresDb = async () => {
  const driver = pgliteDriver(new PGlite());
  await migratePostgres(driver, join(MIGRATIONS, "postgres"));
  return new PostgresDb(driver);
};

/** An instance with a bit of everything: people, a connection and accounts, a plan item, a job, audit rows (serial
 *  ids), approvals, rate limits ("window"), results (a real number), booleans and JSON. */
async function fill(db: Db) {
  const s = (sql: string, ...v: unknown[]) => db.prepare(sql).bind(...v);
  await db.batch([
    // a fresh database has no workspace or user (0018): the instance's own
    s("INSERT INTO workspaces (id, name, created_at) VALUES ('default', 'Default', 0)"),
    s(
      "INSERT INTO workspace_settings (workspace_id, timezone, digest_hour, locale, media_folder, updated_at) VALUES ('default', 'Asia/Seoul', 8, 'en', 'UPLOADS', 0)",
    ),
    s(
      "INSERT INTO users (id, email, name, created_at, instance_admin) VALUES ('owner', 'owner@example.com', 'Owner', 0, 1)",
    ),
    s("INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES ('default', 'owner', 'admin', 0)"),
    s("INSERT INTO users (id, email, name, created_at) VALUES ('bea', 'bea@example.com', 'Bea', 5)"),
    s("INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES ('default', 'bea', 'editor', 5)"),
    s(
      "INSERT INTO connections (id, workspace_id, provider, kind, label, credentials, status, created_at, updated_at) VALUES ('c1', 'default', 'instagram', 'oauth', '@a', 'v1:x:y', 'ok', 1, 2)",
    ),
    s(
      "INSERT INTO accounts (id, workspace_id, platform, handle, connection_id, capabilities, settings, created_at, updated_at) VALUES ('a', 'default', 'instagram', 'a', 'c1', ?1, '{}', 1, 2)",
      JSON.stringify({ trialReels: true }),
    ),
    s(
      "INSERT INTO plan_items (item_key, format, account, folder, name, due_at, options, hold, created_at, updated_at) VALUES ('reel:p/a', 'video', 'a', 'p', 'a', 1800000000, ?1, 1, 1, 2)",
      JSON.stringify({ trial: false }),
    ),
    s(
      "INSERT INTO jobs (item_key, kind, account, due_at, created_at, updated_at, dry_run) VALUES ('reel:p/a', 'video', 'a', 1800000000, 1, 2, 0)",
    ),
    s("INSERT INTO audit (at, actor, action, target, detail) VALUES (10, 'cron', 'notify', NULL, '{\"t\":1}')"),
    s("INSERT INTO audit (at, actor, action, target, detail) VALUES (11, 'user:owner', 'settings', 'x', NULL)"),
    s(
      "INSERT INTO approvals (item_key, media, approved_at, approved_by, due_at) VALUES ('reel:p/a', '[]', '2026-10-20T09:00:00Z', 'owner@app', 1800000000)",
    ),
    s("INSERT INTO rate_limits (key_id, \"window\", n) VALUES ('k', 29000000, 3)"),
    s(
      "INSERT INTO post_results (item_key, account, media_id, median_views, fetched_at) VALUES ('reel:p/a', 'a', 'm1', 87.5, 3)",
    ),
  ]);
}

const tablesOf = (e: Awaited<ReturnType<typeof exportData>>) => JSON.parse(JSON.stringify(e.tables));

describe("export and import between databases", () => {
  it("SQLite → Postgres → SQLite keeps every row, and Postgres numbers new ids after the imported ones", async () => {
    const source = sqliteDb();
    await fill(source);
    const first = await exportData(source);
    expect(first.tables.audit).toHaveLength(2);

    const pg = await postgresDb();
    const counts = await importData(pg, first);
    expect(counts).toMatchObject({ audit: 2, accounts: 1, users: 2, rate_limits: 1 });
    const fromPg = await exportData(pg);
    expect(tablesOf(fromPg)).toEqual(tablesOf(first));
    await pg.prepare("INSERT INTO audit (at, actor, action) VALUES (12, 'cron', 'x')").run();
    expect((await pg.prepare("SELECT MAX(id) AS id FROM audit").first<{ id: number }>())?.id).toBe(3);

    const back = sqliteDb();
    await importData(back, fromPg);
    expect(tablesOf(await exportData(back))).toEqual(tablesOf(fromPg));
  });

  it("refuses a database that already has data, and an export of another schema", async () => {
    const source = sqliteDb();
    await fill(source);
    const data = await exportData(source);
    await expect(importData(source, data)).rejects.toThrow(TransferError);
    await expect(importData(sqliteDb(), { ...data, schema: "0001_other" })).rejects.toThrow(/schema 0001_other/);
    await expect(importData(sqliteDb(), { nope: true } as never)).rejects.toThrow(/not a Bongsu export/);
  });
});
