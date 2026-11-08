// The Node runtime: the SQLite Db adapter passes the same conformance cases as D1, the migrations apply on plain
// SQLite, the local media store passes the media-store cases, the built app is served like Workers assets, and the
// HTTP app and the schedules run on it.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "@bongsu/api/app";
import { runSubrequests } from "@bongsu/core/budget";
import { NODE_JOBS_PER_TICK } from "@bongsu/core/constants";
import { dbCases } from "@bongsu/core/db-conformance";
import type { Env } from "@bongsu/core/env";
import { mediaStoreCases } from "@bongsu/core/media/conformance";
import { registerStore } from "@bongsu/core/media/index";
import { runSchedule, schedulesOff } from "@bongsu/core/schedules";
import { jobsPerTick } from "@bongsu/core/tick";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import { staticAssets } from "../src/assets";
import { SqliteDb } from "../src/db";
import { ConfigError, nodeEnv } from "../src/env";
import { LocalStore, putFile } from "../src/local-store";
import { migrate } from "../src/migrate";
import { checkSchedules, startSchedules } from "../src/schedules";

const MIGRATIONS = join(__dirname, "../../../migrations/sqlite");
const tmp = mkdtempSync(join(tmpdir(), "bongsu-node-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const migrated = () => {
  const db = new SqliteDb(new Database(":memory:"));
  db.sqlite.pragma("foreign_keys = ON");
  migrate(db, MIGRATIONS);
  return db;
};

describe("db conformance: SQLite (better-sqlite3)", () => {
  const db = migrated();
  for (const c of dbCases(db)) it(c.name, c.run);
});

describe("migrations", () => {
  it("apply in order on plain SQLite, once, recorded as wrangler records them", () => {
    const db = SqliteDb.open(join(tmp, "m.db"));
    const first = migrate(db, MIGRATIONS);
    expect(first[0]).toBe("0001_init.sql");
    expect(first.length).toBeGreaterThanOrEqual(9);
    expect(migrate(db, MIGRATIONS)).toEqual([]); // nothing twice
    const names = db.sqlite.prepare("SELECT name FROM d1_migrations ORDER BY id").all() as { name: string }[];
    expect(names.map((n) => n.name)).toEqual(first);
    db.close();
  });
});

describe("media store conformance: local (a directory)", () => {
  let n = 0;
  for (const c of mediaStoreCases(async (files) => {
    const root = join(tmp, `store-${++n}`);
    const store = new LocalStore(root);
    const ids: Record<string, string> = {};
    for (const [path, f] of Object.entries(files)) ids[path] = await putFile(store, root, path, f.bytes);
    return { store, ids };
  }))
    it(c.name, c.run);

  it("never reaches outside its folder, and never overwrites on a move", async () => {
    const root = join(tmp, "store-guard");
    const store = new LocalStore(root);
    await expect(store.resolve("../../etc/passwd")).rejects.toThrow(/outside/);
    // a symlink planted in the folder doesn't expose what it points at
    mkdirSync(root, { recursive: true });
    writeFileSync(join(tmp, "secret.txt"), "outside root");
    symlinkSync(join(tmp, "secret.txt"), join(root, "innocent.mp4"));
    expect(await store.resolve("innocent.mp4")).toBeNull();
    expect((await store.list((await store.resolve(""))!.id)).map((f) => f.name)).not.toContain("innocent.mp4");
    const a = await putFile(store, root, "UPLOADS/inbox/a.mp4", "one");
    await putFile(store, root, "UPLOADS/_posted/a.mp4", "two");
    await store.move(a, "UPLOADS/_posted");
    expect((await store.resolve("UPLOADS/_posted/a (2).mp4"))?.id).toBe(a);
    expect(await (await store.stream(a)).text()).toBe("one");
  });
});

describe("the built app, served like Workers assets", () => {
  const web = join(tmp, "web");
  mkdirSync(join(web, "dashboard"), { recursive: true });
  mkdirSync(join(web, "assets"), { recursive: true });
  writeFileSync(join(web, "index.html"), "app");
  writeFileSync(join(web, "dashboard/index.html"), "dashboard");
  writeFileSync(join(web, "assets/x-123.js"), "js");
  const assets = staticAssets(web);
  const get = (p: string) => assets.fetch(new Request(`http://bongsu.test${p}`));

  it("serves files, a folder's index.html, and the app for other paths", async () => {
    expect(await (await get("/")).text()).toBe("app");
    expect(await (await get("/dashboard/")).text()).toBe("dashboard");
    expect(await (await get("/item/reel%3Ax")).text()).toBe("app"); // the app's own routes
    const js = await get("/assets/x-123.js");
    expect([js.headers.get("Content-Type"), js.headers.get("Cache-Control")]).toEqual([
      "text/javascript; charset=utf-8",
      "public, max-age=31536000, immutable",
    ]);
    expect((await get("/missing.js")).status).toBe(404);
    // the URL is normalized before it gets here; nothing outside the folder is ever read
    expect(await (await get("/../../etc/passwd")).text()).toBe("app");
    expect(await (await get("/%2e%2e/%2e%2e/etc/passwd")).text()).toBe("app");
  });
});

describe("the HTTP app and the schedules on Node", () => {
  const db = migrated();
  const env = nodeEnv(
    { PUBLIC_URL: "https://bongsu.test/", MEDIA_DIR: join(tmp, "media"), MEDIA_SIGNING_KEY: "k" },
    db,
  );
  registerStore("local", (e) => new LocalStore(e.MEDIA_DIR as string));
  // the server's disk, set up as the store (the dashboard's Media page does this)
  db.sqlite
    .prepare(
      "INSERT INTO media_store (id, kind, is_default, settings, status, updated_at) VALUES ('local', 'local', 1, '{}', 'ok', 0)",
    )
    .run();
  const offline: typeof fetch = async (input) => {
    throw new Error(`no network in this test: ${String(input)}`);
  };

  it("builds the Env from the environment, with named secrets reachable", () => {
    const e = nodeEnv({ PUBLIC_URL: "https://x.test", YT_MAIN_OAUTH: "{}" }, db);
    expect([e.RP_ID, e.DRY_RUN, (e as unknown as Record<string, string>).YT_MAIN_OAUTH]).toEqual(["x.test", "1", "{}"]);
    expect(() => nodeEnv({}, db)).toThrow(/PUBLIC_URL/);
    for (const bad of [
      "bongsu.example.com",
      "//bongsu.example.com",
      "ftp://x.test",
      "http://bongsu.example.com",
      "https://",
    ])
      expect(() => nodeEnv({ PUBLIC_URL: bad }, db), bad).toThrow(/absolute https/);
    expect(nodeEnv({ PUBLIC_URL: "http://localhost:8787" }, db).PUBLIC_URL).toBe("http://localhost:8787");
  });

  it("advances more jobs a tick than Cloudflare by default, and takes JOBS_PER_TICK", () => {
    expect(jobsPerTick(nodeEnv({ PUBLIC_URL: "https://x.test" }, db))).toBe(NODE_JOBS_PER_TICK);
    expect(jobsPerTick(nodeEnv({ PUBLIC_URL: "https://x.test", JOBS_PER_TICK: "8" }, db))).toBe(8);
  });

  it("runs without a call limit by default, and falls back to that, not Cloudflare's 50, on a bad RUN_SUBREQUESTS", () => {
    const limit = (vars: Record<string, string>) =>
      runSubrequests(nodeEnv({ PUBLIC_URL: "https://x.test", ...vars }, db));
    expect(limit({})).toEqual({ value: Number.POSITIVE_INFINITY, source: "default", invalid: null });
    expect(limit({ RUN_SUBREQUESTS: "200" })).toEqual({ value: 200, source: "variable", invalid: null });
    expect(limit({ RUN_SUBREQUESTS: "lots" })).toEqual({
      value: Number.POSITIVE_INFINITY,
      source: "default",
      invalid: "lots",
    });
  });

  it("turns the schedules off with SCHEDULES=off, which the dashboard's Scheduler shows", () => {
    expect(schedulesOff(nodeEnv({ PUBLIC_URL: "https://x.test" }, db))).toBe(false);
    expect(schedulesOff(nodeEnv({ PUBLIC_URL: "https://x.test", SCHEDULES: "off" }, db))).toBe(true);
  });

  it("answers /health: migrated, local store, nothing missing", async () => {
    const r = await createApp(offline).request("/health", {}, env);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, dry_run: true, missing_secrets: [] });
  });

  it("runs each schedule on an empty plan without errors", async () => {
    const at = new Date("2026-10-20T09:30:00Z");
    for (const name of ["instagram", "shorts", "upkeep"] as const) await runSchedule(env, offline, name, at, 300);
    // the upkeep run releases its lock
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM locks").get()).toEqual({ n: 0 });
  });

  it("refuses to start on an invalid CRON_* variable, naming it", () => {
    const bad = nodeEnv({ PUBLIC_URL: "https://x.test", CRON_SHORTS: "bad" }, db);
    expect(() => checkSchedules(bad)).toThrow(ConfigError);
    expect(() => checkSchedules(bad)).toThrow(/CRON_SHORTS/);
    expect(() => checkSchedules(env)).not.toThrow();
  });

  it("schedules one every-minute task that calls runDue for the minute, none with SCHEDULES=off", async () => {
    const running = new Set<Promise<void>>();
    const calls: [Env, Date][] = [];
    const tasks = startSchedules(env, offline, running, async (e, _f, at) => {
      calls.push([e, at]);
      return [];
    });
    try {
      expect(tasks.length).toBe(1);
      expect(tasks[0].match(new Date("2026-10-20T09:31:00Z"))).toBe(true); // every minute
      await tasks[0].execute();
      expect(calls.length).toBe(1);
      expect(calls[0][0]).toBe(env);
      expect(calls[0][1].getTime() % 60_000).toBe(0); // the minute it was due, as Cloudflare's scheduledTime
      expect(running.size).toBe(0); // finished runs leave the set the shutdown waits on
    } finally {
      for (const t of tasks) await t.destroy();
    }
    expect(startSchedules(nodeEnv({ PUBLIC_URL: "https://x.test", SCHEDULES: "off" }, db), offline, running)).toEqual(
      [],
    );
  });
});

describe("backups", () => {
  it("copies a live database consistently (SQLite's online backup, as `node server.mjs backup` does)", async () => {
    const db = SqliteDb.open(join(tmp, "live.db"));
    migrate(db, MIGRATIONS);
    await db.prepare("INSERT INTO settings (key, value) VALUES ('backup_test', 'yes')").run();
    await db.sqlite.backup(join(tmp, "copy.db"));
    const copy = SqliteDb.open(join(tmp, "copy.db"));
    expect(await copy.prepare("SELECT value FROM settings WHERE key = 'backup_test'").first()).toEqual({
      value: "yes",
    });
    expect(migrate(copy, MIGRATIONS)).toEqual([]); // it carries its migrations
    copy.close();
    db.close();
  });
});
