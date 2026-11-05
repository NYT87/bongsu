import { env } from "cloudflare:workers";
import { upsertAccount, upsertConnection } from "@bongsu/core/accounts";
import { cleanMedia } from "@bongsu/core/cleanup";
import { scanInbox } from "@bongsu/core/inbox";
import { saveStore } from "@bongsu/core/media/manage";
import { createWorkspace } from "@bongsu/core/people";
import { workspaceSettings } from "@bongsu/core/workspaces";
import { beforeEach, describe, expect, it } from "vitest";
import {
  approve,
  clearPlan,
  MD5,
  planItem,
  seedS3Store,
  TEST_S3_KEYS,
  TEST_S3_SETTINGS,
  testEnv,
  World,
} from "./world";

const NOW = new Date("2026-10-20T03:00:00Z");
const OLD = "2026-10-20T02:00:00Z",
  JUST = "2026-10-20T02:58:00Z";
const drafts = async () =>
  (
    await env.DB.prepare(
      "SELECT kind, account, payload, source, workspace_id FROM drafts ORDER BY json_extract(payload, '$.title')",
    ).all<{ kind: string; account: string; payload: string; source: string; workspace_id: string }>()
  ).results.map((d) => ({ ...d, payload: JSON.parse(d.payload) }));

/** A live workspace without settings: its folder is its id. */
const workspace = (id: string) =>
  env.DB.prepare(
    "INSERT INTO workspaces (id, name, created_at) VALUES (?1, ?1, 0) ON CONFLICT (id) DO UPDATE SET archived_at = NULL",
  )
    .bind(id)
    .run();

