// The Db port on Postgres (postgres.ts over PGlite) passes the same conformance cases as D1 and SQLite.
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { dbCases } from "../src/db-conformance";
import { pgliteDriver } from "../src/pglite";
import { PostgresDb, toPgParams } from "../src/postgres";

describe("db conformance: Postgres (PGlite)", () => {
  const db = new PostgresDb(pgliteDriver(new PGlite()));
  for (const c of dbCases(db)) it(c.name, c.run);
});

describe("placeholders", () => {
  it("?N becomes $N, but not inside quoted strings or names", () => {
    expect(toPgParams("SELECT ?1, ?2 WHERE a = '?1' AND \"b?2\" = ?1")).toBe(
      "SELECT $1, $2 WHERE a = '?1' AND \"b?2\" = $1",
    );
  });
});
