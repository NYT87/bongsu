import { env } from "cloudflare:workers";
import { dailyDigest } from "@bongsu/core/digest";
import { beforeEach, describe, expect, it } from "vitest";
import { clearPlan, planItem, seedReel, testEnv, World } from "./world";

const AT = new Date("2026-10-20T00:07:00Z"); // 09:07 KST

let w: World;
beforeEach(async () => {
  await env.DB.batch(["DELETE FROM jobs", "DELETE FROM audit", "DELETE FROM settings"].map((s) => env.DB.prepare(s)));
  await clearPlan();
  w = new World();
});

describe("the daily digest", () => {
  it("sends today's items, what needs approval and failures, once a day from 08:00 KST", async () => {
    await seedReel(w, { base: "short1_today", date: "2026-10-20", time: "18:00" });
    await planItem({ folder: "vlogs/CONTENT/20260823_LISBON", name: "short2_tomorrow", date: "2026-10-21" });
    await env.DB.prepare(
      "INSERT INTO jobs (item_key, kind, account, due_at, state, last_error, payload, created_at, updated_at) VALUES ('reel:X/short0', 'video', 'a', 1, 'failed', 'container ERROR', '{}', ?1, ?1)",
    )
      .bind(Math.floor(AT.getTime() / 1000) - 3600)
      .run();
    const e = await testEnv(env);
    expect(await dailyDigest(e, { fetch: w.fetch, now: new Date("2026-10-19T22:30:00Z") })).toBe("not yet"); // 07:30 KST
    expect(await dailyDigest(e, { fetch: w.fetch, now: AT })).toBe("sent");
    const n = w.notifications.at(-1)!;
    expect(n.title).toBe("Today: 1 Instagram");
    expect(n.body).toContain("18:00 Reel short1_today @demo_travel: approved");
    expect(n.body).toContain("Needs approval (1):\n10-21 18:00 Reel short2_tomorrow @demo_travel: not approved");
    expect(n.body).toContain("reel:X/short0: failed (container ERROR)");
    expect(await dailyDigest(e, { fetch: w.fetch, now: new Date(AT.getTime() + 15 * 60_000) })).toBe("already sent");
    expect(await dailyDigest(e, { fetch: w.fetch, now: new Date(AT.getTime() + 86400_000) })).toBe("sent"); // next day
  });
});
