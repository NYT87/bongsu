// Accounts and connections from the database (Phase 3): what the scheduler posts to, how it reaches each platform,
// and the Trial Reels default.

import { env } from "cloudflare:workers";
import {
  connectionSecret,
  findAccount,
  instagramAccounts,
  listAccounts,
  setAccountSettings,
  trialDefaultOn,
  upsertAccount,
  upsertConnection,
} from "@bongsu/core/accounts";
import { encryptSecret } from "@bongsu/core/crypto";
import { trialDefault } from "@bongsu/core/data";
import { tick } from "@bongsu/core/tick";
import { beforeEach, describe, expect, it } from "vitest";
import { clearPlan, seedReel, testEnv, World } from "./world";

beforeEach(async () => {
  await clearPlan();
  await env.DB.prepare("DELETE FROM jobs").run();
});

describe("accounts", () => {
  it("lists the workspace's active accounts in order, finds one by id or handle", async () => {
    await testEnv(env);
    expect((await instagramAccounts(env.DB)).map((a) => a.id)).toEqual(["demo_travel", "demo_running", "demo_cycling"]);
    expect((await listAccounts(env.DB, { platform: "youtube" })).map((a) => a.id)).toEqual(["main", "vlogs"]);
    expect((await findAccount(env.DB, "demo_running", "default"))?.connection?.externalRef).toBe("instagram_conn-b");
    expect(await findAccount(env.DB, "demo_running", "other-workspace")).toBeNull();
    await env.DB.prepare("UPDATE accounts SET status = 'disabled' WHERE id = 'demo_cycling'").run();
    expect((await instagramAccounts(env.DB)).map((a) => a.id)).toEqual(["demo_travel", "demo_running"]);
    expect(await findAccount(env.DB, "demo_cycling", "default")).not.toBeNull(); // still there, just not posted to
  });

  it("keeps the Trial Reels default in the account's settings", async () => {
    await testEnv(env);
    expect(await trialDefault(env.DB, "demo_running", "default")).toEqual({ capable: true, on: true });
    expect(await trialDefault(env.DB, "demo_travel", "default")).toEqual({ capable: false, on: false });
    await setAccountSettings(env.DB, "demo_running", { trialReels: false }, 1);
    expect(await trialDefault(env.DB, "demo_running", "default")).toEqual({ capable: true, on: false });
    const a = await findAccount(env.DB, "demo_running", "default");
    expect(trialDefaultOn(a!)).toBe(false);
  });
});

describe("connections", () => {
  it("reads credentials from the variable it names, or decrypts them from the database", async () => {
    const e = await testEnv(env, { ENCRYPTION_KEY: "an-encryption-key-for-the-tests" });
    const main = await findAccount(env.DB, "main", "default");
    expect(JSON.parse((await connectionSecret(e, main!.connection))!).refresh_token).toBe("r-main");

    const sealed = await encryptSecret("an-encryption-key-for-the-tests", '{"refresh_token":"r-db"}');
    await upsertConnection(
      env.DB,
      { workspaceId: "default", id: "c_db", provider: "youtube", kind: "oauth", credentials: sealed },
      1,
    );
    await upsertAccount(
      env.DB,
      { workspaceId: "default", id: "third", platform: "youtube", handle: "third", connectionId: "c_db" },
      1,
    );
    const third = await findAccount(env.DB, "third", "default");
    expect(JSON.parse((await connectionSecret(e, third!.connection))!).refresh_token).toBe("r-db");
    await expect(
      connectionSecret({ ...e, ENCRYPTION_KEY: "a-different-long-key-0000" }, third!.connection),
    ).rejects.toThrow(/can't decrypt/);
    expect(await connectionSecret(e, null)).toBeNull();
    await env.DB.prepare("DELETE FROM accounts WHERE id = 'third'").run();
  });

  it("doesn't queue anything for an Instagram account without a Composio connection", async () => {
    const w = new World();
    const e = await testEnv(env);
    await seedReel(w, { account: "demo_travel" });
    await env.DB.prepare("UPDATE accounts SET connection_id = NULL WHERE id = 'demo_travel'").run();
    await tick(e, { fetch: w.fetch, now: new Date("2026-10-20T10:00:00Z") });
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs").first<{ n: number }>())!.n).toBe(0);
  });
});
