import { env } from "cloudflare:workers";
import { upsertAccount, upsertConnection } from "@bongsu/core/accounts";
import { cleanMedia } from "@bongsu/core/cleanup";
import { scanInbox } from "@bongsu/core/inbox";
import { beforeEach, describe, expect, it } from "vitest";
import { approve, clearPlan, MD5, planItem, testEnv, World } from "./world";

const NOW = new Date("2026-10-20T03:00:00Z");
const OLD = "2026-10-20T02:00:00Z",
  JUST = "2026-10-20T02:58:00Z";
const drafts = async () =>
  (
    await env.DB.prepare(
      "SELECT kind, account, payload, source, workspace_id FROM drafts ORDER BY json_extract(payload, '$.title')",
    ).all<{ kind: string; account: string; payload: string; source: string; workspace_id: string }>()
  ).results.map((d) => ({ ...d, payload: JSON.parse(d.payload) }));

let w: World;
beforeEach(async () => {
  await env.DB.batch(
    [
      "DELETE FROM drafts",
      "DELETE FROM inbox_seen",
      "DELETE FROM audit",
      "DELETE FROM settings WHERE key LIKE 'inbox_folder%'",
    ].map((s) => env.DB.prepare(s)),
  );
  await clearPlan();
  w = new World();
});

