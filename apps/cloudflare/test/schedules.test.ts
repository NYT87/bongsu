// The named runs (instagram, shorts, upkeep) and runDue, which the cron Worker and Node call every minute: which runs
// a minute starts under the CRON_* variables, side by side, and what it records for the dashboard.
import { env } from "cloudflare:workers";
import type { Db } from "@bongsu/core/db";
import type { Env } from "@bongsu/core/env";
import { runDue, schedules } from "@bongsu/core/schedules";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testEnv, World } from "./world";

const at = (hhmm: string) => new Date(`2026-10-20T${hhmm}:00Z`);

let w: World;
let e: Env;
const make = (vars: Record<string, string> = {}) => testEnv(env, vars);

const setting = (key: string) =>
  env.DB.prepare("SELECT value, updated_at FROM settings WHERE key = ?1")
    .bind(key)
    .first<{ value: string; updated_at: number }>();

/** The env's database, counting every statement prepared and every batch. */
function counted(db: Db): { db: Db; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    db: {
      prepare: (sql) => {
        calls.push(sql);
        return db.prepare(sql);
      },
      batch: (statements) => {
        calls.push("batch");
        return db.batch(statements);
      },
    },
  };
}

beforeEach(async () => {
  await env.DB.batch(
    [
      "DELETE FROM jobs",
      "DELETE FROM locks",
      "DELETE FROM settings WHERE key = 'schedules' OR key LIKE 'tick_last:%'",
    ].map((s) => env.DB.prepare(s)),
  );
  w = new World();
  e = await make();
});
afterEach(() => vi.restoreAllMocks());

describe("runDue: the default schedules", () => {
  it("starts instagram every 5 minutes, shorts at :02 and :32, upkeep at :07 :22 :37 :52, nothing otherwise", async () => {
    expect(await runDue(e, w.fetch, at("10:05"))).toEqual(["instagram"]);
    expect(await runDue(e, w.fetch, at("10:32"))).toEqual(["shorts"]);
    expect(await runDue(e, w.fetch, at("10:52"))).toEqual(["upkeep"]);
    expect(await runDue(e, w.fetch, at("10:01"))).toEqual([]);
  });

  it("takes the minute the trigger was due, whatever the seconds", async () => {
    expect(await runDue(e, w.fetch, new Date("2026-10-20T10:05:42Z"))).toEqual(["instagram"]);
  });

  it("lists the three runs, by default, in order", () => {
    expect(schedules(e)).toEqual([
      { name: "instagram", variable: "CRON_INSTAGRAM", expr: "*/5 * * * *", source: "default", gapS: 300, error: null },
      { name: "shorts", variable: "CRON_SHORTS", expr: "2,32 * * * *", source: "default", gapS: 1800, error: null },
      {
        name: "upkeep",
        variable: "CRON_UPKEEP",
        expr: "7,22,37,52 * * * *",
        source: "default",
        gapS: 900,
        error: null,
      },
    ]);
  });
});

describe("runDue: the CRON_* variables", () => {
  it("runs two schedules sharing a minute side by side, and both finish", async () => {
    e = await make({ CRON_SHORTS: "*/5 * * * *" });
    expect(schedules(e)[1]).toMatchObject({ expr: "*/5 * * * *", source: "variable", gapS: 300, error: null });
    expect(await runDue(e, w.fetch, at("10:05"))).toEqual(["instagram", "shorts"]);
    expect(JSON.parse((await setting("tick_last:shorts"))?.value ?? "{}").at).toBe(at("10:05").getTime() / 1000);
    expect(JSON.parse((await setting("tick_last:instagram"))?.value ?? "{}").at).toBe(at("10:05").getTime() / 1000);
  });

  it("runs upkeep only when its own expression says", async () => {
    e = await make({ CRON_UPKEEP: "0 3 * * *" });
    expect(await runDue(e, w.fetch, at("10:52"))).toEqual([]); // a default upkeep minute
    expect(await runDue(e, w.fetch, at("03:07"))).toEqual([]);
    expect(await runDue(e, w.fetch, at("03:00"))).toEqual(["instagram", "upkeep"]);
    expect(schedules(e)[2]).toMatchObject({ gapS: 86400, source: "variable" });
  });

  it("skips only an invalid schedule, logging it with its variable", async () => {
    e = await make({ CRON_SHORTS: "61 * * * *" });
    const log = vi.spyOn(console, "log");
    const s = schedules(e)[1];
    expect(s).toMatchObject({ name: "shorts", variable: "CRON_SHORTS", expr: "61 * * * *", gapS: null });
    expect(s.error).toMatch(/minute/);
    expect(await runDue(e, w.fetch, at("10:05"))).toEqual(["instagram"]);
    expect(log.mock.calls.some(([m]) => String(m).startsWith("schedule CRON_SHORTS: "))).toBe(true);
  });

  it("refuses an expression that never fires", () => {
    expect(schedules({ ...e, CRON_UPKEEP: "0 0 31 2 *" })[2].error).toMatch(/does not fire/);
  });
});

describe("runDue: what it records", () => {
  it("writes the schedules row once, rewrites it only when it changes", async () => {
    await runDue(e, w.fetch, at("10:05"));
    const first = await setting("schedules");
    expect(JSON.parse(first?.value ?? "null")).toEqual(schedules(e));
    expect(first?.updated_at).toBe(at("10:05").getTime() / 1000);
    await runDue(e, w.fetch, at("10:10"));
    expect((await setting("schedules"))?.updated_at).toBe(first?.updated_at); // unchanged: not written again
    const changed = { ...e, CRON_SHORTS: "*/10 * * * *" };
    await runDue(changed, w.fetch, at("10:15"));
    const after = await setting("schedules");
    expect(after?.updated_at).toBe(at("10:15").getTime() / 1000);
    expect(JSON.parse(after?.value ?? "null")[1]).toMatchObject({ expr: "*/10 * * * *", source: "variable" });
  });

  it("makes no database call in a minute where nothing is due", async () => {
    const c = counted(e.DB);
    expect(await runDue({ ...e, DB: c.db }, w.fetch, at("10:01"))).toEqual([]);
    expect(c.calls).toEqual([]);
    // an invalid variable is only logged, still without the database
    expect(await runDue({ ...e, DB: c.db, CRON_SHORTS: "bad" }, w.fetch, at("10:01"))).toEqual([]);
    expect(c.calls).toEqual([]);
  });
});

describe("upkeep", () => {
  it("isn't held up by the old code's inbox lock, and logs as upkeep", async () => {
    const nowS = at("10:52").getTime() / 1000;
    await env.DB.prepare("INSERT INTO locks (name, holder, expires_at) VALUES ('inbox', 'old-holder', ?1)")
      .bind(nowS + 600)
      .run();
    const log = vi.spyOn(console, "log");
    expect(await runDue(e, w.fetch, at("10:52"))).toEqual(["upkeep"]);
    const lines = log.mock.calls.map(([m]) => String(m));
    expect(lines.some((l) => l.startsWith("upkeep: inbox "))).toBe(true);
    expect(lines.some((l) => l.includes("locked"))).toBe(false);
    // its own lock is freed; the stale one is left to expire
    expect((await env.DB.prepare("SELECT name FROM locks").all<{ name: string }>()).results).toEqual([
      { name: "inbox" },
    ]);
  });
});
