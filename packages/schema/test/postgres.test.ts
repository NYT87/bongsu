// The neutral schema on Postgres: the generated DDL builds every table in PGlite (Postgres in WebAssembly, no server),
// with the same columns, keys and checks as on SQLite.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { TABLES } from "../src/tables";

const SQL_DIR = join(__dirname, "../../../migrations/postgres");
/** A database built the way a real Postgres is: migrations/postgres/*.sql in order (`until`: only the files below it). */
async function fresh(until?: string) {
  const pg = new PGlite();
  for (const f of readdirSync(SQL_DIR)
    .filter((f) => f.endsWith(".sql") && (!until || f < until))
    .sort())
    await pg.exec(readFileSync(join(SQL_DIR, f), "utf8"));
  return pg;
}

describe("the neutral schema on Postgres (PGlite)", () => {
  it("creates every table and column, in an order Postgres accepts", async () => {
    const pg = await fresh();
    const cols = await pg.query<{ table_name: string; column_name: string; is_nullable: string }>(
      `SELECT table_name, column_name, is_nullable FROM information_schema.columns
       WHERE table_schema = 'public' ORDER BY table_name, ordinal_position`,
    );
    const got: Record<string, string[]> = {};
    for (const r of cols.rows) got[r.table_name] = [...(got[r.table_name] ?? []), r.column_name];
    const want = Object.fromEntries(Object.entries(TABLES).map(([n, t]) => [n, Object.keys(t.columns)]));
    expect(got).toEqual(want);
    // NOT NULL as declared
    for (const r of cols.rows) {
      const c = TABLES[r.table_name].columns[r.column_name];
      expect(`${r.table_name}.${r.column_name} ${r.is_nullable}`).toBe(
        `${r.table_name}.${r.column_name} ${c.notNull || c.primaryKey || c.type === "serial" || TABLES[r.table_name].primaryKey?.includes(r.column_name) ? "NO" : "YES"}`,
      );
    }
    await pg.close();
  });

  it("keeps the rules: checks, references, defaults (now in unix seconds), serial ids", async () => {
    const pg = await fresh();
    await pg.exec("INSERT INTO workspaces (id, name, created_at) VALUES ('w', 'W', 0)");
    await expect(
      pg.exec(
        "INSERT INTO workspace_settings (workspace_id, timezone, digest_hour, locale, updated_at) VALUES ('w', 'UTC', 25, 'en', 0)",
      ),
    ).rejects.toThrow(/check/i); // digest_hour BETWEEN 0 AND 23
    await expect(
      pg.exec("INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES ('nope', 'x', 'owner', 0)"),
    ).rejects.toThrow(/foreign key/i);
    await pg.exec(`INSERT INTO audit (actor, action) VALUES ('cron', 'a'), ('cron', 'b')`);
    const r = await pg.query<{ id: string; at: string }>(`SELECT id, at FROM audit ORDER BY id`);
    expect(r.rows.map((x) => Number(x.id))).toEqual([1, 2]);
    expect(Math.abs(Number(r.rows[0].at) - Date.now() / 1000)).toBeLessThan(60);
    // a reserved word as a column name works, quoted
    await pg.exec(`INSERT INTO rate_limits (key_id, "window", n) VALUES ('k', 1, 1)`);
    await pg.close();
  });

  it("has the metrics series and a post_results without the counts", async () => {
    const pg = await fresh();
    const cols = async (t: string) =>
      (
        await pg.query<{ column_name: string }>(
          `SELECT column_name FROM information_schema.columns WHERE table_name = '${t}' ORDER BY ordinal_position`,
        )
      ).rows.map((r) => r.column_name);
    expect(await cols("post_metrics")).toEqual([
      "id",
      "item_key",
      "account",
      "platform",
      "media_id",
      "taken_at",
      "views",
      "reach",
      "likes",
      "comments",
      "saves",
      "shares",
      "workspace_id",
      "follows",
      "profile_visits",
    ]);
    expect(await cols("post_results")).not.toContain("views");
    await pg.close();
  });

  it("carries an earlier 24 h result into the series as the post's first sample", async () => {
    const pg = await fresh("0011");
    await pg.exec(`INSERT INTO post_results (item_key, account, media_id, views, reach, likes, comments, saves, shares,
      median_views, fetched_at, workspace_id) VALUES ('a', 'demo_travel', 'm1', 100, 80, 9, 2, 1, 0, 50, 1700000000, 'b')`);
    await pg.exec(readFileSync(join(SQL_DIR, "0011_post_metrics.sql"), "utf8"));
    const r = await pg.query<Record<string, unknown>>(
      "SELECT item_key, account, platform, media_id, taken_at, views, reach, likes, comments, saves, shares, workspace_id FROM post_metrics",
    );
    expect(r.rows.map((x) => ({ ...x, taken_at: Number(x.taken_at) }))).toEqual([
      {
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
    await pg.close();
  });
});

describe("0012_post_metrics_followers", () => {
  it("on Postgres: post_metrics gains follows and profile_visits, both optional", async () => {
    const pg = await fresh();
    await pg.exec(`INSERT INTO post_metrics (item_key, account, platform, media_id, taken_at, views, workspace_id)
      VALUES ('a', 'demo_travel', 'instagram', 'm1', 1700000000, 5, 'default')`);
    const r = await pg.query<{ follows: number | null; profile_visits: number | null }>(
      "SELECT follows, profile_visits FROM post_metrics",
    );
    expect(r.rows).toEqual([{ follows: null, profile_visits: null }]);
    await pg.close();
  });
});

describe("0013_account_metrics", () => {
  it("on Postgres: the account series accepts a sample without a count", async () => {
    const pg = await fresh();
    await pg.exec(`INSERT INTO account_metrics (account, platform, taken_at, workspace_id)
      VALUES ('demo_travel', 'instagram', 1700000000, 'default')`);
    const r = await pg.query<{ followers: number | null }>("SELECT followers FROM account_metrics");
    expect(r.rows).toEqual([{ followers: null }]);
    await pg.close();
  });
});

describe("0014_drop_labels_manual_stats", () => {
  it("on Postgres: the unused stats tables are gone", async () => {
    const pg = await fresh();
    const r = await pg.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_name IN ('labels', 'manual_stats')",
    );
    expect(r.rows).toEqual([]);
    await pg.close();
  });
});
