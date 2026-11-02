// The Db port (core/db.ts) on Node: better-sqlite3 wrapped to D1's shape. Calls are synchronous underneath and
// returned as promises; `batch` is one transaction, so a failing statement undoes the others, as on D1.

import type { Db, DbResult, DbStatement } from "@bongsu/core/db";
import Database from "better-sqlite3";

type Sqlite = Database.Database;
const NUMBERED = /\?\d/;

class Statement implements DbStatement {
  constructor(
    private readonly sqlite: Sqlite,
    private readonly sql: string,
    private readonly values: unknown[] = [],
  ) {}

  bind(...values: unknown[]): DbStatement {
    return new Statement(this.sqlite, this.sql, values);
  }

  /** Runs now; the rows when the statement returns any (a SELECT, or RETURNING), else none. */
  exec<T>(): T[] {
    const st = this.sqlite.prepare(this.sql);
    const values = this.values.map(toSqlite);
    // D1's numbered parameters (?1, ?2, ?1 again): better-sqlite3 binds them from an object keyed by number
    const args = NUMBERED.test(this.sql) ? [Object.fromEntries(values.map((v, i) => [i + 1, v]))] : values;
    if (st.reader) return st.all(...args) as T[];
    st.run(...args);
    return [];
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    return this.exec<T>()[0] ?? null;
  }
  async all<T = Record<string, unknown>>(): Promise<DbResult<T>> {
    return { results: this.exec<T>() };
  }
  async run<T = Record<string, unknown>>(): Promise<DbResult<T>> {
    return { results: this.exec<T>() };
  }
}

/** D1 stores booleans as 1/0; better-sqlite3 refuses them, and undefined, so they're converted here. */
function toSqlite(v: unknown): unknown {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v === undefined) return null;
  if (v instanceof Uint8Array && !Buffer.isBuffer(v)) return Buffer.from(v);
  return v;
}

export class SqliteDb implements Db {
  readonly dialect = "sqlite" as const;
  constructor(readonly sqlite: Sqlite) {}

  /** Opens (or creates) the database file, in WAL mode with foreign keys on, as D1 runs them. */
  static open(path: string): SqliteDb {
    const sqlite = new Database(path);
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
    sqlite.pragma("busy_timeout = 5000");
    return new SqliteDb(sqlite);
  }

  prepare(sql: string): DbStatement {
    return new Statement(this.sqlite, sql);
  }

  async batch<T = unknown>(statements: DbStatement[]): Promise<DbResult<T>[]> {
    return this.sqlite.transaction(() => statements.map((s) => ({ results: (s as Statement).exec<T>() })))();
  }

  close() {
    this.sqlite.close();
  }
}
