// The upkeep run's call budget (#64): its nine steps spend RUN_SUBREQUESTS in order, each keeping a unit of work for
// every step after it and checking its share before a unit, and a step that overshoots is stopped (BudgetSpent)
// without stopping the steps after it.
import { env } from "cloudflare:workers";
import { sampleAccounts } from "@bongsu/core/account-metrics";
import { BudgetSpent, type StepBudget, type StepDeps } from "@bongsu/core/budget";
import { ACCOUNTS_PER_RUN, METRICS_PER_RUN } from "@bongsu/core/constants";
import { scanInbox } from "@bongsu/core/inbox";
import { checkStores } from "@bongsu/core/media/manage";
import { refreshConnections } from "@bongsu/core/providers/refresh";
import { runUpkeep, UPKEEP_STEPS, UPKEEP_UNIT_CALLS } from "@bongsu/core/schedules";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearPlan, MD5, testEnv, World } from "./world";

const NOW = new Date("2026-10-26T03:07:00Z"); // 12:07 in Seoul: past the default workspace's digest hour
const nowS = Math.floor(NOW.getTime() / 1000);
const OLD = "2026-10-26T01:00:00Z";
const NAMES = UPKEEP_STEPS.map(([name]) => name);
const WORKSPACES = ["ws_a", "ws_b", "ws_c", "ws_d"];

let w: World;
/** The world's fetch, counting every call the run makes. */
let calls = 0;
const counted: typeof fetch = (input, init) => {
  calls++;
  return w.fetch(input, init);
};

const lastRun = async () => {
  const r = await env.DB.prepare("SELECT value FROM settings WHERE key = 'run_last:upkeep'").first<{
    value: string;
  }>();
  return r ? JSON.parse(r.value) : null;
};

/** Posted Instagram posts: some a day old (results, metrics, comments), some two hours old (metrics, comments). */
async function seedPosts() {
  const rows: [string, string, number][] = [];
  for (let i = 0; i < 6; i++) rows.push([`reel:day${i}`, i % 2 ? "demo_running" : "demo_travel", nowS - 30 * 3600 - i]);
  for (let i = 0; i < 6; i++) rows.push([`reel:new${i}`, i % 2 ? "demo_running" : "demo_travel", nowS - 2 * 3600 - i]);
  for (const [key, account, at] of rows)
    await env.DB.prepare(
      "INSERT INTO posted (item_key, account, media_id, source, published_at, at) VALUES (?1, ?2, ?3, 'scheduler', ?4, ?4)",
    )
      .bind(key, account, `m_${key.slice(5)}`, at)
      .run();
}

/** An inbox with settled drafts in the default workspace and in four more (each one's folder is its id). */
function seedInboxes() {
  for (const [folder, n] of [["UPLOADS", 4], ...WORKSPACES.map((id) => [id, 2] as const)] as const)
    for (let i = 0; i < n; i++) {
      w.drivePut(`${folder}/inbox/20261001_P/clip${i}.mp4`, { md5: MD5, mimeType: "video/mp4", modified: OLD });
      for (const [ext, text] of [
        ["txt", `Clip ${i}`],
        ["comment.txt", "Where was this?"],
      ])
        w.drivePut(`${folder}/inbox/20261001_P/clip${i}.${ext}`, {
          md5: `${ext}${i}`,
          mimeType: "text/plain",
          bytes: text,
          modified: OLD,
        });
    }
}

let log: { mock: { calls: unknown[][] } };
const lines = (): string[] => log.mock.calls.map(([m]) => String(m));

beforeEach(async () => {
  await env.DB.batch(
    [
      "DELETE FROM locks",
      "DELETE FROM drafts",
      "DELETE FROM inbox_seen",
      "DELETE FROM post_metrics",
      "DELETE FROM post_results",
      "DELETE FROM trial_posts",
      "DELETE FROM comment_polls",
      "DELETE FROM comments",
      "DELETE FROM account_metrics",
      "DELETE FROM snapshots",
      "DELETE FROM media_cleanup",
      "DELETE FROM settings WHERE key LIKE 'run_last:%' OR key LIKE 'metrics_%' OR key LIKE 'account_metrics%' OR key LIKE 'inbox_%' OR key LIKE 'digest_last%' OR key LIKE 'yt_uploads:%'",
      "UPDATE workspaces SET archived_at = 1 WHERE id <> 'default'",
      "UPDATE connections SET last_checked_at = NULL",
      "UPDATE media_store SET last_checked_at = NULL",
    ].map((s) => env.DB.prepare(s)),
  );
  for (const id of WORKSPACES)
    await env.DB.prepare(
      "INSERT INTO workspaces (id, name, created_at) VALUES (?1, ?1, 0) ON CONFLICT (id) DO UPDATE SET archived_at = NULL",
    )
      .bind(id)
      .run();
  await clearPlan();
  w = new World();
  calls = 0;
  w.composio.INSTAGRAM_GET_IG_MEDIA_INSIGHTS = () => ({
    data: ["views", "reach", "likes", "comments", "saved", "shares", "follows", "profile_visits"].map((name) => ({
      name,
      values: [{ value: 10 }],
    })),
  });
  w.composio.INSTAGRAM_GET_IG_MEDIA_COMMENTS = () => ({ data: [] });
  w.composio.INSTAGRAM_GET_USER_INFO = (a) => ({ id: a.ig_user_id, username: "x", followers_count: 120 });
  await seedPosts();
  seedInboxes();
  log = vi.spyOn(console, "log");
});
afterEach(() => vi.restoreAllMocks());

