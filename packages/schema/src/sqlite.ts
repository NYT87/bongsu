// SQLite (D1 on Cloudflare, better-sqlite3 on Node): the neutral types on SQLite's storage classes.
import { type Dialect, schemaSql } from "./ddl";
import { TABLES } from "./tables";
import type { Tables } from "./types";

export const sqlite: Dialect = {
  name: "sqlite",
  type: {
    id: "TEXT",
    text: "TEXT",
    json: "TEXT",
    int: "INTEGER",
    bigint: "INTEGER",
    real: "REAL",
    bool: "INTEGER",
    timestamp: "INTEGER",
    serial: "INTEGER",
  },
  now: "(unixepoch())",
  // SQLite needs quotes only for reserved words; plain names keep the generated SQL as readable as the hand-written
  quote: (n) => (/^(window|order|group|key)$/i.test(n) ? `"${n}"` : n),
  serial: "INTEGER PRIMARY KEY",
};

export const sqliteSchema = (tables: Tables = TABLES) => schemaSql(sqlite, tables);
