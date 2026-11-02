// The database port: the subset of Cloudflare D1's API that Bongsu uses. D1 satisfies it as it is; other runtimes
// (SQLite on Node) wrap their driver to the same shape. Core code types its database as `Db`, never as D1Database.

export interface DbResult<T> {
  results: T[];
}

export interface DbStatement {
  bind(...values: unknown[]): DbStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<DbResult<T>>;
  run<T = Record<string, unknown>>(): Promise<DbResult<T>>;
}

export interface Db {
  /** Which SQL the database speaks; absent means SQLite (D1 as Cloudflare gives it). Dialect-specific bits go
   *  through sql.ts. */
  readonly dialect?: "sqlite" | "postgres";
  prepare(sql: string): DbStatement;
  /** Runs the statements in one transaction, in order. */
  batch<T = unknown>(statements: DbStatement[]): Promise<DbResult<T>[]>;
}
