// The account series (Phase 9): each active account's follower count once a day, a failing account waiting 6 h,
// and the one-time backfill from the nightly snapshots.
import { env } from "cloudflare:workers";
import { sampleAccounts } from "@bongsu/core/account-metrics";
import { ACCOUNT_BACKFILL_PER_RUN, ACCOUNTS_PER_RUN } from "@bongsu/core/constants";
import { zoneToUnix } from "@bongsu/core/formats/time";
import { callerZone } from "@bongsu/core/workspaces";
import { beforeEach, describe, expect, it } from "vitest";
import { testEnv, World } from "./world";

const T0 = new Date("2026-10-26T03:00:00Z");
const at = (h: number) => new Date(T0.getTime() + h * 3600_000);
const s = (d: Date) => Math.floor(d.getTime() / 1000);

let w: World;
let e: Awaited<ReturnType<typeof testEnv>>;
beforeEach(async () => {
  await env.DB.batch(
    [
      "DELETE FROM account_metrics",
      "DELETE FROM snapshots",
      "DELETE FROM settings WHERE key LIKE 'account_metrics%'",
    ].map((q) => env.DB.prepare(q)),
  );
  e = await testEnv(env);
  w = new World();
  w.composio.INSTAGRAM_GET_USER_INFO = (a) => ({ id: a.ig_user_id, username: "x", followers_count: 120 });
});

const run = (now: Date) => sampleAccounts(e, { fetch: w.fetch, now });
const rows = () =>
  env.DB.prepare(
    "SELECT account, platform, taken_at, followers, workspace_id FROM account_metrics ORDER BY account, taken_at",
  )
    .all<{ account: string; platform: string; taken_at: number; followers: number | null; workspace_id: string }>()
    .then((r) => r.results);

describe("the account sampler", () => {
  it("samples each active account's followers once a day, a few per run", async () => {
    w.ytSubscribers = 1230;
    const first = await run(T0);
    expect(first.sampled).toHaveLength(ACCOUNTS_PER_RUN);
    const second = await run(at(0.25));
    expect([...first.sampled, ...second.sampled].sort()).toEqual([
      "demo_cycling",
      "demo_running",
      "demo_travel",
      "main",
      "vlogs",
    ]);
    expect((await run(at(1))).sampled).toEqual([]); // not again within the day
    const r = await rows();
    expect(r.find((x) => x.account === "demo_travel")).toMatchObject({
      platform: "instagram",
      followers: 120,
      workspace_id: "default",
    });
    expect(r.find((x) => x.account === "main")).toMatchObject({ platform: "youtube", followers: 1230 });
    expect((await run(at(24))).sampled).toHaveLength(ACCOUNTS_PER_RUN); // a day later, due again
  });

  it("a failing account waits 6 hours, the others aren't held up", async () => {
    w.composio.INSTAGRAM_GET_USER_INFO = (a) => {
      if (a.ig_user_id === "17841400000000001") throw new Error("token revoked");
      return { id: a.ig_user_id, username: "x", followers_count: 120 };
    };
    const asked = () => w.calls.filter((c) => c.args.ig_user_id === "17841400000000001").length;
    await run(T0);
    await run(at(0.25));
    expect(asked()).toBe(1);
    expect((await rows()).map((x) => x.account)).not.toContain("demo_travel");
    await run(at(1));
    expect(asked()).toBe(1);
    await run(at(6));
    expect(asked()).toBe(2);
  });
});

describe("the backfill from the snapshots", () => {
  const snap = (day: string, taken: string, accounts: unknown[], ws = "default") =>
    env.DB.prepare("INSERT INTO snapshots (day, taken, source, data, workspace_id) VALUES (?1, ?2, 'ci', ?3, ?4)")
      .bind(day, taken, JSON.stringify({ taken, accounts, rows: [] }), ws)
      .run();

  it("a long history comes over a few runs, a bounded number of rows each", async () => {
    const n = ACCOUNT_BACKFILL_PER_RUN + 30;
    for (let i = 0; i < n; i++) {
      const day = new Date(Date.UTC(2025, 0, 1) + i * 86400_000).toISOString().slice(0, 10);
      await snap(day, `${day}T10:00:00+0000`, [{ platform: "instagram", account: "demo_travel", followers: i }]);
    }
    expect((await run(T0)).backfilled).toBe(ACCOUNT_BACKFILL_PER_RUN);
    expect((await run(at(0.25))).backfilled).toBe(30);
    expect((await run(at(0.5))).backfilled).toBe(0);
    const flag = await env.DB.prepare(
      "SELECT 1 AS x FROM settings WHERE key = 'account_metrics_backfill:default'",
    ).first();
    expect(flag).toBeTruthy();
  });

  it("turns each snapshot's follower counts into samples once, on the workspace's clock", async () => {
    await snap("2026-10-14", "2026-10-14T10:00:00", [
      { platform: "instagram", account: "demo_travel", followers: 90 },
      { platform: "instagram", account: "ghost_account", followers: 5 }, // no such account: skipped
      { platform: "youtube", account: "main", followers: null }, // no count: skipped
    ]);
    await snap("2026-10-15", "2026-10-15T10:00:00+0000", [
      { platform: "instagram", account: "demo_travel", followers: 97 },
    ]);
    const tz = await callerZone(env.DB, "default");
    expect((await run(T0)).backfilled).toBe(2);
    const travel = (await rows()).filter((x) => x.account === "demo_travel");
    expect(travel.slice(0, 2)).toEqual([
      {
        account: "demo_travel",
        platform: "instagram",
        taken_at: zoneToUnix("2026-10-14", "10:00", tz),
        followers: 90,
        workspace_id: "default",
      },
      {
        account: "demo_travel",
        platform: "instagram",
        taken_at: s(new Date("2026-10-15T10:00:00Z")),
        followers: 97,
        workspace_id: "default",
      },
    ]);
    expect((await run(at(1))).backfilled).toBe(0); // once
    // even with the flag gone (a second workspace's run, a restore), no duplicates
    await env.DB.prepare("DELETE FROM settings WHERE key LIKE 'account_metrics_backfill:%'").run();
    expect((await run(at(2))).backfilled).toBe(0);
  });
});
