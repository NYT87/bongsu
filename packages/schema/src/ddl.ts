// What the dialects share: the order tables are created in (a table after the tables it references) and the shape of
// a CREATE TABLE. Each dialect (sqlite.ts, postgres.ts) supplies its types, defaults and quoting.
import type { Column, ColumnType, Index, Table, Tables } from "./types";

export interface Dialect {
  name: string;
  type: Record<ColumnType, string>;
  /** `NOW` as a column default. */
  now: string;
  quote(name: string): string;
  /** A serial column's whole definition after its name (SQLite: INTEGER PRIMARY KEY; Postgres: an identity). */
  serial: string;
}

const literal = (v: string | number) => (typeof v === "number" ? String(v) : `'${v.replace(/'/g, "''")}'`);

/** Tables in creation order: referenced tables first, otherwise by name. */
export function creationOrder(tables: Tables): string[] {
  const done: string[] = [];
  const visit = (name: string, path: string[]) => {
    if (done.includes(name)) return;
    if (path.includes(name)) throw new Error(`reference cycle: ${[...path, name].join(" → ")}`);
    for (const c of Object.values(tables[name].columns))
      if (c.references) {
        const target = c.references.split(".")[0];
        if (target !== name) visit(target, [...path, name]);
      }
    done.push(name);
  };
  for (const name of Object.keys(tables).sort()) visit(name, []);
  return done;
}

/** One column's definition, as in a CREATE TABLE or an ADD COLUMN. */
export function column(d: Dialect, name: string, c: Column): string {
  if (c.type === "serial") return `${d.quote(name)} ${d.serial}`;
  const parts = [d.quote(name), d.type[c.type]];
  if (c.primaryKey) parts.push("PRIMARY KEY");
  if (c.notNull) parts.push("NOT NULL");
  if (c.unique) parts.push("UNIQUE");
  if (c.default !== undefined) parts.push(`DEFAULT ${typeof c.default === "object" ? d.now : literal(c.default)}`);
  if (c.values) parts.push(`CHECK (${d.quote(name)} IN (${c.values.map(literal).join(", ")}))`);
  if (c.between) parts.push(`CHECK (${d.quote(name)} BETWEEN ${c.between[0]} AND ${c.between[1]})`);
  if (c.references) {
    const [t, col] = c.references.split(".");
    parts.push(`REFERENCES ${d.quote(t)} (${d.quote(col)})`);
  }
  return parts.join(" ");
}

export function createTable(d: Dialect, name: string, t: Table): string[] {
  const lines = Object.entries(t.columns).map(([n, c]) => `  ${column(d, n, c)}`);
  if (t.primaryKey) lines.push(`  PRIMARY KEY (${t.primaryKey.map(d.quote).join(", ")})`);
  for (const u of t.unique ?? []) lines.push(`  UNIQUE (${u.map(d.quote).join(", ")})`);
  const out = [`-- ${t.description}\nCREATE TABLE ${d.quote(name)} (\n${lines.join(",\n")}\n);`];
  for (const ix of t.indexes ?? []) out.push(createIndex(d, name, ix));
  return out;
}

/** A CREATE INDEX: on the columns, or on LOWER(column) for an index that ignores case. */
export function createIndex(d: Dialect, table: string, ix: Index): string {
  const cols = ix.columns.map((c) => (ix.lower ? `LOWER(${d.quote(c)})` : d.quote(c)));
  return `CREATE ${ix.unique ? "UNIQUE " : ""}INDEX ${d.quote(ix.name)} ON ${d.quote(table)} (${cols.join(", ")});`;
}

/** The DDL for a fresh database with every table. */
export function schemaSql(d: Dialect, tables: Tables): string {
  return `${creationOrder(tables)
    .flatMap((n) => createTable(d, n, tables[n]))
    .join("\n\n")}\n`;
}
