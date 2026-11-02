// Postgres on Node (DATABASE_URL=postgres://…): postgres.js as the PgDriver behind core's PostgresDb. 64-bit integers
// (COUNT, the BIGINT timestamps) come back as numbers, as on SQLite.
import type { PgDriver } from "@bongsu/core/postgres";
import postgres from "postgres";

export function postgresDriver(url: string): PgDriver {
  const sql = postgres(url, {
    types: { bigint: { to: 20, from: [20], serialize: (v: unknown) => String(v), parse: (v: string) => Number(v) } },
    onnotice: () => {},
  });
  const on = (s: postgres.Sql | postgres.TransactionSql): Pick<PgDriver, "query" | "exec"> => ({
    query: async (q, params) =>
      (await s.unsafe(q, params as postgres.ParameterOrJSON<never>[])) as Record<string, unknown>[],
    exec: async (q) => {
      await s.unsafe(q);
    },
  });
  return {
    ...on(sql),
    transaction: (fn) => sql.begin((tx) => fn(on(tx))) as ReturnType<typeof fn>,
    close: () => sql.end({ timeout: 5 }),
  };
}
