// Every media path under the workspace's own folder (Phase 13, part 3a): two workspaces share the instance's bucket,
// each in its own folder, and a file of one is never the other's: items by path, the tick, cleanup, app uploads.
import { env, exports } from "cloudflare:workers";
import { createApp } from "@bongsu/api/app";
import { resolveItem } from "@bongsu/api/pwa/approve";
import { createSession } from "@bongsu/api/pwa/session";
import { draftFromUploads, startUpload, UploadError } from "@bongsu/api/pwa/uploads";
import { upsertAccount, upsertConnection } from "@bongsu/core/accounts";
import { cleanMedia, MOVE_AFTER_S } from "@bongsu/core/cleanup";
import { addApproval } from "@bongsu/core/data";
import type { Env } from "@bongsu/core/env";
import { sha256Hex } from "@bongsu/core/formats/approved";
import { serveMedia, signedLink } from "@bongsu/core/media";
import { mediaStoreById, mediaStores } from "@bongsu/core/media/index";
import { saveStore } from "@bongsu/core/media/manage";
import { createWorkspace } from "@bongsu/core/people";
import { tick } from "@bongsu/core/tick";
import { setMediaFolder } from "@bongsu/core/workspaces";
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearPlan,
  igHappyPath,
  localToUnix,
  planItem,
  seedReel,
  seedS3Store,
  TEST_S3_KEYS,
  TEST_S3_SETTINGS,
  testEnv,
  World,
} from "./world";

let e: Env;
let w: World;
let B: string; // workspace "client-b"
const FOLDER = "vlogs/CONTENT/20261101_TRIP";
const mp4 = (base: string) => `${FOLDER}/exports/shorts/instagram/${base}.mp4`;

beforeEach(async () => {
  w = new World();
  await clearPlan();
  // the workspaces made by earlier tests (the database outlives them)
  await env.DB.batch(
    [
      "DELETE FROM media_store WHERE workspace_id IS NOT NULL",
      "DELETE FROM accounts WHERE id = 'b_shop'",
      "DELETE FROM connections WHERE id = 'c_b_shop'",
      "DELETE FROM memberships WHERE workspace_id LIKE 'w_%'",
      "DELETE FROM workspace_settings WHERE workspace_id LIKE 'w_%'",
      "DELETE FROM workspaces WHERE id LIKE 'w_%'",
      "DELETE FROM plan_items",
      "DELETE FROM users WHERE id IN ('u1', 'bea', 'cy')",
    ].map((s) => env.DB.prepare(s)),
  );
  await env.DB.batch(
    ["DELETE FROM approvals", "DELETE FROM drafts", "DELETE FROM jobs", "DELETE FROM media_cleanup"].map((s) =>
      env.DB.prepare(s),
    ),
  );
  e = await testEnv(env);
  await seedS3Store({ isDefault: true }); // the instance's bucket, shared
  B = await createWorkspace(
    env.DB,
    { name: "Demo Studio B", timezone: "UTC", createdBy: "owner", mediaFolder: "client-b" },
    0,
  );
  await upsertConnection(
    env.DB,
    { id: "c_b_shop", workspaceId: B, provider: "composio", kind: "composio", externalRef: "instagram_conn-b2" },
    0,
  );
  await upsertAccount(
    env.DB,
    {
      id: "b_shop",
      workspaceId: B,
      platform: "instagram",
      handle: "b_shop",
      externalId: "17841400000000099",
      connectionId: "c_b_shop",
    },
    0,
  );
});

const fileId = async (path: string) => (await (await mediaStores(e, w.fetch, B)).get("s3")!.resolve(path))!.id;

describe("an item by path", () => {
  it("resolves under its own workspace's folder, never another's same-named one", async () => {
    const key = await planItem({ folder: FOLDER, name: "short1_b", date: "2026-11-01", workspaceId: B });
    await w.s3.put(`UPLOADS/${mp4("short1_b")}`, "from A's folder", "video/mp4"); // A's folder, same project and name
    const none = await resolveItem(e, w.fetch, key, "UTC", B);
    expect(none?.media).toEqual([]);
    expect(none?.problems.join()).toContain(`not in the media store yet: client-b/${mp4("short1_b")}`);
    await w.s3.put(`client-b/${mp4("short1_b")}`, "B's", "video/mp4");
    const found = await resolveItem(e, w.fetch, key, "UTC", B);
    expect(found?.media.map((m) => [m.store, m.name])).toEqual([["s3", "short1_b.mp4"]]);
    expect(found?.problems.join()).not.toContain("not in the media store");
  });

  it("follows a renamed folder: files left in the old one are no longer found", async () => {
    const key = await planItem({ folder: FOLDER, name: "short1_b", date: "2026-11-01", workspaceId: B });
    await w.s3.put(`client-b/${mp4("short1_b")}`, "B's", "video/mp4");
    expect((await resolveItem(e, w.fetch, key, "UTC", B))?.media).toHaveLength(1);
    await setMediaFolder(env.DB, B, "client-b2", 1);
    const r = await resolveItem(e, w.fetch, key, "UTC", B);
    expect(r?.problems.join()).toContain(`not in the media store yet: client-b2/${mp4("short1_b")}`);
  });
});

