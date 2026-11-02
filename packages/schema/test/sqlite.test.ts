// The neutral schema reproduces today's SQLite schema exactly: the database migrations/ builds and the one the
// generated DDL builds are compared by introspection, so existing databases (D1 included) need no change.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { applyMigrations, type Migration, migrationSql } from "../src/migrate";
import { MIGRATIONS } from "../src/migrations/index";
import { postgres, postgresSchema } from "../src/postgres";
import { sqlite, sqliteSchema } from "../src/sqlite";
import { TABLES } from "../src/tables";
import { NOW } from "../src/types";

const SQL_DIR = join(__dirname, "../../../migrations/sqlite");

/** A database built from migrations/sqlite/*.sql in order; `until` stops before the first file not below it. */
function fromMigrations(until?: string) {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = OFF");
  for (const f of readdirSync(SQL_DIR)
    .filter((f) => /^\d+_.+\.sql$/.test(f) && (!until || f < until))
    .sort())
    db.exec(readFileSync(join(SQL_DIR, f), "utf8"));
  return db;
}

/** The CHECK expressions in a CREATE TABLE, whitespace and quotes normalized. */
function checks(sql: string): string[] {
  const out: string[] = [];
  for (let i = sql.indexOf("CHECK ("); i >= 0; i = sql.indexOf("CHECK (", i + 1)) {
    let depth = 0;
    let j = i + 6;
    do {
      if (sql[j] === "(") depth++;
      if (sql[j] === ")") depth--;
      j++;
    } while (depth > 0);
    out.push(
      sql
        .slice(i + 6, j)
        .replace(/\s+/g, " ")
        .replace(/"/g, ""),
    );
  }
  return out.sort();
}

type Db = InstanceType<typeof Database>;
function introspect(db: Db) {
  const tables = db
    .prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'd1_migrations'",
    )
    .all() as { name: string; sql: string }[];
  return Object.fromEntries(
    tables
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((t) => {
        const indexes = (db.pragma(`index_list("${t.name}")`) as { name: string; unique: number; origin: string }[])
          .map((ix) => ({
            // automatic indexes (UNIQUE, composite PRIMARY KEY) are compared by their columns, not their names
            name: ix.origin === "c" ? ix.name : ix.origin,
            unique: ix.unique,
            columns: (db.pragma(`index_info("${ix.name}")`) as { name: string }[]).map((c) => c.name),
          }))
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
        return [
          t.name,
          {
            columns: db.pragma(`table_info("${t.name}")`),
            foreignKeys: (db.pragma(`foreign_key_list("${t.name}")`) as Record<string, unknown>[])
              .map(({ table, from, to }) => ({ table, from, to }))
              .sort((a, b) => String(a.from).localeCompare(String(b.from))),
            indexes,
            checks: checks(t.sql),
          },
        ];
      }),
  );
}

describe("the neutral schema on SQLite", () => {
  it("builds the same tables, columns, keys, indexes and checks as migrations/", () => {
    const generated = new Database(":memory:");
    generated.exec(sqliteSchema());
    const want = introspect(fromMigrations());
    const got = introspect(generated);
    expect(Object.keys(got)).toEqual(Object.keys(want));
    for (const name of Object.keys(want)) expect({ [name]: got[name] }).toEqual({ [name]: want[name] });
  });

  it("describes every table", () => {
    for (const [name, t] of Object.entries(TABLES)) expect(t.description.length, name).toBeGreaterThan(10);
  });
});

