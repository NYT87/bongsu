// The Db port on Postgres, for any driver: postgres.js on Node, PGlite in the tests. The driver only runs a query
// with $1-style parameters and opens transactions; this file speaks D1's shape over it: `?1` placeholders become `$1`
// (outside quoted strings), booleans bind as 0/1 like on SQLite, and `batch` is one transaction.
import type { Db, DbResult, DbStatement } from "./db";

/** What a Postgres driver gives this adapter. Rows must come back with 64-bit integers as numbers. */
export interface PgDriver {
  query(sql: string, params: unknown[]): Promise<Record<string, unknown>[]>;
  /** Several statements at once, without parameters (a migration file). */
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: Pick<PgDriver, "query" | "exec">) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** `?1` → `$1`, leaving quoted strings and identifiers alone. */
export function toPgParams(sql: string): string {
  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (quote) {
      out += ch;
      if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      out += ch;
    } else if (ch === "?" && /\d/.test(sql[i + 1] ?? "")) out += "$";
    else out += ch;
  }
  return out;
}

const toPg = (v: unknown) => (typeof v === "boolean" ? (v ? 1 : 0) : v === undefined ? null : v);

class Statement implements DbStatement {
  constructor(
    private readonly driver: Pick<PgDriver, "query">,
    private readonly sql: string,
    private readonly values: unknown[] = [],
  ) {}
  bind(...values: unknown[]): DbStatement {
    return new Statement(this.driver, this.sql, values);
  }
  exec<T>(driver: Pick<PgDriver, "query"> = this.driver): Promise<T[]> {
    return driver.query(toPgParams(this.sql), this.values.map(toPg)) as Promise<T[]>;
  }
  async first<T = Record<string, unknown>>(): Promise<T | null> {
    return (await this.exec<T>())[0] ?? null;
  }
  async all<T = Record<string, unknown>>(): Promise<DbResult<T>> {
    return { results: await this.exec<T>() };
  }
  async run<T = Record<string, unknown>>(): Promise<DbResult<T>> {
    return { results: await this.exec<T>() };
  }
}

export class PostgresDb implements Db {
  readonly dialect = "postgres" as const;
  constructor(private readonly driver: PgDriver) {}
  prepare(sql: string): DbStatement {
    return new Statement(this.driver, sql);
  }
  batch<T = unknown>(statements: DbStatement[]): Promise<DbResult<T>[]> {
    return this.driver.transaction(async (tx) => {
      const out: DbResult<T>[] = [];
      for (const s of statements) out.push({ results: await (s as Statement).exec<T>(tx) });
      return out;
    });
  }
}
