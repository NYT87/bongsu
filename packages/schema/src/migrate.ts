// Neutral schema changes: steps any dialect can generate, applied to the tables to know the schema after them.
import { column, createIndex, createTable, type Dialect } from "./ddl";
import type { Column, Index, Table, Tables } from "./types";

export type Step =
  | { createTable: string; table: Table }
  | { addColumn: { table: string; name: string; column: Column } }
  | { createIndex: { table: string; index: Index } }
  | { dropIndex: { table: string; name: string } }
  /** Anything else, written per dialect (data changes, a rebuild SQLite needs): use sparingly. */
  | { sql: Record<string, string>; apply?: (t: Tables) => void };

/** A migration: the baseline's full schema (with its seed rows, as portable INSERTs), or the steps after it. `name`
 *  is the file name without `.sql`. */
export type Migration = { name: string; baseline: Tables; seed?: string[] } | { name: string; steps: Step[] };

const clone = (t: Tables): Tables => structuredClone(t);

/** The schema after the migrations, in order. */
export function applyMigrations(migrations: Migration[]): Tables {
  let tables: Tables = {};
  for (const m of migrations) {
    if ("baseline" in m) {
      tables = clone(m.baseline);
      continue;
    }
    for (const s of m.steps) applyStep(tables, s);
  }
  return tables;
}

function applyStep(tables: Tables, s: Step) {
  if ("createTable" in s) {
    if (tables[s.createTable]) throw new Error(`table ${s.createTable} exists`);
    tables[s.createTable] = clone({ t: s.table }).t as Table;
  } else if ("addColumn" in s) {
    const t = tables[s.addColumn.table];
    if (!t || t.columns[s.addColumn.name]) throw new Error(`can't add ${s.addColumn.table}.${s.addColumn.name}`);
    t.columns[s.addColumn.name] = s.addColumn.column;
  } else if ("createIndex" in s) {
    const t = tables[s.createIndex.table];
    t.indexes = [...(t.indexes ?? []), s.createIndex.index];
  } else if ("dropIndex" in s) {
    const t = tables[s.dropIndex.table];
    t.indexes = (t.indexes ?? []).filter((i) => i.name !== s.dropIndex.name);
  } else s.apply?.(tables);
}

/** A migration's SQL in one dialect. */
export function migrationSql(d: Dialect, m: Migration, before: Tables): string {
  if ("baseline" in m) throw new Error("the baseline is generated whole (schemaSql)");
  const out: string[] = [];
  const tables = clone(before);
  for (const s of m.steps) {
    if ("createTable" in s) out.push(...createTable(d, s.createTable, s.table));
    else if ("addColumn" in s)
      out.push(
        `ALTER TABLE ${d.quote(s.addColumn.table)} ADD COLUMN ${column(d, s.addColumn.name, s.addColumn.column)};`,
      );
    else if ("createIndex" in s) out.push(createIndex(d, s.createIndex.table, s.createIndex.index));
    else if ("dropIndex" in s) out.push(`DROP INDEX ${d.quote(s.dropIndex.name)};`);
    else {
      const sql = s.sql[d.name];
      if (sql === undefined) throw new Error(`${m.name}: no ${d.name} SQL for a custom step`);
      out.push(sql);
    }
    applyStep(tables, s);
  }
  return `${out.join("\n")}\n`;
}
