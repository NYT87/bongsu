// PGlite (Postgres in WebAssembly, no server) as a PgDriver: for the tests, and for trying Bongsu on Postgres without
// running one. 64-bit integers (COUNT, BIGINT columns) come back as numbers, as on SQLite.
import type { PGlite } from "@electric-sql/pglite";
import type { PgDriver } from "./postgres";

const parsers = { 20: (v: string) => Number(v) };

export function pgliteDriver(pg: PGlite): PgDriver {
  return {
    query: async (sql, params) => (await pg.query<Record<string, unknown>>(sql, params, { parsers })).rows,
    exec: async (sql) => {
      await pg.exec(sql);
    },
    transaction: (fn) =>
      pg.transaction((tx) =>
        fn({
          query: async (sql, params) => (await tx.query<Record<string, unknown>>(sql, params, { parsers })).rows,
          exec: async (sql) => {
            await tx.exec(sql);
          },
        }),
      ),
    close: () => pg.close(),
  };
}
