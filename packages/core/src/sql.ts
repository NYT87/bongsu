// The few SQL bits that differ between databases (docs/PLAN.md 2.9). Everything else the code writes is in the subset
// SQLite and Postgres share; a test (core/test/portable-sql.test.ts) keeps it that way.
import type { Db } from "./db";

export const dialectOf = (db: Db) => db.dialect ?? "sqlite";

/** The values of a JSON array parameter, as a subquery: `item_key IN ${jsonList(db, 1)}` with `?1` bound to
 *  JSON.stringify(keys). One parameter for any number of values. */
export function jsonList(db: Db, param: number): string {
  return dialectOf(db) === "postgres"
    ? // the parameter is text, turned into JSON here: drivers that see a json parameter encode the string again
      `(SELECT json_array_elements_text(CAST(?${param} AS TEXT)::json))`
    : `(SELECT value FROM json_each(?${param}))`;
}

/** The names of the tables in the database. */
export async function tableNames(db: Db): Promise<string[]> {
  const sql =
    dialectOf(db) === "postgres"
      ? "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema()"
      : "SELECT name FROM sqlite_master WHERE type = 'table'";
  return (await db.prepare(sql).all<{ name: string }>()).results.map((r) => r.name);
}
