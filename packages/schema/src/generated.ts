// Everything generated from the neutral schema, by repository path: the dialects' migrations, docs/schema.md and
// packages/schema/schema.json. `pnpm --filter @bongsu/schema generate` writes them; a test fails when one is stale.
import { type Dialect, schemaSql } from "./ddl";
import { applyMigrations, migrationSql } from "./migrate";
import { MIGRATIONS } from "./migrations/index";
import { postgres } from "./postgres";
import { sqlite } from "./sqlite";
import { TABLES } from "./tables";
import type { Column, Tables } from "./types";

const HEADER = "-- Generated from packages/schema (pnpm --filter @bongsu/schema generate): don't edit by hand.\n\n";

export function generatedFiles(): Record<string, string> {
  const files: Record<string, string> = {};
  MIGRATIONS.forEach((m, i) => {
    if ("baseline" in m) {
      // SQLite keeps the hand-written history (migrations/sqlite/0001…0009) that built it; Postgres starts here
      files[`migrations/postgres/${m.name}.sql`] =
        HEADER + schemaSql(postgres, m.baseline) + (m.seed?.length ? `\n${m.seed.join("\n")}\n` : "");
      return;
    }
    const before = applyMigrations(MIGRATIONS.slice(0, i));
    for (const d of [sqlite, postgres] as Dialect[])
      files[`migrations/${d.name}/${m.name}.sql`] = HEADER + migrationSql(d, m, before);
  });
  files["docs/schema.md"] = schemaDoc(TABLES);
  files["packages/schema/schema.json"] = `${JSON.stringify(schemaJson(TABLES), null, 2)}\n`;
  return files;
}

const typeName = (c: Column) =>
  c.type === "serial" ? "serial" : c.values ? `${c.type}: ${c.values.join(" / ")}` : c.type;

const defaultOf = (c: Column) =>
  c.default === undefined ? "" : typeof c.default === "object" ? "now" : JSON.stringify(c.default);

/** The schema as data, for other tools: NOW becomes {"now": true}. */
export const schemaJson = (tables: Tables) => ({ $comment: "Generated from packages/schema: don't edit.", tables });

export function schemaDoc(tables: Tables): string {
  const out = [
    "# Database schema",
    "",
    "Generated from the neutral schema in `packages/schema` (`pnpm --filter @bongsu/schema generate`): don't edit by",
    "hand. The same tables exist on every database; `migrations/sqlite/` and `migrations/postgres/` build them. Types:",
    "`id` (a text key), `text`, `int`, `bigint`, `real`, `bool` (0 or 1), `json` (JSON as text), `timestamp` (unix",
    "seconds), `serial` (numbered by the database). [databases.md](databases.md) explains choosing a database.",
    "",
  ];
  for (const name of Object.keys(tables).sort()) {
    const t = tables[name];
    out.push(`## \`${name}\``, "", t.description, "");
    out.push("| Column | Type | Null | Default | Notes |", "|---|---|---|---|---|");
    for (const [cn, c] of Object.entries(t.columns)) {
      const notes = [
        c.primaryKey || t.primaryKey?.includes(cn) ? "primary key" : "",
        c.unique ? "unique" : "",
        c.references ? `→ \`${c.references}\`` : "",
        c.between ? `${c.between[0]}–${c.between[1]}` : "",
        c.description ?? "",
      ].filter(Boolean);
      const nullable = c.notNull || c.primaryKey || c.type === "serial" || t.primaryKey?.includes(cn) ? "no" : "yes";
      out.push(
        `| \`${cn}\` | ${typeName(c)} | ${nullable} | ${defaultOf(c)} | ${notes.join("; ").replace(/[\\|]/g, "\\$&")} |`,
      );
    }
    const extra = [
      ...(t.primaryKey ? [`Primary key: (${t.primaryKey.join(", ")}).`] : []),
      ...(t.unique ?? []).map((u) => `Unique: (${u.join(", ")}).`),
      ...(t.indexes ?? []).map(
        (i) =>
          `Index \`${i.name}\`: (${i.columns.map((c) => (i.lower ? `LOWER(${c})` : c)).join(", ")})${i.unique ? ", unique" : ""}.`,
      ),
    ];
    if (extra.length) out.push("", ...extra);
    out.push("");
  }
  return out.join("\n");
}
