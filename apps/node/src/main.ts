// Bongsu on Node (site/docs/self-hosting.md): one process serves the HTTP app (packages/api) and the built PWA and
// dashboard and runs the three schedules with node-cron. The database is one SQLite file, or Postgres when
// DATABASE_URL is set.
//   node server.mjs                 migrate, then serve and schedule
//   node server.mjs migrate         only apply the migrations
//   node server.mjs backup <file>   a consistent copy of the SQLite database, safe while the server runs
//   node server.mjs export <file>   every table as neutral JSON (docs/databases.md)
//   node server.mjs import <file>   load an export into a fresh database (SQLite or Postgres)
//   node server.mjs load-sql <dump> a new SQLite file (DATABASE_PATH) from a SQL dump, e.g. `wrangler d1 export`

import { createApp } from "@bongsu/api/app";
import type { Db } from "@bongsu/core/db";
import { registerMailer } from "@bongsu/core/mail";
import { registerStore } from "@bongsu/core/media/index";
import { PostgresDb } from "@bongsu/core/postgres";
import { runSchedule, SCHEDULES } from "@bongsu/core/schedules";
import { exportData, importData, TransferError } from "@bongsu/schema/transfer";
import { serve } from "@hono/node-server";
import cron from "node-cron";
import { staticAssets } from "./assets";
import { SqliteDb } from "./db";
import { ConfigError, nodeEnv } from "./env";
import { LocalStore } from "./local-store";
import { migrate, migratePostgres } from "./migrate";
import { postgresDriver } from "./postgres";
import { smtpMailer } from "./smtp";

const vars = process.env;
const DATABASE = vars.DATABASE_PATH ?? "data/bongsu.db";
/** postgres://… : Postgres instead of the SQLite file. */
const DATABASE_URL = vars.DATABASE_URL;
/** Holds sqlite/ and postgres/: the database's own are applied. */
const MIGRATIONS = vars.MIGRATIONS_DIR ?? "../../migrations";
const WEB = vars.WEB_DIR ?? "../../packages/web/dist";
const PORT = Number(vars.PORT ?? 8787);
const HOST = vars.HOST ?? "0.0.0.0";

// The server's own disk, offered as the "local" media store when MEDIA_DIR names a directory (/media in Docker); the
// dashboard picks it like any other store.
if (vars.MEDIA_DIR) {
  const dir = vars.MEDIA_DIR;
  registerStore("local", () => new LocalStore(dir));
}
registerMailer("smtp", smtpMailer);

/** Fetch called unbound, as on Workers (clients call `this.fetcher(…)`). */
const realFetch: typeof fetch = (input, init) => fetch(input, init);

/** A SQLite dump (`wrangler d1 export`, `sqlite3 .dump`) into a new file at DATABASE_PATH: the first step from D1
 *  to Postgres (export, then import with DATABASE_URL). */
async function loadSql(dump: string | undefined) {
  if (DATABASE_URL) throw new ConfigError("load-sql makes a SQLite file: unset DATABASE_URL");
  if (!dump) throw new ConfigError("load-sql needs the dump: node server.mjs load-sql backup.sql");
  const { existsSync, readFileSync } = await import("node:fs");
  if (existsSync(DATABASE)) throw new ConfigError(`${DATABASE} exists: load-sql only makes a new database`);
  const db = SqliteDb.open(DATABASE);
  db.sqlite.pragma("foreign_keys = OFF");
  db.sqlite.exec(readFileSync(dump, "utf8"));
  db.sqlite.pragma("foreign_keys = ON");
  const tables = db.sqlite.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get() as {
    n: number;
  };
  console.log(`load-sql: ${tables.n} tables from ${dump} → ${DATABASE}`);
  db.close();
}