describe("upkeep under RUN_SUBREQUESTS", () => {
  it("stays within the run's limit, runs every step, and records the steps that stopped on their share", async () => {
    const e = await testEnv(env, { RUN_SUBREQUESTS: "50" });
    await runUpkeep(e, counted, NOW);
    expect(calls).toBeGreaterThan(0);
    expect(calls).toBeLessThanOrEqual(50);
    // every step ran: each logged its result (or its failure)
    for (const name of NAMES) expect(lines().some((l) => l.startsWith(`upkeep: ${name} `))).toBe(true);
    const last = await lastRun();
    expect(last).toMatchObject({ at: nowS, used: calls, limit: 50, invalid: null });
    // more work than fits: some steps stopped on their share, the ones whose log says so, in order
    const stopped = NAMES.filter((n) =>
      lines().some((l) => l.startsWith(`upkeep: ${n} `) && l.endsWith("(stopped: out of calls for this run)")),
    );
    expect(stopped.length).toBeGreaterThan(0);
    expect(last.stopped).toEqual(stopped);
    // the lock is freed
    expect(await env.DB.prepare("SELECT 1 FROM locks WHERE name = 'upkeep'").first()).toBeNull();
  });

  it("leaves the inbox, first, most of the run, and still a unit for every step after it", async () => {
    // Compared in the steady state, each inbox folder's id already cached (settings.inbox_folder:*), as every run
    // after a workspace's first: a first run also walks the path to each inbox.
    const again = () =>
      env.DB.batch(
        [
          "DELETE FROM drafts",
          "DELETE FROM inbox_seen",
          "DELETE FROM settings WHERE key IN ('inbox_cursor', 'inbox_last')",
        ].map((q) => env.DB.prepare(q)),
      );
    await scanInbox(await testEnv(env), { fetch: w.fetch, now: NOW });
    await again();
    // the inbox alone under its own caps, as before the run had a budget
    const before = await scanInbox(await testEnv(env), { fetch: w.fetch, now: NOW });
    expect(before.drafted.length).toBeGreaterThan(0);
    await again();
    const e = await testEnv(env, { RUN_SUBREQUESTS: "50" }); // the token and folder caches cleared too
    calls = 0;
    const shares = new Map<string, number>();
    const watched = UPKEEP_STEPS.map(
      ([name, run]) =>
        [
          name,
          (en: typeof e, deps: StepDeps) => {
            shares.set(name, deps.budget?.left() ?? 0);
            return run(en, deps);
          },
        ] as const,
    );
    await runUpkeep(e, counted, NOW, watched);
    expect(calls).toBeLessThanOrEqual(50);
    const drafted = await env.DB.prepare("SELECT COUNT(*) AS n FROM drafts").first<{ n: number }>();
    expect(drafted?.n).toBeGreaterThanOrEqual(before.drafted.length);
    for (const name of NAMES.slice(1)) expect(shares.get(name)).toBeGreaterThanOrEqual(UPKEEP_UNIT_CALLS[name]);
  });

  it("pays the steps' notifications from the run's reserve: an inbox that spent its share still announces its drafts", async () => {
    // Whatever the limit, a run that drafted something says so: at some limits the drafts end the inbox's share
    // exactly, and the note then comes out of the reserve.
    const inboxOnly = UPKEEP_STEPS.filter(([name]) => name === "inbox");
    let drafted = false;
    for (let limit = 12; limit <= 30; limit++) {
      await env.DB.batch(
        ["DELETE FROM drafts", "DELETE FROM inbox_seen", "DELETE FROM settings WHERE key LIKE 'inbox_%'"].map((q) =>
          env.DB.prepare(q),
        ),
      );
      w.notifications.length = 0;
      calls = 0;
      await runUpkeep(await testEnv(env, { RUN_SUBREQUESTS: String(limit) }), counted, NOW, inboxOnly);
      expect(calls, `at ${limit}`).toBeLessThanOrEqual(limit);
      // the default workspace's topic is the world's ntfy (the others have none)
      const mine = await env.DB.prepare("SELECT COUNT(*) AS n FROM drafts WHERE workspace_id = 'default'").first<{
        n: number;
      }>();
      const told = w.notifications.filter((n) => /new drafts? from the inbox$/.test(n.title));
      expect(told.length, `at ${limit}`).toBe(mine?.n ? 1 : 0);
      if (mine?.n) drafted = true;
    }
    expect(drafted).toBe(true);
  });

  it("stops a step that ignores its share, and the steps after it still run", async () => {
    const e = await testEnv(env, { RUN_SUBREQUESTS: "50" });
    const greedy = UPKEEP_STEPS.map(([name, run]) =>
      name === "comments"
        ? ([
            name,
            async (_env: unknown, deps: { fetch: typeof fetch }) => {
              // it shrugs off every failure but the budget's, and never checks its share
              for (;;)
                await deps.fetch("https://example.com/comments").catch((e: Error) => {
                  if (e.name === "BudgetSpent") throw e;
                });
            },
          ] as const)
        : ([name, run] as const),
    );
    await runUpkeep(e, counted, NOW, greedy as unknown as typeof UPKEEP_STEPS);
    expect(calls).toBeLessThanOrEqual(50);
    expect(lines()).toContain("upkeep: comments failed: call budget spent for comments");
    for (const name of ["connections", "media stores"]) {
      const line = lines().find((l) => l.startsWith(`upkeep: ${name} `));
      expect(line).toBeDefined();
      expect(line).not.toContain(`${name} failed:`);
    }
    // the media store was checked, the connections renewed: they had calls left after the greedy step
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM media_store WHERE last_checked_at = ?1")
        .bind(nowS)
        .first<{ n: number }>(),
    ).toEqual({ n: 1 });
    expect((await lastRun()).stopped).toContain("comments");
  });

  it("unlimited: the per-step caps still bound the work", async () => {
    const e = await testEnv(env, { RUN_SUBREQUESTS: "unlimited" });
    await runUpkeep(e, counted, NOW);
    // the same work as above takes more than 50 calls without a limit
    expect(calls).toBeGreaterThan(50);
    expect(METRICS_PER_RUN).toBe(4);
    expect(ACCOUNTS_PER_RUN).toBe(4);
    // results samples the day-old posts it reports on (3 a run); the sampler adds METRICS_PER_RUN of its own
    const sampled = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM post_metrics WHERE item_key NOT IN (SELECT item_key FROM post_results)",
    ).first<{ n: number }>();
    expect(sampled?.n).toBe(METRICS_PER_RUN);
    const accounts = await env.DB.prepare("SELECT COUNT(*) AS n FROM account_metrics").first<{ n: number }>();
    expect(accounts?.n).toBe(ACCOUNTS_PER_RUN);
    const last = await lastRun();
    expect(last).toMatchObject({ used: calls, limit: "unlimited", stopped: [], invalid: null });
    for (const name of NAMES) expect(lines().some((l) => l.startsWith(`upkeep: ${name} `))).toBe(true);
  });
});

