// The production Postgres path: postgres.js (what DATABASE_URL uses) over the network to a Postgres server (PGlite
// behind pglite-socket, so no server needs installing): migrations, the Db conformance cases, /health.
import { join } from "node:path";
import { createApp } from "@bongsu/api/app";
import { dbCases } from "@bongsu/core/db-conformance";
import { registerStore } from "@bongsu/core/media/index";
import { PostgresDb } from "@bongsu/core/postgres";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nodeEnv } from "../src/env";
import { LocalStore } from "../src/local-store";
import { migratePostgres } from "../src/migrate";
import { postgresDriver } from "../src/postgres";

const pg = new PGlite();
const server = new PGLiteSocketServer({ db: pg, port: 0, host: "127.0.0.1" });
let driver: ReturnType<typeof postgresDriver>;

beforeAll(async () => {
  await server.start();
  const port = new URL(`postgres://${server.getServerConn()}`).port;
  driver = postgresDriver(`postgres://postgres@127.0.0.1:${port}/postgres`);
  expect(await migratePostgres(driver, join(__dirname, "../../../migrations/postgres"))).toContain("0009_baseline.sql");
});
afterAll(async () => {
  await driver.close();
  await server.stop();
  await pg.close();
});

describe("postgres.js against a Postgres server", () => {
  it("answers /health, with 64-bit integers as numbers", async () => {
    registerStore("local", (e) => new LocalStore(e.MEDIA_DIR as string));
    const env = nodeEnv(
      {
        PUBLIC_URL: "https://bongsu.test",
        MEDIA_STORE: "local",
        MEDIA_DIR: "/tmp/bongsu-wire",
        MEDIA_SIGNING_KEY: "k",
      },
      new PostgresDb(driver),
    );
    const r = await createApp(fetch).request("/health", {}, env);
    expect(await r.json()).toMatchObject({ ok: true });
    const n = await new PostgresDb(driver).prepare("SELECT COUNT(*) AS n FROM workspaces").first<{ n: unknown }>();
    expect(n).toEqual({ n: 1 });
  });

  // the conformance cases need the driver, made in beforeAll
  for (const c of dbCases(
    new PostgresDb({
      query: (s, p) => driver.query(s, p),
      exec: (s) => driver.exec(s),
      transaction: (fn) => driver.transaction(fn),
      close: () => driver.close(),
    }),
  ))
    it(`db conformance: ${c.name}`, c.run);
});