let w: World;
beforeEach(async () => {
  await env.DB.batch(
    [
      "DELETE FROM drafts",
      "DELETE FROM inbox_seen",
      "DELETE FROM audit",
      "DELETE FROM settings WHERE key LIKE 'inbox_folder%' OR key IN ('inbox_cursor', 'inbox_last')",
      // the workspaces other tests made: only the ones this test makes are scanned
      "UPDATE workspaces SET archived_at = 1 WHERE id <> 'default'",
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

  it("drafts into the workspace whose folder it is in, whatever other workspaces plan", async () => {
    const e = await testEnv(env);
    await workspace("b");
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
    w.drivePut("b/inbox/20261101_SHOP/new.mp4", { md5: MD5, mimeType: "video/mp4", modified: OLD });
    // the same project name in the default workspace's folder is the default workspace's, not b's
    w.drivePut("UPLOADS/inbox/20261101_SHOP/other.mp4", { md5: MD5, mimeType: "video/mp4", modified: OLD });
    w.drivePut("UPLOADS/inbox/20990101_NEW/pic.jpg", { md5: "p", mimeType: "image/jpeg", modified: OLD });

    const r = await scanInbox(e, { fetch: w.fetch, now: NOW });
    expect(r.drafted.sort()).toEqual(["20261101_SHOP/new", "20261101_SHOP/other", "20990101_NEW/pic"]);
    expect((await drafts()).map((d) => [d.payload.title, d.workspace_id, d.account])).toEqual([
      ["20261101_SHOP/new", "b", "b_shop"],
      ["20261101_SHOP/other", "default", "demo_travel"],
      ["20990101_NEW/pic", "default", "demo_travel"],
    ]);
    // each workspace hears of its own drafts only
    const notes = await env.DB.prepare(
      "SELECT workspace_id FROM audit WHERE action = 'notify' ORDER BY workspace_id",
    ).all<{
      workspace_id: string;
    }>();
    expect(notes.results.map((n) => n.workspace_id)).toEqual(["b", "default"]);
  });

  it("drafts nothing into an archived workspace, and keeps scanning the others", async () => {
    const e = await testEnv(env);
    await workspace("old");
    w.drivePut("old/inbox/20261101_OLD/new.mp4", { md5: MD5, mimeType: "video/mp4", modified: OLD });
    w.drivePut("UPLOADS/inbox/20990101_NEW/pic.jpg", { md5: "p", mimeType: "image/jpeg", modified: OLD });
    await env.DB.prepare("UPDATE workspaces SET archived_at = 1 WHERE id = 'old'").run();
    const r = await scanInbox(e, { fetch: w.fetch, now: NOW });
    expect(r.drafted).toEqual(["20990101_NEW/pic"]);
    expect(r.reached).not.toContain("old");
    expect((await drafts()).map((d) => d.workspace_id)).toEqual(["default"]);
    // once it's live again its folder is scanned
    await env.DB.prepare("UPDATE workspaces SET archived_at = NULL WHERE id = 'old'").run();
    expect((await scanInbox(e, { fetch: w.fetch, now: NOW })).drafted).toEqual(["20261101_OLD/new"]);
  });

  it("keeps two workspaces' same-named files apart on the same store", async () => {
    const e = await testEnv(env);
    await workspace("a1");
    await workspace("b1");
    for (const f of ["a1", "b1"])
      w.drivePut(`${f}/inbox/trip/a.mp4`, { md5: f === "a1" ? "aa" : "bb", mimeType: "video/mp4", modified: OLD });
    await scanInbox(e, { fetch: w.fetch, now: NOW });
    const d = (await drafts()).sort((x, y) => x.workspace_id.localeCompare(y.workspace_id));
    expect(d.map((x) => [x.workspace_id, x.payload.title])).toEqual([
      ["a1", "trip/a"],
      ["b1", "trip/a"],
    ]);
    expect(d[0].payload.files[0].checksum).toBe("aa");
    expect(d[1].payload.files[0].checksum).toBe("bb");
  });

  it("scans a workspace's own store as well as the instance's", async () => {
    const e = await testEnv(env);
    await seedS3Store();
    const id = await createWorkspace(env.DB, { name: "Inbox Own", timezone: "UTC", createdBy: "owner" }, 0);
    await saveStore(e, w.fetch, { workspaceId: id }, "s3", TEST_S3_SETTINGS, JSON.stringify(TEST_S3_KEYS), "owner", 0);
    const folder = (await workspaceSettings(env.DB, id)).mediaFolder;
    await w.s3.put(`${folder}/inbox/trip/own.mp4`, "video", "video/mp4");
    w.drivePut(`${folder}/inbox/trip/ondrive.mp4`, { md5: "d", mimeType: "video/mp4", modified: OLD });
    const r = await scanInbox(e, { fetch: w.fetch, now: new Date(Date.now() + 3600_000) }); // the bucket stamps real time
    // the fake bucket is shared by the instance's store and the workspace's own, so it shows through both
    expect(r.drafted.sort()).toEqual(["trip/ondrive", "trip/own", "trip/own"]);
    expect((await drafts()).map((d) => [d.workspace_id, d.payload.media[0].store]).sort()).toEqual([
      [id, "drive"],
      [id, "s3"],
      [id, `s3-${id}`],
    ]);
  });

  describe("the budget", () => {
    const IDS = ["default", "r1", "r2", "r3", "r4"];
    const last = async () =>
      JSON.parse(
        (await env.DB.prepare("SELECT value FROM settings WHERE key = 'inbox_last'").first("value")) as string,
      );
    async function five() {
      for (const id of IDS.slice(1)) await workspace(id);
      for (const id of IDS)
        w.drivePut(`${id === "default" ? "UPLOADS" : id}/inbox/trip/${id}.mp4`, {
          md5: MD5,
          mimeType: "video/mp4",
          modified: OLD,
        });
      return testEnv(env, { INBOX_WORKSPACES_PER_RUN: "2" });
    }

    it("reaches every workspace over a few runs, at most the limit each", async () => {
      const e = await five();
      const reached: string[][] = [];
      for (let n = 0; n < 3; n++) reached.push((await scanInbox(e, { fetch: w.fetch, now: NOW })).reached);
      expect(reached.map((r) => r.length)).toEqual([2, 2, 2]);
      expect(new Set(reached.flat())).toEqual(new Set(IDS));
      expect(reached[0]).toEqual(["default", "r1"]);
      expect((await drafts()).map((d) => d.workspace_id).sort()).toEqual([...IDS].sort());
    });

    it("records the run: reached, total and limit", async () => {
      const e = await five();
      const r = await scanInbox(e, { fetch: w.fetch, now: NOW });
      expect(r).toMatchObject({ waitingWorkspaces: 3 });
      expect(await last()).toEqual({ at: Math.floor(NOW.getTime() / 1000), reached: 2, total: 5, limit: 2 });
    });

    it("skips no workspace when the one the cursor points at is archived", async () => {
      const e = await five();
      expect((await scanInbox(e, { fetch: w.fetch, now: NOW })).reached).toEqual(["default", "r1"]);
      await env.DB.prepare("UPDATE workspaces SET archived_at = 1 WHERE id = 'r1'").run(); // the cursor's
      const second = (await scanInbox(e, { fetch: w.fetch, now: NOW })).reached;
      const third = (await scanInbox(e, { fetch: w.fetch, now: NOW })).reached;
      const fourth = (await scanInbox(e, { fetch: w.fetch, now: NOW })).reached;
      expect(second).toEqual(["r2", "r3"]);
      expect(third).toEqual(["r4", "default"]);
      expect(fourth).toEqual(["r2", "r3"]);
      expect(await last()).toMatchObject({ reached: 2, total: 4, limit: 2 });
    });
  });

  it("does nothing without an inbox folder", async () => {
    expect(await scanInbox(await testEnv(env), { fetch: w.fetch, now: NOW })).toMatchObject({
      drafted: [],
      note: "no inbox folder in any workspace's media folder",
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