describe("a step whose call is refused past its share", () => {
  /** A budget that lets every unit start, then refuses its first call: a unit that cost more than its step foresaw. */
  const refusing = (name: string): StepBudget => ({
    name,
    fetch: () => Promise.reject(new BudgetSpent(name)),
    left: () => 1,
    canAfford: () => true,
    used: () => 0,
  });
  const deps = (name: string) => {
    const budget = refusing(name);
    return { fetch: budget.fetch, now: NOW, budget };
  };

  it("doesn't take it for the connection's, the store's or the account's failure", async () => {
    const e = await testEnv(env);
    expect(await refreshConnections(e, deps("connections"))).toEqual({ renewed: [], failed: [] });
    const conns = await env.DB.prepare(
      "SELECT status, last_checked_at FROM connections WHERE provider = 'youtube'",
    ).all();
    for (const c of conns.results) expect(c).toEqual({ status: "ok", last_checked_at: null });

    expect(await checkStores(e, deps("media stores"))).toEqual({ checked: [], broken: [] });
    expect(await env.DB.prepare("SELECT status, last_checked_at FROM media_store").first()).toMatchObject({
      last_checked_at: null,
    });

    expect(await sampleAccounts(e, deps("accounts"))).toEqual({ sampled: [], backfilled: 0 });
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM settings WHERE key LIKE 'account_metrics_failed:%'").first(),
    ).toEqual({ n: 0 });
  });
});
