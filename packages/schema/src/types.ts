// The neutral schema's vocabulary (docs/PLAN.md 2.9): tables described once, without any database's SQL; each
// dialect's generator (sqlite.ts, postgres.ts) turns them into its own DDL.

/**
 * - `id`: a text key (a primary key or a reference to one)
 * - `text`, `int` (32-bit), `bigint`, `real` (a floating-point number)
 * - `bool`: 0 or 1 (the app's SQL compares with 0/1, so it stays an integer everywhere)
 * - `json`: JSON kept as text (read and written whole by the app)
 * - `timestamp`: unix seconds
 * - `serial`: an integer primary key the database numbers itself
 */
export type ColumnType = "id" | "text" | "int" | "bigint" | "real" | "bool" | "json" | "timestamp" | "serial";

/** `NOW`: the current time in unix seconds, as a column default. */
export const NOW = { now: true } as const;

export interface Column {
  type: ColumnType;
  notNull?: boolean;
  primaryKey?: boolean;
  unique?: boolean;
  default?: string | number | typeof NOW;
  /** "table.column" */
  references?: string;
  /** The only values allowed (a check constraint). */
  values?: readonly (string | number)[];
  /** An allowed range, inclusive (a check constraint). */
  between?: readonly [number, number];
  description?: string;
}

export interface Index {
  name: string;
  columns: readonly string[];
  unique?: boolean;
  /** On LOWER(column) for each column: a unique index then ignores case. SQLite and Postgres both index expressions. */
  lower?: boolean;
}

export interface Table {
  description: string;
  columns: Record<string, Column>;
  /** A primary key over several columns (one column: its `primaryKey`). */
  primaryKey?: readonly string[];
  /** Unique keys over several columns (one column: its `unique`). */
  unique?: readonly (readonly string[])[];
  indexes?: readonly Index[];
}

export type Tables = Record<string, Table>;