describe("the Drive inbox", () => {
  it("makes a draft per Reel, photo and carousel, with their texts, once each", async () => {
    await planItem({ folder: "demo_running/CONTENT/20260201_RUN", name: "short1_x", account: "demo_running" });
    const P = "UPLOADS/inbox/20260201_RUN";
    w.drivePut(`${P}/short9_new.mp4`, { md5: MD5, mimeType: "video/mp4", modified: OLD });
    w.drivePut(`${P}/short9_new.txt`, {
      md5: "t",
      mimeType: "text/plain",
      bytes: "Morning run #running",
      modified: OLD,
    });
    w.drivePut(`${P}/short9_new.comment.txt`, {
      md5: "c",
      mimeType: "text/plain",
      bytes: "Where do you run?",
      modified: OLD,
    });
    w.drivePut(`${P}/3_gear/1.jpg`, { md5: "a", mimeType: "image/jpeg", modified: OLD });
    w.drivePut(`${P}/3_gear/2.jpg`, { md5: "b", mimeType: "image/jpeg", modified: OLD });
    w.drivePut(`${P}/3_gear/caption.txt`, { md5: "t2", mimeType: "text/plain", bytes: "Gear check", modified: OLD });
    w.drivePut(`${P}/still_uploading.mp4`, { md5: MD5, mimeType: "video/mp4", modified: JUST }); // changed 2 min ago: waits
    w.drivePut(`${P}/processing.mp4`, { md5: "", mimeType: "video/mp4", modified: OLD }); // no md5 yet: waits
    w.drivePut("UPLOADS/inbox/_posted/old.mp4", { md5: MD5, mimeType: "video/mp4", modified: OLD });
    w.drivePut("UPLOADS/inbox/20990101_NEW/pic.jpg", { md5: "p", mimeType: "image/jpeg", modified: OLD });

    const e = await testEnv(env);
    // a project no plan has yet goes to the workspace the store's inbox feeds
    await env.DB.prepare("UPDATE media_store SET inbox_workspace = 'default' WHERE kind = 'drive'").run();
    const r = await scanInbox(e, { fetch: w.fetch, now: NOW });
    expect(r.drafted.sort()).toEqual(["20260201_RUN/3_gear", "20260201_RUN/short9_new", "20990101_NEW/pic"]);
    expect(r.waiting).toBe(2);
    const d = await drafts();
    expect(d.map((x) => [x.payload.title, x.kind, x.account, x.source])).toEqual([
      ["20260201_RUN/3_gear", "carousel", "demo_running", "drive"],
      ["20260201_RUN/short9_new", "reel", "demo_running", "drive"],
      ["20990101_NEW/pic", "photo", "demo_travel", "drive"],
    ]);
    expect(d[1].payload).toMatchObject({
      caption: "Morning run #running",
      comment: "Where do you run?",
      name: "short9_new",
      folder: "20260201_RUN",
    });
    expect(d[0].payload.files.map((f: { name: string }) => f.name)).toEqual(["1.jpg", "2.jpg"]);
    expect(d[2].payload.note).toMatch(/pick the account/);
    expect(w.notifications.at(-1)).toMatchObject({ title: "3 new drafts from the inbox" });

    // Next run: nothing new; the two that were waiting go once they're ready.
    expect((await scanInbox(await testEnv(env), { fetch: w.fetch, now: NOW })).drafted).toEqual([]);
    await env.DB.prepare("UPDATE drafts SET status = 'refused'").run(); // refused stays refused
    const later = new Date(NOW.getTime() + 15 * 60_000);
    expect((await scanInbox(await testEnv(env), { fetch: w.fetch, now: later })).drafted).toEqual([
      "20260201_RUN/still_uploading",
    ]);
  });

  it("drafts a known project into its plan's workspace, an unknown one into the store's inbox workspace, and waits without one", async () => {
    const e = await testEnv(env);
    await env.DB.prepare(
      "INSERT INTO workspaces (id, name, created_at) VALUES ('b', 'Workspace B', 0) ON CONFLICT (id) DO NOTHING",
    ).run();
    await upsertConnection(
      env.DB,
      { id: "c_b", workspaceId: "b", provider: "composio", kind: "composio", externalRef: "instagram_conn-b2" },
      0,
    );
    await upsertAccount(
      env.DB,
      { id: "b_shop", workspaceId: "b", platform: "instagram", handle: "b_shop", connectionId: "c_b" },
      0,
    );
    await planItem({ folder: "b_shop/CONTENT/20261101_SHOP", name: "short1_x", account: "b_shop", workspaceId: "b" });
    w.drivePut("UPLOADS/inbox/20261101_SHOP/new.mp4", { md5: MD5, mimeType: "video/mp4", modified: OLD });
    w.drivePut("UPLOADS/inbox/20990101_NEW/pic.jpg", { md5: "p", mimeType: "image/jpeg", modified: OLD });

    // the known project goes to its plan's workspace; the unknown one waits: the store feeds no workspace
    const r = await scanInbox(e, { fetch: w.fetch, now: NOW });
    expect(r).toEqual({ drafted: ["20261101_SHOP/new"], waiting: 1 });
    expect((await drafts()).map((d) => [d.payload.title, d.workspace_id, d.account])).toEqual([
      ["20261101_SHOP/new", "b", "b_shop"],
    ]);
    // b's notice is b's: nothing reaches the default workspace's topic
    expect(w.notifications).toEqual([]);
    const notes = await env.DB.prepare("SELECT workspace_id FROM audit WHERE action = 'notify'").all<{
      workspace_id: string;
    }>();
    expect(notes.results.map((n) => n.workspace_id)).toEqual(["b"]);

    // the store's inbox feeds b from now on: the waiting draft goes there, on b's first Instagram account
    await env.DB.prepare("UPDATE media_store SET inbox_workspace = 'b' WHERE kind = 'drive'").run();
    expect((await scanInbox(e, { fetch: w.fetch, now: NOW })).drafted).toEqual(["20990101_NEW/pic"]);
    expect((await drafts()).map((d) => [d.payload.title, d.workspace_id, d.account])).toEqual([
      ["20261101_SHOP/new", "b", "b_shop"],
      ["20990101_NEW/pic", "b", "b_shop"],
    ]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM drafts WHERE workspace_id = 'default'").first("n")).toBe(0);
  });

  it("does nothing without an inbox folder", async () => {
    expect(await scanInbox(await testEnv(env), { fetch: w.fetch, now: NOW })).toMatchObject({
      drafted: [],
      note: "no UPLOADS/inbox folder in any media store",
    });
  });
});

describe("moving posted media aside", () => {
  const posted = (key: string, at: string) =>
    env.DB.prepare(
      "INSERT INTO posted (item_key, account, source, published_at) VALUES (?1, 'demo_travel', 'scheduler', unixepoch(?2))",
    )
      .bind(key, at)
      .run();

  it("moves a Reel's file and a post's folder to UPLOADS/_posted/ a day after posting, once", async () => {
    await env.DB.batch(["DELETE FROM media_cleanup", "DELETE FROM posted"].map((s) => env.DB.prepare(s)));
    const reel = w.drivePut("UPLOADS/vlogs/CONTENT/20260823_LISBON/exports/shorts/instagram/short1_a.mp4", {
      md5: MD5,
      mimeType: "video/mp4",
    });
    const k1 = await planItem({ folder: "vlogs/CONTENT/20260823_LISBON", name: "short1_a" });
    const img = w.drivePut("UPLOADS/vlogs/CONTENT/20260823_LISBON/posts/1_rocks/1.jpg", {
      md5: "a",
      mimeType: "image/jpeg",
    });
    const postDir = w.drive.get(img)!.parent!;
    const k2 = await planItem({ kind: "post", folder: "vlogs/CONTENT/20260823_LISBON", name: "posts/1_rocks" });
    await approve(k2, { due: "2026-10-19 19:00", caption: "c", comment: null, media: [{ driveId: img, md5: "a" }] });
    const k3 = await planItem({ folder: "vlogs/CONTENT/20260823_LISBON", name: "short2_recent" });
    await posted(k1, "2026-10-19T00:00:00Z");
    await posted(k2, "2026-10-19T01:00:00Z");
    await posted(k3, "2026-10-20T02:00:00Z"); // posted an hour ago: stays for now
    const r = await cleanMedia(await testEnv(env), { fetch: w.fetch, now: NOW });
    expect(r).toEqual({ moved: 2, refused: [] });
    const target = w.drive.get(reel)!.parent!;
    expect(w.drive.get(target)!.name).toBe("_posted");
    expect(w.drive.get(postDir)!.parent).toBe(target); // the folder moved, with its files
    expect(w.drive.get(img)!.parent).toBe(postDir);
    expect(w.calls.length).toBe(0);
    expect((await cleanMedia(await testEnv(env), { fetch: w.fetch, now: NOW })).moved).toBe(0);
  });

  it("records a refused move once and notifies", async () => {
    await env.DB.batch(["DELETE FROM media_cleanup", "DELETE FROM posted"].map((s) => env.DB.prepare(s)));
    w.drivePut("UPLOADS/_posted/keep.txt", { md5: "k", mimeType: "text/plain" });
    w.drivePut("UPLOADS/vlogs/CONTENT/20260823_LISBON/exports/shorts/instagram/short1_a.mp4", {
      md5: MD5,
      mimeType: "video/mp4",
    });
    const k = await planItem({ folder: "vlogs/CONTENT/20260823_LISBON", name: "short1_a" });
    await posted(k, "2026-10-18T00:00:00Z");
    w.driveRefuses = true;
    expect((await cleanMedia(await testEnv(env), { fetch: w.fetch, now: NOW })).refused).toEqual([
      `${k}: move refused (403)`,
    ]);
    expect(w.notifications.at(-1)?.title).toBe("Media cleanup: the store refused");
    expect((await cleanMedia(await testEnv(env), { fetch: w.fetch, now: NOW })).refused).toEqual([]);
  });
});
