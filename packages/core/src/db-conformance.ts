// What "works" means for a Db adapter (db.ts): D1 on Cloudflare and SQLite on Node both run these cases, so the
// runtimes can't drift. Like media/conformance.ts they use no test framework: `for (const c of dbCases(db)) it(…)`.
// Each case makes its own scratch table, so they can run against a database that already holds the schema.
import type { Db } from "./db";
import { jsonList, tableNames } from "./sql";

function check(ok: unknown, what: string): asserts ok {
  if (!ok) throw new Error(`db conformance: ${what}`);
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function dbCases(db: Db): { name: string; run: () => Promise<void> }[] {
  const table = async (name: string) => {
    await db.prepare(`DROP TABLE IF EXISTS ${name}`).run();
    await db
      .prepare(`CREATE TABLE ${name} (id TEXT PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0, note TEXT, data TEXT)`)
      .run();
  };
  return [
    {
      name: "numbered parameters (a number used twice), first() null when nothing matches, all() in order",
      run: async () => {
        await table("conf_params");
        for (const [id, n] of [
          ["b", 2],
          ["a", 1],
        ] as const)
          await db.prepare("INSERT INTO conf_params (id, n, note) VALUES (?1, ?2, ?1)").bind(id, n).run();
        const a = await db.prepare("SELECT id, n, note FROM conf_params WHERE id = ?1").bind("a").first();
        check(same(a, { id: "a", n: 1, note: "a" }), `first ${JSON.stringify(a)}`);
        check((await db.prepare("SELECT 1 FROM conf_params WHERE id = ?1").bind("z").first()) === null, "first null");
        const all = await db.prepare("SELECT id FROM conf_params ORDER BY id").all<{ id: string }>();
        check(same(all.results, [{ id: "a" }, { id: "b" }]), `all ${JSON.stringify(all.results)}`);
        check(same((await db.prepare("SELECT id FROM conf_params WHERE n > 9").all()).results, []), "all empty");
      },
    },
    {
      name: "null binds and reads back as null; integers come back as numbers",
      run: async () => {
        await table("conf_types");
        await db
          .prepare("INSERT INTO conf_types (id, n, note) VALUES (?1, ?2, ?3)")
          .bind("x", 1_800_000_000, null)
          .run();
        const r = await db.prepare("SELECT n, note FROM conf_types").first<{ n: unknown; note: unknown }>();
        check(r?.n === 1_800_000_000 && typeof r.n === "number", `n ${String(r?.n)}`);
        check(r.note === null, `note ${String(r.note)}`);
      },
    },
    {
      name: "RETURNING rows come back from first() and from run()",
      run: async () => {
        await table("conf_returning");
        const ins = await db
          .prepare("INSERT INTO conf_returning (id, n) VALUES (?1, 5) RETURNING id, n")
          .bind("r")
          .run<{ id: string; n: number }>();
        check(same(ins.results, [{ id: "r", n: 5 }]), `run returning ${JSON.stringify(ins.results)}`);
        const up = await db
          .prepare("UPDATE conf_returning SET n = n + 1 WHERE id = ?1 RETURNING n")
          .bind("r")
          .first<{ n: number }>();
        check(up?.n === 6, `first returning ${JSON.stringify(up)}`);
        const none = await db.prepare("UPDATE conf_returning SET n = 0 WHERE id = ?1 RETURNING n").bind("x").first();
        check(none === null, "returning nothing is null");
        check(same((await db.prepare("DELETE FROM conf_returning").run()).results, []), "run without RETURNING");
      },
    },
    {
      name: "ON CONFLICT … DO UPDATE with excluded, and a WHERE on the update",
      run: async () => {
        await table("conf_upsert");
        const up = (id: string, n: number) =>
          db
            .prepare(
              `INSERT INTO conf_upsert (id, n) VALUES (?1, ?2)
               ON CONFLICT (id) DO UPDATE SET n = excluded.n WHERE conf_upsert.n < excluded.n`,
            )
            .bind(id, n)
            .run();
        await up("k", 3);
        await up("k", 7);
        await up("k", 5); // not larger: kept
        const r = await db.prepare("SELECT n FROM conf_upsert WHERE id = 'k'").first<{ n: number }>();
        check(r?.n === 7, `n ${r?.n}`);
      },
    },
    {
      name: "batch runs in order, returns each statement's rows, and rolls everything back when one fails",
      run: async () => {
        await table("conf_batch");
        const ins = (id: string) => db.prepare("INSERT INTO conf_batch (id) VALUES (?1)").bind(id);
        const out = await db.batch([ins("1"), ins("2"), db.prepare("SELECT COUNT(*) AS c FROM conf_batch")]);
        check(out.length === 3 && same(out[2].results, [{ c: 2 }]), `batch ${JSON.stringify(out)}`);
        let failed = false;
        try {
          await db.batch([ins("3"), ins("1")]); // "1" exists: the primary key refuses it
        } catch {
          failed = true;
        }
        check(failed, "a failing batch throws");
        const left = await db.prepare("SELECT id FROM conf_batch ORDER BY id").all<{ id: string }>();
        check(same(left.results, [{ id: "1" }, { id: "2" }]), `rolled back ${JSON.stringify(left.results)}`);
      },
    },
    {
      name: "a JSON array parameter works as a list of values (sql.ts jsonList)",
      run: async () => {
        await table("conf_list");
        for (const id of ["a", "b", "c"]) await db.prepare("INSERT INTO conf_list (id) VALUES (?1)").bind(id).run();
        const r = await db
          .prepare(`SELECT id FROM conf_list WHERE id IN ${jsonList(db, 1)} AND n = ?2 ORDER BY id`)
          .bind(JSON.stringify(["a", "c", "z"]), 0)
          .all<{ id: string }>();
        check(same(r.results, [{ id: "a" }, { id: "c" }]), `list ${JSON.stringify(r.results)}`);
      },
    },
    {
      name: "the tables are listed (sql.ts tableNames)",
      run: async () => {
        await table("conf_listed");
        check((await tableNames(db)).includes("conf_listed"), "conf_listed listed");
      },
    },
    {
      name: "a statement can be bound and run again with other values",
      run: async () => {
        await table("conf_reuse");
        const st = db.prepare("INSERT INTO conf_reuse (id) VALUES (?1)");
        await st.bind("p").run();
        await st.bind("q").run();
        const r = await db.prepare("SELECT COUNT(*) AS c FROM conf_reuse").first<{ c: number }>();
        check(r?.c === 2, `count ${r?.c}`);
      },
    },
    {
      name: "a SQL error rejects (it doesn't return an empty result)",
      run: async () => {
        let failed = false;
        try {
          await db.prepare("SELECT nope FROM no_such_table").all();
        } catch {
          failed = true;
        }
        check(failed, "the error rejects");
      },
    },
  ];
}
