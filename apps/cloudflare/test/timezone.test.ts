// The workspace's time zone (Phase 3): plan dates and times are wall time there, daylight saving included.
import { env } from "cloudflare:workers";
import { tick } from "@bongsu/core/tick";
import { setWorkspaceSettings } from "@bongsu/core/workspaces";
import { beforeEach, describe, expect, it } from "vitest";
import { clearPlan, seedReel, testEnv, World } from "./world";

beforeEach(async () => {
  await clearPlan();
  await env.DB.prepare("DELETE FROM jobs").run();
});

const jobs = async () =>
  (await env.DB.prepare("SELECT item_key, due_at FROM jobs ORDER BY id").all<{ item_key: string; due_at: number }>())
    .results;

describe("a workspace in Madrid", () => {
  it("publishes an 18:00 Reel at 18:00 Madrid time (UTC+2 before the October change, UTC+1 after)", async () => {
    const w = new World();
    const e = await testEnv(env);
    await setWorkspaceSettings(env.DB, "default", { timezone: "Europe/Madrid" }, 0);
    const { key } = await seedReel(w, { date: "2026-10-20" }); // 18:00 by default
    await tick(e, { fetch: w.fetch, now: new Date("2026-10-20T15:59:00Z") }); // 17:59 in Madrid
    expect(await jobs()).toEqual([]);
    await tick(e, { fetch: w.fetch, now: new Date("2026-10-20T16:01:00Z") }); // 18:01 in Madrid
    expect(await jobs()).toEqual([{ item_key: key, due_at: Date.UTC(2026, 9, 20, 16, 0) / 1000 }]);
  });

  it("after the change to winter time, the same 18:00 is an hour later in UTC", async () => {
    const w = new World();
    const e = await testEnv(env);
    await setWorkspaceSettings(env.DB, "default", { timezone: "Europe/Madrid" }, 0);
    const { key } = await seedReel(w, { date: "2026-10-27" });
    await tick(e, { fetch: w.fetch, now: new Date("2026-10-27T16:30:00Z") }); // 17:30 in Madrid
    expect(await jobs()).toEqual([]);
    await tick(e, { fetch: w.fetch, now: new Date("2026-10-27T17:01:00Z") });
    expect(await jobs()).toEqual([{ item_key: key, due_at: Date.UTC(2026, 9, 27, 17, 0) / 1000 }]);
  });

  it("refuses an unknown time zone", async () => {
    await expect(setWorkspaceSettings(env.DB, "default", { timezone: "Mars/Base" }, 0)).rejects.toThrow(/unknown time/);
  });
});