describe("a neutral migration after the baseline", () => {
  const sample: Migration = {
    name: "0010_sample",
    steps: [
      {
        createTable: "sample_notes",
        table: {
          description: "A sample table",
          columns: {
            id: { type: "serial" },
            workspace_id: { type: "id", notNull: true, references: "workspaces.id" },
            body: { type: "text", notNull: true, default: "" },
            at: { type: "timestamp", notNull: true, default: NOW },
          },
          indexes: [{ name: "sample_notes_ws", columns: ["workspace_id", "at"] }],
        },
      },
      { addColumn: { table: "users", name: "locale", column: { type: "text", values: ["en", "es", "ko"] } } },
      { createIndex: { table: "posted", index: { name: "posted_media", columns: ["media_id"] } } },
    ],
  };
  const after = applyMigrations([...MIGRATIONS, sample]);

  it("on SQLite: today's database plus the generated steps equals the schema after them", () => {
    const db = fromMigrations();
    db.exec(migrationSql(sqlite, sample, TABLES));
    const fresh = new Database(":memory:");
    fresh.exec(sqliteSchema(after));
    expect(introspect(db)).toEqual(introspect(fresh));
  });

  it("on Postgres: the baseline plus the generated steps applies", async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const pg = new PGlite();
    await pg.exec(postgresSchema(TABLES));
    await pg.exec(migrationSql(postgres, sample, TABLES));
    await pg.exec(`INSERT INTO workspaces (id, name, created_at) VALUES ('w', 'W', 0)`);
    await pg.exec(`INSERT INTO sample_notes (workspace_id) VALUES ('w')`);
    const r = await pg.query<{ body: string }>(`SELECT body FROM sample_notes`);
    expect(r.rows).toEqual([{ body: "" }]);
    await pg.close();
  });
});

describe("0011_post_metrics", () => {
  const counts = ["views", "reach", "likes", "comments", "saves", "shares"];
  it("on SQLite: the series table exists, post_results lost its counts and kept its rows", () => {
    const db = fromMigrations();
    const cols = (t: string) => (db.pragma(`table_info("${t}")`) as { name: string }[]).map((c) => c.name);
    expect(cols("post_metrics")).toEqual([
      "id",
      "item_key",
      "account",
      "platform",
      "media_id",
      "taken_at",
      ...counts,
      "workspace_id",
      "follows",
      "profile_visits",
    ]);
    expect(cols("post_results")).toEqual([
      "item_key",
      "account",
      "media_id",
      "median_views",
      "fetched_at",
      "workspace_id",
    ]);
  });

  it("on SQLite: an earlier 24 h result becomes the post's first sample", () => {
    const db = fromMigrations("0011");
    db.exec(`INSERT INTO post_results (item_key, account, media_id, views, reach, likes, comments, saves, shares,
      median_views, fetched_at, workspace_id) VALUES ('a', 'demo_travel', 'm1', 100, 80, 9, 2, 1, 0, 50, 1700000000, 'b')`);
    db.exec(readFileSync(join(SQL_DIR, "0011_post_metrics.sql"), "utf8"));
    expect(db.prepare("SELECT * FROM post_metrics").all()).toEqual([
      {
        id: 1,
        item_key: "a",
        account: "demo_travel",
        platform: "instagram",
        media_id: "m1",
        taken_at: 1700000000,
        views: 100,
        reach: 80,
        likes: 9,
        comments: 2,
        saves: 1,
        shares: 0,
        workspace_id: "b",
      },
    ]);
    expect(db.prepare("SELECT item_key, median_views, fetched_at FROM post_results").all()).toEqual([
      { item_key: "a", median_views: 50, fetched_at: 1700000000 },
    ]);
  });
});

describe("0012_post_metrics_followers", () => {
  it("on SQLite: post_metrics gains follows and profile_visits, both optional", () => {
    const db = fromMigrations();
    const cols = (db.pragma('table_info("post_metrics")') as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(["follows", "profile_visits"]));
    db.exec(`INSERT INTO post_metrics (item_key, account, platform, media_id, taken_at, views, workspace_id)
      VALUES ('a', 'demo_travel', 'instagram', 'm1', 1700000000, 5, 'default')`);
    expect(db.prepare("SELECT follows, profile_visits FROM post_metrics").get()).toEqual({
      follows: null,
      profile_visits: null,
    });
  });
});

describe("0013_account_metrics", () => {
  it("on SQLite: the account series", () => {
    const db = fromMigrations();
    const cols = (db.pragma('table_info("account_metrics")') as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(["id", "account", "platform", "taken_at", "followers", "workspace_id"]);
  });
});

describe("0014_drop_labels_manual_stats", () => {
  it("on SQLite: the unused stats tables are gone", () => {
    const db = fromMigrations();
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(
      (t) => t.name,
    );
    expect(tables).not.toContain("labels");
    expect(tables).not.toContain("manual_stats");
  });
});
