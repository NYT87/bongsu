// Moving an instance between databases (docs/databases.md): every table to one neutral JSON file, and back, on any
// database the Db port reaches (SQLite, D1, Postgres). Tables go in creation order, so references load after what
// they point at; the file names the schema version, and an import refuses another.
import type { Db } from "@bongsu/core/db";
import { dialectOf } from "@bongsu/core/sql";
import { creationOrder } from "./ddl";
import { MIGRATIONS } from "./migrations/index";
import { TABLES } from "./tables";
import type { Tables } from "./types";

export const FORMAT = "bongsu-export";

export interface Export {
  format: typeof FORMAT;
  version: 1;
  /** The last neutral migration the data fits. */
  schema: string;
  exportedAt: string;
  tables: Record<string, Record<string, unknown>[]>;
}

export class TransferError extends Error {}

const q = (n: string) => `"${n}"`;
const SCHEMA = MIGRATIONS[MIGRATIONS.length - 1].name;

export async function exportData(db: Db, now = new Date(), tables: Tables = TABLES): Promise<Export> {
  const out: Export["tables"] = {};
  for (const name of creationOrder(tables)) {
    const cols = Object.keys(tables[name].columns);
    const key = tables[name].primaryKey ?? cols.filter((c) => tables[name].columns[c].primaryKey);
    const order = key.length ? ` ORDER BY ${key.map(q).join(", ")}` : "";
    out[name] = (await db.prepare(`SELECT ${cols.map(q).join(", ")} FROM ${q(name)}${order}`).all()).results;
  }
  return { format: FORMAT, version: 1, schema: SCHEMA, exportedAt: now.toISOString(), tables: out };
}

/** The rows a fresh database starts with (the baseline's seed): an import replaces them. */
const SEEDED = new Set(["workspaces", "workspace_settings", "users", "memberships"]);

/** Loads an export into a migrated database that holds nothing but its seed rows; all or nothing. Returns the rows
 *  loaded per table. */
export async function importData(db: Db, data: Export, tables: Tables = TABLES): Promise<Record<string, number>> {
  if (data?.format !== FORMAT || data.version !== 1) throw new TransferError("not a Bongsu export (bongsu-export, v1)");
  if (data.schema !== SCHEMA)
    throw new TransferError(`the export is for schema ${data.schema}; this database is at ${SCHEMA}`);
  for (const name of Object.keys(data.tables))
    if (!tables[name]) throw new TransferError(`the export has a table this schema doesn't: ${name}`);
  const order = creationOrder(tables);
  for (const name of order) {
    if (SEEDED.has(name)) continue;
    const n = await db.prepare(`SELECT COUNT(*) AS n FROM ${q(name)}`).first<{ n: number }>();
    if (n?.n) throw new TransferError(`${name} already has rows: import into a fresh database`);
  }
  const statements = [...order].reverse().map((name) => db.prepare(`DELETE FROM ${q(name)}`));
  const counts: Record<string, number> = {};
  for (const name of order) {
    const rows = data.tables[name] ?? [];
    const cols = Object.keys(tables[name].columns);
    for (const row of rows) {
      const present = cols.filter((c) => c in row);
      statements.push(
        db
          .prepare(
            `INSERT INTO ${q(name)} (${present.map(q).join(", ")}) VALUES (${present.map((_, i) => `?${i + 1}`).join(", ")})`,
          )
          .bind(...present.map((c) => row[c] ?? null)),
      );
    }
    counts[name] = rows.length;
    // Postgres numbers serial ids from a sequence: start it after the ids just loaded
    if (dialectOf(db) === "postgres")
      for (const [col, c] of Object.entries(tables[name].columns))
        if (c.type === "serial")
          statements.push(
            db.prepare(
              `SELECT setval(pg_get_serial_sequence('${q(name)}', '${col}'), COALESCE((SELECT MAX(${q(col)}) FROM ${q(name)}), 0) + 1, false)`,
            ),
          );
  }
  await db.batch(statements);
  return counts;
}