describe("the tick", () => {
  it("publishes a workspace's item from its own store, which the instance's stores don't include", async () => {
    await saveStore(e, w.fetch, { workspaceId: B }, "s3", TEST_S3_SETTINGS, JSON.stringify(TEST_S3_KEYS), "owner", 0);
    const { key, base } = await seedReel(w, { base: "short1_t", account: "b_shop", approve: false });
    await env.DB.prepare("UPDATE plan_items SET workspace_id = ?1 WHERE item_key = ?2").bind(B, key).run();
    const caption = "A caption\n\nWhere next?\n\n#travel";
    const comment = "📍 Somewhere. Have you been?";
    await w.s3.put(`client-b/${mp4(base)}`, "video", "video/mp4");
    const stores = await mediaStores(e, w.fetch, B);
    const own = stores.default!;
    expect(own.id).toBe(`s3-${B}`);
    const f = (await own.resolve(`client-b/${mp4(base)}`))!;
    await addApproval(env.DB, {
      key,
      account: "b_shop",
      dueAt: await localToUnix("2026-10-20", "18:00"),
      captionSha256: await sha256Hex(caption),
      commentSha256: await sha256Hex(comment),
      altSha256: null,
      media: [{ store: own.id, id: f.id, checksum: f.checksum }],
      approvedAt: "2026-10-17T01:00:00Z",
      approvedBy: "owner@test",
    });
    igHappyPath(w);
    for (const m of [1, 6, 11, 16]) await tick(e, { fetch: w.fetch, now: new Date(Date.UTC(2026, 9, 20, 9, m)) });
    const create = w.calls.find((c) => c.slug === "INSTAGRAM_POST_IG_USER_MEDIA");
    // the bucket's presigned URL of the file in client-b/, not a link through this server
    expect(JSON.stringify(create?.args)).toMatch(/s3\.test\/media\/client-b\//);
    expect(
      await env.DB.prepare("SELECT workspace_id FROM posted WHERE item_key = ?1").bind(key).first("workspace_id"),
    ).toBe(B);
  });
});

describe("cleanup", () => {
  it("moves a workspace's posted file into its own folder's _posted", async () => {
    const key = await planItem({
      folder: FOLDER,
      name: "short1_c",
      date: "2026-10-01",
      workspaceId: B,
      account: "b_shop",
    });
    await w.s3.put(`client-b/${mp4("short1_c")}`, "video", "video/mp4");
    await w.s3.put(`UPLOADS/${mp4("short1_c")}`, "A's", "video/mp4");
    const f = await (await mediaStores(e, w.fetch, B)).get("s3")!.resolve(`client-b/${mp4("short1_c")}`);
    await addApproval(env.DB, {
      key,
      account: "b_shop",
      dueAt: 1_790_000_000,
      captionSha256: "c",
      commentSha256: null,
      altSha256: null,
      media: [],
      approvedAt: "2026-10-01T00:00:00Z",
      approvedBy: "owner@test",
    });
    expect(f).toBeTruthy();
    await env.DB.prepare(
      "INSERT INTO posted (item_key, account, published_at, permalink, source, workspace_id) VALUES (?1, 'b_shop', 1790000000, 'https://example.com/p/', 'manual', ?2)",
    )
      .bind(key, B)
      .run();
    // no approved media: the item's own path, in the workspace's folder
    await env.DB.prepare("DELETE FROM approvals").run();
    const r = await cleanMedia(e, { fetch: w.fetch, now: new Date((1_790_000_000 + MOVE_AFTER_S + 60) * 1000) });
    expect(r.moved).toBe(1);
    expect(w.s3.objects.has("client-b/_posted/short1_c.mp4")).toBe(true);
    expect(w.s3.objects.has(`client-b/${mp4("short1_c")}`)).toBe(false);
    expect(w.s3.objects.has(`UPLOADS/${mp4("short1_c")}`)).toBe(true); // A's file stays
    expect(w.s3.objects.has("UPLOADS/_posted/short1_c.mp4")).toBe(false);
  });
});

describe("uploads from the app", () => {
  it("land in the workspace's _uploads, and a draft from them in another workspace is refused", async () => {
    await env.DB.prepare(
      "INSERT INTO users (id, email, name, created_at) VALUES ('u1', 'u1@example.com', 'U', 0)",
    ).run();
    const t = await startUpload(e, w.fetch, { name: "a.jpg", mimeType: "image/jpeg", size: 10, store: "s3" }, B);
    const key = atob(t.id!.replace(/-/g, "+").replace(/_/g, "/"));
    expect(key).toMatch(/^client-b\/_uploads\/a-/);
    await w.s3.put(key, "jpeg", "image/jpeg");
    const body = { files: [t.id], store: "s3", project: "trip", name: "p1" };
    expect((await draftFromUploads(e, w.fetch, body, 1, B, "u1")).id).toMatch(/^d_/);
    await expect(draftFromUploads(e, w.fetch, body, 1, "default", "u1")).rejects.toThrow(/isn't an upload of this app/);
    await expect(draftFromUploads(e, w.fetch, body, 1, "default", "u1")).rejects.toBeInstanceOf(UploadError);
  });
});

describe("/m links", () => {
  it("serve a file of a workspace's own store, found by id among all rows", async () => {
    await saveStore(e, w.fetch, { workspaceId: B }, "s3", TEST_S3_SETTINGS, JSON.stringify(TEST_S3_KEYS), "owner", 0);
    await w.s3.put("client-b/x/a.jpg", "jpeg", "image/jpeg");
    const own = (await mediaStores(e, w.fetch, B)).get(`s3-${B}`)!;
    const id = (await own.resolve("client-b/x/a.jpg"))!.id;
    const now = 1_800_000_000;
    const link = await signedLink("https://s.test", "k", own.id, id, "jpg", now + 60);
    const lookup = (s: string) => mediaStoreById(e, w.fetch, s);
    const r = await serveMedia(new Request(link), "k", lookup, now);
    expect([r.status, await r.text()]).toEqual([200, "jpeg"]);
    const missing = await signedLink("https://s.test", "k", "s3-w_nope", id, "jpg", now + 60);
    expect((await serveMedia(new Request(missing), "k", lookup, now)).status).toBe(404);
    expect(await fileId("client-b/x/a.jpg")).toBe(id); // the instance's store reads the same bucket
  });
});

describe("the default store", () => {
  it("falls back to the instance's default when the workspace's own can't be built", async () => {
    await env.DB.prepare(
      "INSERT INTO media_store (id, kind, workspace_id, is_default, settings, credentials, status, updated_at) VALUES (?1, 'drive', ?2, 1, '{}', 'not-decryptable', 'ok', 0)",
    )
      .bind(`drive-${B}`, B)
      .run();
    const stores = await mediaStores(e, w.fetch, B);
    expect(stores.errors.has(`drive-${B}`)).toBe(true);
    expect(stores.default?.id).toBe("s3"); // the instance's default, not merely the first of the stores left
    expect(stores.all.map((s) => s.id)).toEqual(["drive", "s3"]);
  });
});

describe("/health", () => {
  it("is the instance's: a workspace's broken store doesn't fail it", async () => {
    const ok = await createApp(w.fetch).request("/health", {}, e);
    expect(ok.status).toBe(200);
    await env.DB.prepare(
      "INSERT INTO media_store (id, kind, workspace_id, is_default, settings, status, updated_at) VALUES (?1, 's3', ?2, 0, '{}', 'broken', 0)",
    )
      .bind(`s3-${B}`, B)
      .run();
    const h = await createApp(w.fetch).request("/health", {}, e);
    expect(h.status).toBe(200);
    expect(((await h.json()) as { media_stores: unknown[] }).media_stores).toHaveLength(2); // drive, s3
  });
});

describe("the app's list of stores", () => {
  const list = async (userId: string) => {
    const token = await createSession(env.DB, Math.floor(Date.now() / 1000), { app: "pwa", userId });
    const r = await exports.default.fetch("https://scheduler.test/app-api/media-stores", {
      headers: { Cookie: `bongsu_session=${token}` },
    });
    return ((await r.json()) as { stores: { id: string; own: boolean; default: boolean }[] }).stores;
  };
  beforeEach(async () => {
    await env.DB.batch(
      [
        "INSERT INTO users (id, email, name, created_at) VALUES ('bea', 'bea@example.com', 'Bea', 0) ON CONFLICT (id) DO NOTHING",
        "INSERT INTO users (id, email, name, created_at) VALUES ('cy', 'cy@example.com', 'Cy', 0) ON CONFLICT (id) DO NOTHING",
        "INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES ('default', 'cy', 'admin', 0) ON CONFLICT DO NOTHING",
      ].map((s) => env.DB.prepare(s)),
    );
    await env.DB.prepare(
      "INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES (?1, 'bea', 'admin', 0)",
    )
      .bind(B)
      .run();
  });

  it("gives each store's id and whether it is the workspace's own, marking only the effective default", async () => {
    // a workspace with none of its own: the instance's default (the first row, drive) alone
    expect(await list("cy")).toEqual([
      { id: "drive", kind: "drive", own: false, default: false, status: "ok", where: null },
      { id: "s3", kind: "s3", own: false, default: true, status: "ok", where: "media" },
    ]);
    await saveStore(e, w.fetch, { workspaceId: B }, "s3", TEST_S3_SETTINGS, JSON.stringify(TEST_S3_KEYS), "owner", 0);
    const own = await list("bea");
    expect(own.map((s) => [s.id, s.own, s.default])).toEqual([
      ["drive", false, false],
      ["s3", false, false],
      [`s3-${B}`, true, true], // its own default wins; the instance's isn't marked too
    ]);
  });
});
