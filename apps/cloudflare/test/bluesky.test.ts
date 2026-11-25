// Bluesky (docs/superpowers/specs/2026-11-25-bluesky-design.md): the approval page, the provider and the tick.
import { env } from "cloudflare:workers";
import { resolveItem } from "@bongsu/api/pwa/approve";
import { upsertAccount, upsertConnection } from "@bongsu/core/accounts";
import { beforeEach, describe, expect, it } from "vitest";
import { clearPlan, localToUnix, testEnv, World } from "./world";

const KEY = "post:20261020_DEMO/photo";

async function seedAccount() {
  await upsertConnection(
    env.DB,
    {
      workspaceId: "default",
      id: "c_demo_bluesky",
      provider: "bluesky-atproto",
      kind: "service",
      secretName: "UNUSED",
    },
    0,
  );
  await upsertAccount(
    env.DB,
    {
      workspaceId: "default",
      id: "demo_bluesky",
      platform: "bluesky",
      handle: "demo_travel.bsky.social",
      externalId: "did:plc:demotravel0000000000000",
      connectionId: "c_demo_bluesky",
    },
    0,
  );
}

/** A draft-made image post with one image in the Drive store of the given size. */
async function seedImagePost(w: World, size: number) {
  const id = w.drivePut("UPLOADS/_uploads/photo.jpg", { md5: "a".repeat(32), mimeType: "image/jpeg", size });
  await env.DB.prepare(
    "INSERT INTO plan_items (item_key, format, account, folder, name, due_at, options, hold, sort, created_at, updated_at, workspace_id, content, media, caption) VALUES (?1, 'image', 'demo_bluesky', '20261020_DEMO', 'photo', ?2, '{}', 0, 1, 0, 0, 'default', 'db', ?3, 'A photo')",
  )
    .bind(KEY, await localToUnix("2026-10-20", "18:00"), JSON.stringify([{ store: "drive", id }]))
    .run();
}

const problems = async (w: World) =>
  (await resolveItem(await testEnv(env), w.fetch, KEY, "Asia/Seoul", "default"))!.problems;

beforeEach(async () => {
  await clearPlan();
  await seedAccount();
});

describe("bluesky approval", () => {
  it("takes an image of exactly 1 MB", async () => {
    const w = new World();
    await seedImagePost(w, 1_000_000);
    expect((await problems(w)).filter((p) => /takes images/.test(p))).toEqual([]);
  });

  it("refuses an image over 1 MB", async () => {
    const w = new World();
    await seedImagePost(w, 1_000_001);
    expect(await problems(w)).toContain("photo.jpg is 1.0 MB; Bluesky takes images up to 1 MB");
  });
});