/** The database: Postgres when DATABASE_URL is set, else the SQLite file; migrated, with a way to close it. */
async function openDatabase(): Promise<{ db: Db; close: () => Promise<void> }> {
  const { join } = await import("node:path");
  let opened: { db: Db; close: () => Promise<void> };
  let applied: string[];
  if (DATABASE_URL) {
    if (!/^postgres(ql)?:\/\//.test(DATABASE_URL)) throw new ConfigError("DATABASE_URL must be postgres://…");
    const driver = postgresDriver(DATABASE_URL);
    applied = await migratePostgres(driver, join(MIGRATIONS, "postgres"));
    opened = { db: new PostgresDb(driver), close: () => driver.close() };
  } else {
    const { mkdirSync } = await import("node:fs");
    const { dirname } = await import("node:path");
    mkdirSync(dirname(DATABASE), { recursive: true });
    const db = SqliteDb.open(DATABASE);
    if (process.argv[2] === "backup") {
      const to = process.argv[3];
      if (!to) throw new ConfigError("backup needs a file to write: node server.mjs backup /data/backup.db");
      await db.sqlite.backup(to);
      console.log(`backup: ${DATABASE} → ${to}`);
      db.close();
      process.exit(0);
    }
    applied = migrate(db, join(MIGRATIONS, "sqlite"));
    opened = { db, close: async () => db.close() };
  }
  console.log(applied.length ? `migrations applied: ${applied.join(", ")}` : "migrations: up to date");
  return opened;
}

async function main() {
  const [command, arg] = process.argv.slice(2);
  if (command === "backup" && DATABASE_URL)
    throw new ConfigError("on Postgres, back up with pg_dump (docs/databases.md)");
  if (command === "load-sql") return loadSql(arg);
  const { db, close } = await openDatabase();
  if (command === "migrate") return close();
  if (command === "export" || command === "import") {
    if (!arg) throw new ConfigError(`${command} needs a file: node server.mjs ${command} bongsu-export.json`);
    const { readFileSync, writeFileSync } = await import("node:fs");
    if (command === "export") {
      const data = await exportData(db);
      writeFileSync(arg, JSON.stringify(data));
      const rows = Object.values(data.tables).reduce((n, t) => n + t.length, 0);
      console.log(`export: ${rows} rows from ${Object.keys(data.tables).length} tables → ${arg}`);
    } else {
      const counts = await importData(db, JSON.parse(readFileSync(arg, "utf8")));
      const rows = Object.values(counts).reduce((n, c) => n + c, 0);
      console.log(`import: ${rows} rows into ${DATABASE_URL ? "Postgres" : DATABASE}`);
    }
    return close();
  }

  const env = nodeEnv(vars, db, staticAssets(WEB));
  // A lock left by a run this process didn't finish (a crash, a kill -9) would hold its schedule for up to its
  // expiry; this is the database's only process, so any lock at start is stale.
  await db.prepare("DELETE FROM locks").run();

  const app = createApp(realFetch);
  const server = serve({ fetch: (req) => app.fetch(req, env), port: PORT, hostname: HOST }, (a) =>
    console.log(`bongsu: listening on ${HOST}:${a.port} (${env.PUBLIC_URL}), dry run ${env.DRY_RUN !== "0"}`),
  );

  // The schedules, in UTC like Cloudflare's cron. Each run is awaited by the shutdown below.
  const running = new Set<Promise<void>>();
  // SCHEDULES=off: serve only (a replica, a demo that must neither publish nor poll any platform)
  const off = vars.SCHEDULES === "off";
  if (off) console.log("bongsu: schedules off");
  const tasks = (off ? [] : SCHEDULES).map((expr) =>
    cron.schedule(
      expr,
      (ctx) => {
        // the minute it was due, as Cloudflare's scheduledTime
        const at = new Date(Math.floor(ctx.date.getTime() / 60_000) * 60_000);
        const run = runSchedule(env, realFetch, expr, at)
          .catch((e) => console.log(`${expr} failed: ${(e as Error).stack ?? e}`))
          .finally(() => running.delete(run));
        running.add(run);
        return run;
      },
      { timezone: "UTC", noOverlap: true, name: expr },
    ),
  );

  // Graceful shutdown: stop scheduling, stop taking requests, let the runs finish (30 s at most), free their locks.
  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`bongsu: ${signal}, stopping`);
    for (const t of tasks) await t.stop();
    server.close();
    await Promise.race([Promise.all(running), new Promise((r) => setTimeout(r, 30_000))]);
    await db.prepare("DELETE FROM locks").run();
    await close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop("SIGTERM"));
  process.on("SIGINT", () => void stop("SIGINT"));
}

main().catch((e) => {
  console.error(e instanceof ConfigError || e instanceof TransferError ? `bongsu: ${e.message}` : e);
  process.exit(1);
});
