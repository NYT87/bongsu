// Pause and resume act on one workspace (Phase 13): pausing workspace B holds B's jobs and Shorts comments, the
// default workspace goes on publishing; resuming (with a passkey) releases only B.
import { env, exports } from "cloudflare:workers";
import { appRoutes } from "@bongsu/api/pwa/routes";
import { createSession } from "@bongsu/api/pwa/session";
import type { Verifiers } from "@bongsu/api/pwa/webauthn";
import { upsertAccount, upsertConnection } from "@bongsu/core/accounts";
import { buildDigest } from "@bongsu/core/digest";
import type { Env } from "@bongsu/core/env";
import { sha256Hex } from "@bongsu/core/formats/approved";
import { tick } from "@bongsu/core/tick";
import { setWorkspaceSettings } from "@bongsu/core/workspaces";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  approve,
  approveShort,
  clearPlan,
  copyText,
  igHappyPath,
  MD5,
  planItem,
  seedReel,
  testEnv,
  World,
} from "./world";

const AT = new Date("2026-10-20T09:32:00Z"); // 18:32 KST: both Reels below are due
const later = (min: number) => new Date(AT.getTime() + min * 60_000);
const KEY_A = "bongsu_pauseApauseApauseApauseApa";
const KEY_B = "bongsu_pauseBpauseBpauseBpauseBpa";
const fake: Verifiers = {
  registration: (async () => ({ verified: true })) as unknown as Verifiers["registration"],
  authentication: (async () => ({
    verified: true,
    authenticationInfo: { newCounter: 1 },
  })) as unknown as Verifiers["authentication"],
};
const origFetch = globalThis.fetch;
let w: World;
let e: Env;

/** Cara, workspace B's creator, in the app (her session works in B). */
async function asCara() {
  const cookie = `bongsu_session=${await createSession(env.DB, Math.floor(Date.now() / 1000), { userId: "cara" })}`;
  return async (path: string, body: unknown = {}) => {
    const r = await appRoutes(w.fetch, fake).request(
      `https://bongsu.test${path}`,
      { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify(body) },
      e,
    );
    return { status: r.status, json: (await r.json()) as Record<string, unknown> };
  };
}

const status = async (key: string) => {
  const r = await exports.default.fetch("https://scheduler.test/v1/status", {
    headers: { Authorization: `Bearer ${key}` },
  });
  return (await r.json()) as { paused: boolean };
};
const jobState = async (key: string) =>
  env.DB.prepare("SELECT state FROM jobs WHERE item_key = ?1").bind(key).first<string>("state");

/** An approved Reel of workspace B's b_shop, due with the default workspace's at 18:00 Seoul time. */
async function seedReelB() {
  const folder = "shop/CONTENT/20261020_SALE";
  const key = await planItem({ folder, name: "short1_sale", account: "b_shop", workspaceId: "b", location: "111" });
  const caption = "Sale today";
  const comment = "Which one?";
  await copyText(`channels/${folder}/shorts/instagram/short1_sale.txt`, `${caption}\n`);
  await copyText(`channels/${folder}/shorts/instagram/short1_sale.comment.txt`, `${comment}\n`);
  w.drive.set("drive_short1_sale_000000", { md5: MD5, mimeType: "video/mp4" });
  await approve(key, {
    due: "2026-10-20 18:00",
    caption,
    comment,
    media: [{ driveId: "drive_short1_sale_000000", md5: MD5 }],
  });
  return key;
}

beforeEach(async () => {
  w = new World();
  globalThis.fetch = w.fetch;
  await clearPlan();
  await env.DB.batch(
    ["DELETE FROM jobs", "DELETE FROM audit", "DELETE FROM locks", "DELETE FROM api_keys", "DELETE FROM sessions"].map(
      (s) => env.DB.prepare(s),
    ),
  );
  e = await testEnv(env, { PUBLIC_URL: "https://bongsu.test", RP_ID: "bongsu.test" } as Partial<Env>);
  await env.DB.batch(
    [
      "INSERT INTO workspaces (id, name, created_at) VALUES ('b', 'Workspace B', 0) ON CONFLICT (id) DO NOTHING",
      "INSERT INTO users (id, email, name, created_at) VALUES ('cara', 'cara@example.com', 'Cara', 0) ON CONFLICT (id) DO NOTHING",
      "INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES ('b', 'cara', 'creator', 0) ON CONFLICT DO NOTHING",
      "INSERT INTO passkeys (id, public_key, counter, transports, name, created_at, user_id) VALUES ('cred-cara', 'AQID', 0, NULL, 'phone', 0, 'cara') ON CONFLICT (id) DO NOTHING",
    ].map((s) => env.DB.prepare(s)),
  );
  await setWorkspaceSettings(env.DB, "b", { timezone: "Europe/Madrid", digestHour: 8 }, 0);
  await upsertConnection(
    env.DB,
    { id: "c_b", workspaceId: "b", provider: "composio", kind: "composio", externalRef: "instagram_conn-b2" },
    0,
  );
  await upsertAccount(
    env.DB,
    {
      id: "b_shop",
      workspaceId: "b",
      platform: "instagram",
      handle: "b_shop",
      externalId: "17841400000000099",
      connectionId: "c_b",
    },
    0,
  );
  for (const [id, key, ws] of [
    ["ka", KEY_A, "default"],
    ["kb", KEY_B, "b"],
  ])
    await env.DB.prepare(
      'INSERT INTO api_keys (id, name, key_hash, scopes, workspace_id) VALUES (?1, ?1, ?2, \'["read","pause"]\', ?3)',
    )
      .bind(id, await sha256Hex(key), ws)
      .run();
});
afterEach(() => {
  globalThis.fetch = origFetch;
});

