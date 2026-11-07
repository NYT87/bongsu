import { env } from "cloudflare:workers";
import { upsertAccount, upsertConnection } from "@bongsu/core/accounts";
import { cleanMedia } from "@bongsu/core/cleanup";
import { inboxTexts, nextWorkspaces, scanInbox } from "@bongsu/core/inbox";
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

  const yt = async () => {
    const r = await scanInbox(await testEnv(env), { fetch: w.fetch, now: NOW });
    return {
      r,
      d: await env.DB.prepare("SELECT kind, payload, texts FROM drafts").all<{
        kind: string;
        payload: string;
        texts: string | null;
      }>(),
    };
  };
  const txt = (path: string, bytes: string) =>
    w.drivePut(path, { md5: "x" + path, mimeType: "text/plain", bytes, modified: OLD });

  it("a YouTube folder becomes a draft with its title, translations, subtitles and thumbnail", async () => {
    const P = "UPLOADS/inbox/demo/clip1";
    w.drivePut(`${P}/clip.mp4`, { md5: MD5, mimeType: "video/mp4", modified: OLD });
    txt(`${P}/caption.txt`, "About the clip");
    txt(`${P}/title.txt`, "The clip");
    txt(`${P}/caption.es.txt`, "Sobre el clip");
    txt(`${P}/title.es.txt`, "El clip");
    w.drivePut(`${P}/es.srt`, { md5: "s", mimeType: "application/x-subrip", modified: OLD });
    w.drivePut(`${P}/thumbnail.jpg`, { md5: "j", mimeType: "image/jpeg", modified: OLD });
    const { d } = await yt();
    expect(d.results).toHaveLength(1);
    expect(d.results[0].kind).toBe("reel");
    expect(JSON.parse(d.results[0].texts as string)).toEqual({
      title: "The clip",
      translations: { es: { title: "El clip", description: "Sobre el clip" } },
    });
    const p = JSON.parse(d.results[0].payload);
    expect(p.media).toHaveLength(3);
    expect(p.caption).toBe("About the clip");
    // the inbox can't tell the video's language: the draft keeps the translations and says what's missing
    expect(p.note).toMatch(/language: YouTube needs the video's own language with translations/);
  });

  it("a subtitle file over 5 MB is left out of the draft, which says so", async () => {
    const P = "UPLOADS/inbox/demo/clip9";
    w.drivePut(`${P}/clip.mp4`, { md5: MD5, mimeType: "video/mp4", modified: OLD });
    w.drivePut(`${P}/es.srt`, { md5: "s", mimeType: "application/x-subrip", modified: OLD });
    w.drivePut(`${P}/de.srt`, { md5: "g", mimeType: "application/x-subrip", size: 5242881, modified: OLD });
    const { d } = await yt();
    const p = JSON.parse(d.results[0].payload);
    expect(p.files.map((f: { name: string }) => f.name)).toEqual(["clip.mp4", "es.srt"]);
    expect(p.note).toContain("de.srt is over 5 MB: a subtitle file can't be that large, so it was left out");
  });

  it("a translation needs both files", async () => {
    const P = "UPLOADS/inbox/demo/clip2";
    w.drivePut(`${P}/clip.mp4`, { md5: MD5, mimeType: "video/mp4", modified: OLD });
    txt(`${P}/title.es.txt`, "El clip");
    const { d } = await yt();
    expect(d.results[0].texts).toBeNull();
    expect(JSON.parse(d.results[0].payload).note).toMatch(/es: needs both caption\.es\.txt and title\.es\.txt/);
  });

  it("a single video takes its title file", async () => {
    const P = "UPLOADS/inbox/demo";
    w.drivePut(`${P}/clip.mp4`, { md5: MD5, mimeType: "video/mp4", modified: OLD });
    txt(`${P}/clip.title.txt`, "Just the title");
    txt(`${P}/other.title.txt`, "Not mine");
    const { d } = await yt();
    expect(JSON.parse(d.results[0].texts as string)).toEqual({ title: "Just the title" });
  });

  it("an Instagram project is unchanged", async () => {
    w.drivePut("UPLOADS/inbox/demo/reel.mp4", { md5: MD5, mimeType: "video/mp4", modified: OLD });
    txt("UPLOADS/inbox/demo/reel.txt", "Hi");
    const { d } = await yt();
    expect(d.results[0].texts).toBeNull();
    expect(d.results[0].kind).toBe("reel");
  });

  /** A folder of a video with a caption, a title and `langs` complete translations: 1 + 1 + 2 * langs reads. */
  const heavy = (project: string, name: string, langs: string[]) => {
    const P = `UPLOADS/inbox/${project}/${name}`;
    w.drivePut(`${P}/clip.mp4`, { md5: MD5, mimeType: "video/mp4", modified: OLD });
    txt(`${P}/caption.txt`, "About");
    txt(`${P}/title.txt`, "Title");
    for (const l of langs) {
      txt(`${P}/caption.${l}.txt`, `About ${l}`);
      txt(`${P}/title.${l}.txt`, `Title ${l}`);
    }
  };
  const FIVE = ["de", "es", "fr", "it", "pt"];

  it("keeps its store reads inside the run's budget, leaving the rest for the next run", async () => {
    for (const n of ["a1", "a2", "a3", "a4"]) heavy("demo", n, FIVE);
    const first = await scanInbox(await testEnv(env), { fetch: w.fetch, now: NOW });
    expect(first.drafted).toEqual(["demo/a1", "demo/a2"]);
    expect(first.waiting).toBe(2);
    const second = await scanInbox(await testEnv(env), { fetch: w.fetch, now: NOW });
    expect(second.drafted).toEqual(["demo/a3", "demo/a4"]);
  });

  it("always drafts the run's first item, however heavy", async () => {
    heavy("demo", "b1", [...FIVE, "ja", "ko", "nl"]);
    const r = await scanInbox(await testEnv(env), { fetch: w.fetch, now: NOW });
    expect(r.drafted).toEqual(["demo/b1"]);
  });

  it("notifies of the drafts made so far when a later item fails", async () => {
    heavy("demo", "c1", ["es"]);
    heavy("demo", "c2", ["es"]);
    const bad = w.drivePut("UPLOADS/inbox/demo/c2/title.txt", { md5: "q", mimeType: "text/plain", modified: OLD });
    const broken: typeof fetch = (input, init) => {
      const url = new Request(input, init).url;
      return url.includes(bad) && url.includes("alt=media")
        ? Promise.resolve(new Response("boom", { status: 500 }))
        : w.fetch(input, init);
    };
    await expect(scanInbox(await testEnv(env), { fetch: broken, now: NOW })).rejects.toThrow();
    expect((await drafts()).map((d) => d.payload.title)).toEqual(["demo/c1"]);
    expect(w.notifications.at(-1)).toMatchObject({ title: expect.stringMatching(/new draft/) });
  });

  it("says when it read only the first five translations", async () => {
    heavy("demo", "d1", [...FIVE, "ja"]);
    const { d } = await yt();
    expect(Object.keys(JSON.parse(d.results[0].texts as string).translations)).toEqual(["de", "es", "fr", "it", "ja"]);
    expect(JSON.parse(d.results[0].payload).note).toMatch(/only the first 5 translations were read/);
  });

  it("skips texts YouTube would refuse and says why", async () => {
    const P = "UPLOADS/inbox/demo/e1";
    w.drivePut(`${P}/clip.mp4`, { md5: MD5, mimeType: "video/mp4", modified: OLD });
    txt(`${P}/title.txt`, "x".repeat(101));
    const { d } = await yt();
    expect(d.results[0].texts).toBeNull();
    expect(JSON.parse(d.results[0].payload).note).toMatch(/YouTube texts skipped/);
  });

  it("leaves a carousel's media as before: subtitles and a thumbnail don't change it", async () => {
    const P = "UPLOADS/inbox/demo/f1";
    w.drivePut(`${P}/1.jpg`, { md5: "a", mimeType: "image/jpeg", modified: OLD });
    w.drivePut(`${P}/2.jpg`, { md5: "b", mimeType: "image/jpeg", modified: OLD });
    w.drivePut(`${P}/thumbnail.jpg`, { md5: "c", mimeType: "image/jpeg", modified: OLD });
    w.drivePut(`${P}/en.vtt`, { md5: "d", mimeType: "text/vtt", modified: OLD });
    const { d } = await yt();
    expect(d.results[0].kind).toBe("carousel");
    expect(JSON.parse(d.results[0].payload).files.map((f: { name: string }) => f.name)).toEqual([
      "1.jpg",
      "2.jpg",
      "thumbnail.jpg",
    ]);
  });

  it("inboxTexts maps title and translation files", () => {
    const f = (name: string, text: string) => ({ name, text });
    expect(inboxTexts([f("caption.txt", "c")], null)).toBeNull();
    expect(inboxTexts([f("title.txt", " T ")], null)).toEqual({ title: "T" });
    expect(inboxTexts([f("title.es.txt", "t"), f("caption.es.txt", "c")], null)).toEqual({
      title: "",
      translations: { es: { title: "t", description: "c" } },
    });
    expect(inboxTexts([f("title.es.txt", "t")], null)).toBeNull();
    expect(inboxTexts([f("clip.title.txt", "T"), f("title.txt", "no")], "clip")).toEqual({ title: "T" });
    expect(inboxTexts([f("title.txt", "T"), f("title.es.txt", "t"), f("caption.es.txt", "c")], "clip")).toBeNull();
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

  // the workspace's own bucket is the fake one under a prefix, so it doesn't show the instance's objects
  const OWN = { ...TEST_S3_SETTINGS, prefix: "own/" };
  const ownWorkspace = async (e: Awaited<ReturnType<typeof testEnv>>, name: string) => {
    const id = await createWorkspace(env.DB, { name, timezone: "UTC", createdBy: "owner" }, 0);
    await saveStore(e, w.fetch, { workspaceId: id }, "s3", OWN, JSON.stringify(TEST_S3_KEYS), "owner", 0);
    return { id, folder: (await workspaceSettings(env.DB, id)).mediaFolder };
  };
  const later = () => new Date(Date.now() + 3600_000); // the bucket stamps real time

  it("scans a workspace's own store as well as the instance's", async () => {
    const e = await testEnv(env);
    await seedS3Store();
    const { id, folder } = await ownWorkspace(e, "Inbox Own");
    await w.s3.put(`own/${folder}/inbox/trip/own.mp4`, "video", "video/mp4");
    w.drivePut(`${folder}/inbox/trip/ondrive.mp4`, { md5: "d", mimeType: "video/mp4", modified: OLD });
    const r = await scanInbox(e, { fetch: w.fetch, now: later() });
    expect(r.drafted.sort()).toEqual(["trip/ondrive", "trip/own"]);
    expect((await drafts()).map((d) => [d.workspace_id, d.payload.media[0].store]).sort()).toEqual([
      [id, "drive"],
      [id, `s3-${id}`],
    ]);
  });

  it("keeps a workspace on the instance's store apart from one with its own store", async () => {
    const e = await testEnv(env);
    await seedS3Store();
    await workspace("a1"); // on the instance's store, in its folder a1
    const b = await ownWorkspace(e, "Inbox B");
    await w.s3.put("a1/inbox/trip/a.mp4", "A's video", "video/mp4");
    await w.s3.put(`own/${b.folder}/inbox/trip/a.mp4`, "B's longer video", "video/mp4");
    await scanInbox(e, { fetch: w.fetch, now: later() });
    const d = await drafts();
    expect(
      d.map((x) => [x.workspace_id, x.payload.title, x.payload.media.map((m: { store: string }) => m.store)]),
    ).toEqual(
      expect.arrayContaining([
        ["a1", "trip/a", ["s3"]],
        [b.id, "trip/a", [`s3-${b.id}`]],
      ]),
    );
    expect(d).toHaveLength(2); // neither drafts into the other, nor twice
    const of = (ws: string) => d.find((x) => x.workspace_id === ws)!.payload.files[0];
    expect(of("a1").checksum).toBeTruthy();
    expect(of("a1").checksum).not.toBe(of(b.id).checksum);
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

    it("gives each workspace reached its share of the run's drafts, what one leaves going to the next", async () => {
      for (const id of ["r1", "r2"]) await workspace(id);
      const put = (folder: string, n: number) => {
        for (let i = 1; i <= n; i++)
          w.drivePut(`${folder}/inbox/trip/${folder}_${i}.mp4`, { md5: MD5, mimeType: "video/mp4", modified: OLD });
      };
      put("UPLOADS", 1);
      put("r1", 10);
      put("r2", 10);
      const e = await testEnv(env, { INBOX_WORKSPACES_PER_RUN: "3" });
      const r = await scanInbox(e, { fetch: w.fetch, now: NOW });
      expect(r.reached).toEqual(["default", "r1", "r2"]);
      // six a run: two each, the one default doesn't use going to the last
      const by = (await drafts()).reduce<Record<string, number>>(
        (m, d) => ({ ...m, [d.workspace_id]: (m[d.workspace_id] ?? 0) + 1 }),
        {},
      );
      expect(by).toEqual({ default: 1, r1: 2, r2: 3 });
      expect(r.waiting).toBe(15);
    });

    it("orders the workspaces itself, whatever order the database gave them in", () => {
      expect(nextWorkspaces(["w_b", "default", "w_a"], "default", 2)).toEqual(["w_a", "w_b"]);
      expect(nextWorkspaces(["w_b", "default", "w_a"], null, 2)).toEqual(["default", "w_a"]);
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