describe("pause per workspace", () => {
  it("pausing one workspace holds only its jobs; resuming only resumes it", async () => {
    const a = (await seedReel(w)).key; // the default workspace's
    const b = await seedReelB();
    // both get their job; Instagram is busy, so both stay pending
    w.composio.INSTAGRAM_POST_IG_USER_MEDIA = () => {
      throw new Error("Instagram busy");
    };
    await tick(e, { fetch: w.fetch, now: AT });
    expect([await jobState(a), await jobState(b)]).toEqual(["pending", "pending"]);

    const cara = await asCara();
    expect((await cara("/app-api/pause", { reason: "checking the sale" })).json).toMatchObject({ paused: true });
    const audit = await env.DB.prepare("SELECT workspace_id, target FROM audit WHERE action = 'pause'").all();
    expect(audit.results).toEqual([{ workspace_id: "b", target: "workspace:b" }]);

    igHappyPath(w);
    await tick(e, { fetch: w.fetch, now: later(5) });
    expect([await jobState(a), await jobState(b)]).toEqual(["container_created", "pending"]);
    expect(await status(KEY_B)).toMatchObject({ paused: true });
    expect(await status(KEY_A)).toMatchObject({ paused: false });
    // the pause is in B's audit once, when it happened: the tick's runs (two parts, every few minutes) add nothing
    await tick(e, { fetch: w.fetch, now: later(6) }, "shorts");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'paused'").first("n")).toBe(0);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'pause'").first("n")).toBe(1);
    // the digest says so, for B only
    expect((await buildDigest(e, w.fetch, later(5), { workspaceId: "b", timezone: "Europe/Madrid" })).text).toContain(
      "Publishing is paused",
    );
    expect(
      (await buildDigest(e, w.fetch, later(5), { workspaceId: "default", timezone: "Asia/Seoul" })).text,
    ).not.toContain("Publishing is paused");

    // resuming needs Cara's passkey, and resumes B
    const o = (await cara("/app-api/resume/options")).json as { challengeId: string };
    expect(
      (await cara("/app-api/resume/verify", { challengeId: o.challengeId, response: { id: "cred-cara" } })).json,
    ).toEqual({ paused: false, wasPaused: true });
    expect(await status(KEY_B)).toMatchObject({ paused: false });
    await tick(e, { fetch: w.fetch, now: later(10) });
    expect(await jobState(b)).toBe("container_created");
    const resumed = await env.DB.prepare("SELECT workspace_id FROM audit WHERE action = 'resume'").all();
    expect(resumed.results).toEqual([{ workspace_id: "b" }]);
  });

  it("an agent key pauses only its own workspace", async () => {
    const r = await exports.default.fetch("https://scheduler.test/v1/pause", {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY_A}`, "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "caption typo" }),
    });
    expect(await r.json()).toMatchObject({ paused: true });
    expect(await status(KEY_A)).toMatchObject({ paused: true });
    expect(await status(KEY_B)).toMatchObject({ paused: false });
  });

  it("a paused workspace's Shorts comments wait, and go out once it resumes", async () => {
    await env.DB.prepare(
      "INSERT INTO shorts_comments (video_id, channel, file, label, sort) VALUES ('vidPUBLIC01', 'main', 'channels/main/c1.comment.txt', 'short1', 1)",
    ).run();
    await copyText("channels/main/c1.comment.txt", "Full video: https://youtu.be/x\n");
    await approveShort("vidPUBLIC01", "Full video: https://youtu.be/x");
    w.ytPrivacy.set("vidPUBLIC01", "public");
    const cara = await asCara();
    // B's pause leaves the default workspace's channel alone
    await cara("/app-api/pause", { reason: "x" });
    await tick(e, { fetch: w.fetch, now: AT }, "shorts");
    expect(w.ytComments).toHaveLength(1);
    await env.DB.batch(["DELETE FROM shorts_commented", "DELETE FROM jobs"].map((s) => env.DB.prepare(s)));
    w.ytComments.length = 0;
    // the default workspace's own pause holds it
    await exports.default.fetch("https://scheduler.test/v1/pause", {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY_A}`, "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "x" }),
    });
    await tick(e, { fetch: w.fetch, now: later(5) }, "shorts");
    expect(w.ytComments).toEqual([]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'comment'").first("n")).toBe(0);
  });
});
