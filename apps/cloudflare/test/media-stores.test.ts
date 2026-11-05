// The media stores (Phase 12): set up in the dashboard (an S3 bucket from a form, Google Drive with its button), several
// side by side with one default, each file read from the store its reference names; the inbox in every store, uploads
// to the store the owner picks, the weekly check, and /health.
import { env } from "cloudflare:workers";
import { createApp } from "@bongsu/api/app";
import { adminRoutes } from "@bongsu/api/dashboard/routes";
import type { Verifiers } from "@bongsu/api/pwa/webauthn";
import { clearTokenCache } from "@bongsu/core/clients/google";
import { removeWorkspaceOAuthApp, saveWorkspaceOAuthApp } from "@bongsu/core/connections";
import { encryptSecret } from "@bongsu/core/crypto";
import { addApproval } from "@bongsu/core/data";
import type { Env } from "@bongsu/core/env";
import { sha256Hex } from "@bongsu/core/formats/approved";
import { scanInbox } from "@bongsu/core/inbox";
import { type Mail, registerMailer } from "@bongsu/core/mail";
import { DriveStore } from "@bongsu/core/media/drive";
import { mediaStores, storeRows } from "@bongsu/core/media/index";
import {
  CHECK_EVERY_S,
  checkStores,
  removeStore,
  StoreError,
  saveStore,
  setDefaultStore,
  startDriveConnect,
  waitingApprovalsIn,
} from "@bongsu/core/media/manage";
import { setWorkspaceNtfy } from "@bongsu/core/ntfy";
import { createWorkspace } from "@bongsu/core/people";
import { workspaceSettings } from "@bongsu/core/workspaces";
import { beforeEach, describe, expect, it } from "vitest";
import {
  joinDefault,
  seedS3Store,
  TEST_DRIVE_GRANT,
  TEST_ENCRYPTION_KEY,
  TEST_S3_KEYS,
  TEST_S3_SETTINGS,
  testEnv,
  UNBOOTSTRAP,
  World,
} from "./world";

const fake: Verifiers = {
  registration: (async (o: { response: { id: string } }) => ({
    verified: true,
    registrationInfo: {
      credential: { id: o.response.id, publicKey: new Uint8Array([1, 2, 3]), counter: 0, transports: ["internal"] },
    },
  })) as unknown as Verifiers["registration"],
  authentication: (async () => ({
    verified: true,
    authenticationInfo: { newCounter: 1 },
  })) as unknown as Verifiers["authentication"],
};

let e: Env;
let w: World;
let cookie = "";
/** The Drive flow's cookie (bongsu_oauth) in this browser, as the start sets it and the callback clears it. */
let driveFlow = "";
async function call(path: string, body?: unknown, withCookie = true, flowCookie?: string) {
  const cookies = [cookie && withCookie ? cookie : "", flowCookie ?? ""].filter(Boolean).join("; ");
  const r = await adminRoutes(w.fetch, fake).request(
    `https://bongsu.test${path}`,
    {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json", ...(cookies ? { Cookie: cookies } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    e,
  );
  const setCookies = r.headers.getSetCookie();
  for (const set of setCookies) {
    if (set.startsWith("bongsu_oauth=")) driveFlow = set.includes("Max-Age=0") ? "" : set.split(";")[0];
    else if (!set.includes("Max-Age=0")) cookie = set.split(";")[0];
  }
  const text = await r.text();
  return {
    status: r.status,
    location: r.headers.get("Location"),
    setCookies,
    json: (text.startsWith("{") ? JSON.parse(text) : {}) as Record<string, unknown>,
  };
}
/** Google sending the browser back to Drive's callback: no dashboard cookie (SameSite=Strict), the flow's cookie
 *  (SameSite=Lax) unless `flowCookie` says which to send. */
const driveCallback = (q: string, flowCookie: string = driveFlow) =>
  call(`/admin-api/media-stores/drive/callback?${q}`, undefined, false, flowCookie);
const AT = new Date("2026-10-20T00:00:00Z");
const S3_FORM = { ...TEST_S3_SETTINGS, ...TEST_S3_KEYS };

beforeEach(async () => {
  cookie = "";
  driveFlow = "";
  w = new World();
  await env.DB.batch(
    [
      ...UNBOOTSTRAP,
      "DELETE FROM oauth_apps",
      "DELETE FROM workspace_oauth_apps",
      "DELETE FROM oauth_states",
      "DELETE FROM approvals",
      "DELETE FROM drafts",
      "DELETE FROM inbox_seen",
      "DELETE FROM settings",
    ].map((s) => env.DB.prepare(s)),
  );
  e = await testEnv(env, {
    SETUP_TOKEN: "setup-token-123",
    PUBLIC_URL: "https://bongsu.test",
    RP_ID: "bongsu.test",
  } as Partial<Env>);
  const o = await call("/admin-api/bootstrap/options", { token: "setup-token-123", email: "owner@example.com" });
  await call("/admin-api/bootstrap/verify", { challengeId: o.json.challengeId, response: { id: "laptop-key" } });
  await joinDefault(); // the bootstrap makes an instance admin in no workspace
});

describe("the dashboard's Media page", () => {
  it("lists the stores without their secrets, and offers what this runtime runs", async () => {
    await seedS3Store();
    const r = await call("/admin-api/media-stores");
    expect(r.status).toBe(200);
    expect(r.json.offered).toEqual(["drive", "s3"]); // no "local" on Workers
    const stores = r.json.stores as Record<string, unknown>[];
    expect(stores.map((s) => [s.kind, s.default, s.hasCredentials])).toEqual([
      ["drive", true, true],
      ["s3", false, true],
    ]);
    expect(JSON.stringify(r.json)).not.toContain(TEST_S3_KEYS.secretAccessKey);
    expect(JSON.stringify(r.json)).not.toContain("r-drive");
  });

  it("lists the instance's stores only, and has no inbox workspace to choose any more", async () => {
    await seedS3Store();
    await env.DB.prepare(
      "INSERT INTO media_store (id, kind, workspace_id, is_default, settings, status, updated_at) VALUES ('s3-w_other', 's3', 'w_other', 0, '{}', 'ok', 0)",
    ).run();
    const r = await call("/admin-api/media-stores");
    expect((r.json.stores as { kind: string }[]).map((s) => s.kind)).toEqual(["drive", "s3"]); // not a workspace's own
    expect(r.json).not.toHaveProperty("workspaces");
    expect(JSON.stringify(r.json)).not.toContain("inboxWorkspace");
    expect((await call("/admin-api/media-stores/drive/inbox", { workspace: "default" })).status).toBe(404);
  });

  it("tests a bucket before saving it, keeps the keys encrypted, and keeps them when the form leaves them empty", async () => {
    const bad = await call("/admin-api/media-stores/s3/test", { ...S3_FORM, accessKeyId: "WRONG" });
    expect(bad.json).toMatchObject({ ok: false });
    expect(await call("/admin-api/media-stores/s3", { ...S3_FORM, accessKeyId: "WRONG" })).toMatchObject({
      status: 400,
    });
    expect((await call("/admin-api/media-stores/s3/test", S3_FORM)).json).toEqual({ ok: true, error: null });
    expect((await call("/admin-api/media-stores/s3", S3_FORM)).status).toBe(200);
    expect(w.s3.objects.has("UPLOADS/inbox/")).toBe(true); // Test made the inbox: writing works
    const row = await env.DB.prepare("SELECT settings, credentials FROM media_store WHERE kind = 's3'").first<{
      settings: string;
      credentials: string;
    }>();
    expect(JSON.parse(row!.settings)).toMatchObject({ bucket: "media", endpoint: "https://s3.test" });
    expect(row!.credentials).not.toContain(TEST_S3_KEYS.secretAccessKey);
    // a new prefix, keys left empty: the saved ones are used
    const { accessKeyId: _, secretAccessKey: __, ...noKeys } = S3_FORM;
    expect((await call("/admin-api/media-stores/s3", { ...noKeys, prefix: "bongsu" })).status).toBe(200);
    expect(w.s3.objects.has("bongsu/UPLOADS/inbox/")).toBe(true);
    // one key without the other is refused; a bad endpoint too
    expect((await call("/admin-api/media-stores/s3", { ...noKeys, accessKeyId: "x" })).status).toBe(400);
    expect((await call("/admin-api/media-stores/s3", { ...S3_FORM, endpoint: "file:///etc" })).status).toBe(400);
    expect((await call("/admin-api/media-stores/local", {})).status).toBe(400); // not offered here
  });

  it("asks for a fresh passkey to save or remove a store", async () => {
    await env.DB.prepare("UPDATE sessions SET verified_at = 0").run();
    expect((await call("/admin-api/media-stores/s3", S3_FORM)).json).toMatchObject({ verify: true });
    expect((await call("/admin-api/media-stores/drive/remove", {})).json).toMatchObject({ verify: true });
  });

  it("removing a store says how many waiting approvals it voids, and the default moves to another store", async () => {
    await seedS3Store({ isDefault: true });
    await addApproval(env.DB, {
      key: "reel:trip/short1",
      account: "demo_travel",
      dueAt: 1_900_000_000,
      captionSha256: "c",
      commentSha256: null,
      altSha256: null,
      media: [{ store: "s3", id: "abc", checksum: "e1" }],
      approvedAt: "2026-10-01T00:00:00Z",
      approvedBy: "owner",
    });
    const listed = (await call("/admin-api/media-stores")).json.stores as { kind: string; waitingApprovals: number }[];
    expect(listed.find((s) => s.kind === "s3")?.waitingApprovals).toBe(1);
    expect(listed.find((s) => s.kind === "drive")?.waitingApprovals).toBe(0);
    expect((await call("/admin-api/media-stores/s3/remove", {})).json).toEqual({ removed: true, voidedApprovals: 1 });
    expect((await mediaStores(e, w.fetch)).default?.id).toBe("drive");
    expect((await call("/admin-api/media-stores/s3/remove", {})).status).toBe(400); // gone already
  });

  it("makes another store the default", async () => {
    await seedS3Store();
    expect((await call("/admin-api/media-stores/s3/default", {})).json).toEqual({ default: "s3" });
    expect((await mediaStores(e, w.fetch)).default?.id).toBe("s3");
    const rows = await env.DB.prepare("SELECT kind FROM media_store WHERE is_default = 1").all<{ kind: string }>();
    expect(rows.results.map((r) => r.kind)).toEqual(["s3"]);
  });
});

describe("stores scoped by workspace", () => {
  const SAVE = { settings: TEST_S3_SETTINGS, keys: JSON.stringify(TEST_S3_KEYS) };
  /** A workspace, and its own bucket store. */
  async function withStore(name: string) {
    const id = await createWorkspace(env.DB, { name, timezone: "UTC", createdBy: "owner" }, 0);
    await saveStore(e, w.fetch, { workspaceId: id }, "s3", SAVE.settings, SAVE.keys, "owner", 0);
    return id;
  }
  const ids = async (workspaceId?: string | null) => (await mediaStores(e, w.fetch, workspaceId)).all.map((s) => s.id);

  it("loads a workspace's own store beside the instance's of the same kind, each workspace seeing only its own", async () => {
    await seedS3Store();
    const a = await withStore("Demo Studio A");
    const b = await withStore("Demo Studio B");
    const all = await storeRows(env.DB);
    expect(all.map((r) => [r.id, r.kind, r.workspaceId])).toEqual(
      expect.arrayContaining([
        ["s3", "s3", null],
        [`s3-${a}`, "s3", a],
        [`s3-${b}`, "s3", b],
      ]),
    );
    expect(await ids(a)).toEqual(["drive", "s3", `s3-${a}`]);
    expect(await ids(b)).toEqual(["drive", "s3", `s3-${b}`]);
    expect(await ids()).toEqual(["drive", "s3"]);
    expect(await ids(null)).toEqual(["drive", "s3"]);
    expect((await storeRows(env.DB, { workspaceId: null })).map((r) => r.id)).toEqual(["drive", "s3"]);
    expect((await mediaStores(e, w.fetch, a)).get(`s3-${a}`)?.id).toBe(`s3-${a}`);
  });

  it("makes a workspace's first store its default, and changing it leaves the instance's default alone", async () => {
    await seedS3Store();
    const a = await withStore("Demo Studio A");
    expect((await mediaStores(e, w.fetch, a)).default?.id).toBe(`s3-${a}`);
    expect((await mediaStores(e, w.fetch)).default?.id).toBe("drive"); // the instance's
    expect((await mediaStores(e, w.fetch, "default")).default?.id).toBe("drive"); // a workspace with none of its own
    // a second own store, made the default: the first stops being one, the instance's rows are untouched
    w.drivePut(`${(await workspaceSettings(env.DB, a)).mediaFolder}/inbox/keep.txt`, {
      md5: "k",
      mimeType: "text/plain",
    });
    await saveStore(e, w.fetch, { workspaceId: a }, "drive", {}, TEST_DRIVE_GRANT, "owner", 0);
    await setDefaultStore(e, { workspaceId: a }, "drive", 1);
    const defaults = (await storeRows(env.DB)).filter((r) => r.isDefault).map((r) => r.id);
    expect(defaults).toEqual(["drive", `drive-${a}`]);
    expect((await mediaStores(e, w.fetch, a)).default?.id).toBe(`drive-${a}`);
    // a scope can't make another scope's store its default
    await expect(setDefaultStore(e, { workspaceId: "default" }, "s3", 2)).rejects.toThrow(/no s3 store/);
    await expect(setDefaultStore(e, { workspaceId: null }, "s3", 2)).resolves.toBeUndefined();
    expect((await storeRows(env.DB)).filter((r) => r.isDefault).map((r) => r.id)).toEqual([`drive-${a}`, "s3"]);
  });

  it("refuses a workspace the server's disk, and tests a workspace's store in its own folder", async () => {
    const a = await createWorkspace(env.DB, { name: "Demo Studio A", timezone: "UTC", createdBy: "owner" }, 0);
    await expect(saveStore(e, w.fetch, { workspaceId: a }, "local", {}, null, "owner", 0)).rejects.toThrow(StoreError);
    await saveStore(e, w.fetch, { workspaceId: a }, "s3", SAVE.settings, SAVE.keys, "owner", 0);
    expect(w.s3.objects.has(`${(await workspaceSettings(env.DB, a)).mediaFolder}/inbox/`)).toBe(true);
    expect(w.s3.objects.has("UPLOADS/inbox/")).toBe(false); // not the instance's folder
  });

  it("removes a workspace's store unless an approved, unpublished item uses it, naming the item", async () => {
    const a = await withStore("Demo Studio A");
    const approval = (key: string, store: string) =>
      addApproval(env.DB, {
        key,
        account: "demo_travel",
        dueAt: 1_900_000_000,
        captionSha256: "c",
        commentSha256: null,
        altSha256: null,
        media: [{ store, id: "abc", checksum: "e1" }],
        approvedAt: "2026-10-01T00:00:00Z",
        approvedBy: "owner",
      });
    await approval("reel:trip/short1", `s3-${a}`);
    await approval("reel:trip/other", "s3"); // the instance's store: not this one's
    expect(await waitingApprovalsIn(e, `s3-${a}`)).toBe(1);
    await expect(removeStore(e, { workspaceId: a }, "s3", 1)).rejects.toThrow(
      "1 approved items use this store: reel:trip/short1",
    );
    expect(await ids(a)).toContain(`s3-${a}`);
    // published: it no longer counts
    await env.DB.prepare(
      "INSERT INTO posted (item_key, account, published_at, permalink, source) VALUES ('reel:trip/short1', 'demo_travel', 1790000000, 'https://example.com/p/', 'manual')",
    ).run();
    expect(await waitingApprovalsIn(e, `s3-${a}`)).toBe(0);
    await removeStore(e, { workspaceId: a }, "s3", 2);
    expect(await ids(a)).not.toContain(`s3-${a}`);
    // the instance's scope removes only the instance's
    await expect(removeStore(e, { workspaceId: a }, "drive", 3)).rejects.toThrow(/no drive store/);
  });

  it("forgets the folders remembered for a removed store, and only its own", async () => {
    const a = await withStore("Demo Studio A");
    const keep = [`drive_upload_folder:drive-${a}:Uploads`, "inbox_folder:s3:x", "drive_upload_folder:drive:Uploads"];
    await env.DB.batch(
      [`inbox_folder:s3-${a}`, `inbox_folder:s3-${a}:${a}`, ...keep].map((k) =>
        env.DB.prepare("INSERT INTO settings (key, value) VALUES (?1, 'x')").bind(k),
      ),
    );
    await removeStore(e, { workspaceId: a }, "s3", 1);
    const keys = await env.DB.prepare("SELECT key FROM settings WHERE key LIKE '%folder:%' ORDER BY key").all<{
      key: string;
    }>();
    expect(keys.results.map((k) => k.key)).toEqual([...keep].sort());
  });

  it("tells a workspace's own people when its store breaks, the instance admins when the instance's does", async () => {
    const a = await withStore("Demo Studio A");
    await setWorkspaceNtfy(e, a, "https://ntfy.test/topic-a", 0);
    const topics: string[] = [];
    const spy: typeof fetch = async (input, init) => {
      const url = new Request(input as RequestInfo).url;
      if (url.startsWith("https://ntfy.test/")) topics.push(url);
      return w.fetch(input, init);
    };
    // A's bucket keys stop working; the instance's Drive is revoked too
    await env.DB.prepare("UPDATE media_store SET credentials = ?1 WHERE id = ?2")
      .bind(
        await encryptSecret(TEST_ENCRYPTION_KEY, JSON.stringify({ ...TEST_S3_KEYS, accessKeyId: "WRONG" })),
        `s3-${a}`,
      )
      .run();
    expect(await checkStores(e, { fetch: spy, now: AT })).toEqual({ checked: ["drive"], broken: [`s3-${a}`] });
    expect(topics).toEqual(["https://ntfy.test/topic-a"]); // A's topic only, not the default workspace's
    const said = (
      await env.DB.prepare("SELECT workspace_id FROM audit WHERE action = 'notify' AND target = 'media_stores'").all<{
        workspace_id: string | null;
      }>()
    ).results.map((r) => r.workspace_id);
    expect(said).toEqual([a]); // none in no workspace: the instance admins weren't told
    // the status is the row's own
    const row = await env.DB.prepare("SELECT status FROM media_store WHERE id = ?1").bind(`s3-${a}`).first("status");
    expect(row).toBe("broken");
    // now the instance's Drive breaks: the instance admins hear of it (audit in no workspace), no workspace's topic
    topics.length = 0;
    w.googleRefuse = true;
    clearTokenCache();
    const later = new Date(AT.getTime() + (CHECK_EVERY_S + 60) * 1000);
    expect(await checkStores(e, { fetch: spy, now: later })).toMatchObject({
      broken: expect.arrayContaining(["drive"]),
    });
    expect(topics).toEqual([]);
    const inst = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM audit WHERE action = 'notify' AND target = 'media_stores' AND workspace_id IS NULL",
    ).first("n");
    expect(inst).toBe(1);
  });

  it("keeps two Drive stores' folders apart: the same path resolves to each grant's own folder", async () => {
    const w2 = new World();
    const folder = (name: string, parent?: string) => ({
      md5: "",
      mimeType: "application/vnd.google-apps.folder",
      name,
      parent,
    });
    w.drivePut("UPLOADS/inbox/a.txt", { md5: "a", mimeType: "text/plain" });
    w2.drive.set("other_uploads", folder("UPLOADS"));
    w2.drive.set("other_inbox", folder("inbox", "other_uploads"));
    const grant2 = JSON.stringify({ ...JSON.parse(TEST_DRIVE_GRANT), refresh_token: "r-other" });
    const one = new DriveStore({ oauth: TEST_DRIVE_GRANT, fetch: w.fetch, id: "drive" });
    const two = new DriveStore({ oauth: grant2, fetch: w2.fetch, id: "drive-w_other" });
    const first = await one.resolve("UPLOADS/inbox");
    expect((await two.resolve("UPLOADS/inbox"))?.id).toBe("other_inbox");
    expect((await one.resolve("UPLOADS/inbox"))?.id).toBe(first?.id); // not the other's, from the cache
    expect(first?.id).not.toBe("other_inbox");
    expect((await two.stat("other_inbox"))?.parent).toBe("other_uploads");
    expect(await two.inside("other_inbox", "UPLOADS")).toBe(true);
    expect(await one.inside("other_inbox", "UPLOADS")).toBe(false);
  });
});

describe("Connect Google Drive", () => {
  it("asks Google for the drive scope with PKCE, and saves the grant as the Drive store", async () => {
    await env.DB.prepare("DELETE FROM media_store").run();
    expect((await call("/admin-api/media-stores/drive/start", {})).status).toBe(400); // no Google app yet
    await call("/admin-api/oauth-apps/google", { clientId: "g-app", clientSecret: "g-secret" });
    const apps = (await call("/admin-api/oauth-apps")).json.apps as {
      id: string;
      providers: { redirectUri: string }[];
    }[];
    expect(apps.find((a) => a.id === "google")?.providers.map((p) => p.redirectUri)).toContain(
      "https://bongsu.test/admin-api/media-stores/drive/callback",
    );
    const url = new URL((await call("/admin-api/media-stores/drive/start", {})).json.url as string);
    expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/drive");
    expect(url.searchParams.get("redirect_uri")).toBe("https://bongsu.test/admin-api/media-stores/drive/callback");
    w.googleChallenge = url.searchParams.get("code_challenge")!;
    w.googleGrantScope = "https://www.googleapis.com/auth/drive";
    w.drivePut("UPLOADS/inbox/keep.txt", { md5: "k", mimeType: "text/plain" });
    const state = url.searchParams.get("state")!;
    // a YouTube callback can't finish a Drive flow
    // (sent with the Drive flow's cookie, as the starting browser could: the flow check refuses it, not the cookie)
    const wrong = await call(
      `/admin-api/connect/youtube/callback?code=g-code&state=${state}`,
      undefined,
      false,
      driveFlow,
    );
    expect(new URL(wrong.location!).searchParams.get("error")).toMatch(/isn't valid/);

    const url2 = new URL((await call("/admin-api/media-stores/drive/start", {})).json.url as string);
    w.googleChallenge = url2.searchParams.get("code_challenge")!;
    const back = await driveCallback(`code=g-code&state=${url2.searchParams.get("state")}`);
    expect(back.location).toBe("https://bongsu.test/dashboard/media?connected=drive");
    const stores = await mediaStores(e, w.fetch);
    expect(stores.default?.id).toBe("drive");
    expect(stores.errors.size).toBe(0);
  });

  it("refuses a grant without access to Drive", async () => {
    await call("/admin-api/oauth-apps/google", { clientId: "g-app", clientSecret: "g-secret" });
    const url = new URL((await call("/admin-api/media-stores/drive/start", {})).json.url as string);
    w.googleChallenge = url.searchParams.get("code_challenge")!;
    w.googleGrantScope = "https://www.googleapis.com/auth/drive.file";
    const back = await driveCallback(`code=g-code&state=${url.searchParams.get("state")}`);
    expect(new URL(back.location!).searchParams.get("error")).toMatch(/didn't grant access to Drive/);
  });

  it("finishes only in the browser that started it: no cookie, another flow's or a forged one spends no code", async () => {
    await env.DB.prepare("DELETE FROM media_store").run();
    await call("/admin-api/oauth-apps/google", { clientId: "g-app", clientSecret: "g-secret" });
    const first = await call("/admin-api/media-stores/drive/start", {});
    const firstCookie = driveFlow;
    const start = await call("/admin-api/media-stores/drive/start", {});
    const mine = driveFlow;
    expect(start.setCookies.find((x) => x.startsWith("bongsu_oauth="))).toMatch(
      /^bongsu_oauth=[A-Za-z0-9_-]{43}; Path=\/admin-api\/media-stores\/drive\/callback; HttpOnly; Secure; SameSite=Lax; Max-Age=900$/,
    );
    const url = new URL(start.json.url as string);
    w.googleChallenge = url.searchParams.get("code_challenge")!;
    w.googleGrantScope = "https://www.googleapis.com/auth/drive";
    w.drivePut("UPLOADS/inbox/keep.txt", { md5: "k", mimeType: "text/plain" });
    const q = `code=g-code&state=${url.searchParams.get("state")}`;
    for (const flowCookie of ["", firstCookie, "bongsu_oauth=forged-value-forged-value-forged-value-forged-va"]) {
      const r = await driveCallback(q, flowCookie);
      expect(new URL(r.location!).searchParams.get("error")).toMatch(/isn't valid/);
      expect(r.setCookies).toEqual([
        "bongsu_oauth=x; Path=/admin-api/media-stores/drive/callback; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
      ]);
    }
    expect(w.googleCodes).toEqual([]); // Google's token endpoint was never called
    expect((await mediaStores(e, w.fetch)).default?.id).not.toBe("drive");
    // a flow started before the browser was kept can't finish, even with its cookie
    const firstState = new URL(first.json.url as string).searchParams.get("state");
    await env.DB.prepare(
      "UPDATE oauth_states SET browser_hash = NULL WHERE provider = 'media:drive' AND state_hash <> ?1",
    )
      .bind(await sha256Hex(url.searchParams.get("state")!))
      .run();
    const old = await driveCallback(`code=g-code&state=${firstState}`, firstCookie);
    expect(new URL(old.location!).searchParams.get("error")).toMatch(/isn't valid/);
    expect(w.googleCodes).toEqual([]);
    // the refusals didn't use the state up: in the browser that started it, the flow finishes
    expect((await driveCallback(q, mine)).location).toBe("https://bongsu.test/dashboard/media?connected=drive");
    expect(w.googleCodes).toHaveLength(1);
  });
});

describe("Connect Google Drive for a workspace", () => {
  const OWN = { id: "own-g-app", secret: "own-g-secret" };
  /** A workspace, with `admin` (an admin) and `cara` (a creator) as members. */
  async function workspace() {
    const id = await createWorkspace(env.DB, { name: "Demo Studio", timezone: "UTC", createdBy: "owner" }, 0);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO users (id, name, created_at) VALUES ('wadmin', 'wadmin', 0)"),
      env.DB.prepare("INSERT INTO users (id, name, created_at) VALUES ('cara', 'cara', 0)"),
      env.DB.prepare(
        "INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES (?1, 'wadmin', 'admin', 0)",
      ).bind(id),
      env.DB.prepare(
        "INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES (?1, 'cara', 'creator', 0)",
      ).bind(id),
    ]);
    return id;
  }
  const start = async (userId: string, ws: string) => {
    const flow = await startDriveConnect(e, userId, ws, Math.floor(Date.now() / 1000));
    const url = new URL(flow.url);
    w.googleChallenge = url.searchParams.get("code_challenge")!;
    w.googleGrantScope = "https://www.googleapis.com/auth/drive";
    return { url, cookie: `bongsu_oauth=${flow.browser}` };
  };

  it("uses the workspace's Google app and saves the Drive store of that workspace", async () => {
    await call("/admin-api/oauth-apps/google", { clientId: "g-app", clientSecret: "g-secret" });
    const ws = await workspace();
    await saveWorkspaceOAuthApp(e, ws, "google", OWN.id, OWN.secret, "wadmin", 0);
    w.drivePut(`${(await workspaceSettings(env.DB, ws)).mediaFolder}/inbox/keep.txt`, {
      md5: "k",
      mimeType: "text/plain",
    });
    const f = await start("wadmin", ws);
    expect(f.url.searchParams.get("client_id")).toBe(OWN.id);
    const back = await driveCallback(`code=g-code&state=${f.url.searchParams.get("state")}`, f.cookie);
    expect(back.location).toBe("https://bongsu.test/dashboard/settings/media?connected=drive");
    expect(w.googleCodes[0]).toMatchObject({ client_id: OWN.id, client_secret: OWN.secret });
    const rows = await env.DB.prepare(
      "SELECT id, workspace_id FROM media_store WHERE kind = 'drive' AND workspace_id IS NOT NULL",
    ).all();
    expect(rows.results).toEqual([{ id: `drive-${ws}`, workspace_id: ws }]);
  });

  it("falls back to the instance's Google app, and refuses a creator finishing the flow", async () => {
    await call("/admin-api/oauth-apps/google", { clientId: "g-app", clientSecret: "g-secret" });
    const ws = await workspace();
    expect((await start("wadmin", ws)).url.searchParams.get("client_id")).toBe("g-app");
    const f = await start("cara", ws); // started by a creator (or an admin since demoted)
    const back = await driveCallback(`code=g-code&state=${f.url.searchParams.get("state")}`, f.cookie);
    expect(new URL(back.location!).searchParams.get("error")).toMatch(/admin/);
    expect(w.googleCodes).toEqual([]);
    expect(await env.DB.prepare("SELECT id FROM media_store WHERE id = ?1").bind(`drive-${ws}`).first()).toBeNull();
  });

  it("fails when the workspace's app was removed since the start", async () => {
    await call("/admin-api/oauth-apps/google", { clientId: "g-app", clientSecret: "g-secret" });
    const ws = await workspace();
    await saveWorkspaceOAuthApp(e, ws, "google", OWN.id, OWN.secret, "wadmin", 0);
    const f = await start("wadmin", ws);
    await removeWorkspaceOAuthApp(env.DB, ws, "google");
    const back = await driveCallback(`code=g-code&state=${f.url.searchParams.get("state")}`, f.cookie);
    expect(new URL(back.location!).searchParams.get("error")).toBe("the OAuth app changed: start again");
  });
});

describe("several stores side by side", () => {
  it("drafts what's dropped in the inbox of every store, each draft naming its store", async () => {
    await seedS3Store();
    const env2 = { ...e };
    w.drivePut("UPLOADS/inbox/trip/fromdrive.mp4", {
      md5: "d1",
      mimeType: "video/mp4",
      modified: "2026-10-01T00:00:00Z",
    });
    await w.s3.put("UPLOADS/inbox/trip/frombucket.mp4", "video", "video/mp4");
    const r = await scanInbox(env2, { fetch: w.fetch, now: new Date(Date.now() + 3600_000) });
    expect(r.drafted.sort()).toEqual(["trip/frombucket", "trip/fromdrive"]);
    const drafts = await env.DB.prepare("SELECT created_by, payload FROM drafts ORDER BY created_by").all<{
      created_by: string;
      payload: string;
    }>();
    expect(drafts.results.map((d) => [d.created_by, JSON.parse(d.payload).media[0].store])).toEqual([
      ["drive-inbox", "drive"],
      ["s3-inbox", "s3"],
    ]);
  });

  it("keeps scanning the other stores when one fails", async () => {
    await seedS3Store();
    await w.s3.put("UPLOADS/inbox/trip/frombucket.mp4", "video", "video/mp4");
    w.googleRefuse = true; // the Drive grant was revoked
    const r = await scanInbox(e, { fetch: w.fetch, now: new Date(Date.now() + 3600_000) });
    expect(r.drafted).toEqual(["trip/frombucket"]);
  });

  it("checks each store weekly, marks a broken one and says so once", async () => {
    await seedS3Store();
    await w.s3.put("UPLOADS/x.txt", "x", "text/plain");
    w.drivePut("UPLOADS/x.txt", { md5: "x", mimeType: "text/plain" });
    expect(await checkStores(e, { fetch: w.fetch, now: AT })).toEqual({ checked: ["drive", "s3"], broken: [] });
    expect(await checkStores(e, { fetch: w.fetch, now: AT })).toEqual({ checked: [], broken: [] }); // not due
    w.googleRefuse = true;
    clearTokenCache(); // the access token from the first check would still be good
    const later = new Date(AT.getTime() + (CHECK_EVERY_S + 60) * 1000);
    expect(await checkStores(e, { fetch: w.fetch, now: later })).toEqual({ checked: ["s3"], broken: ["drive"] });
    // the stores are the instance's: its admins hear of it (the audit log, in no workspace), no workspace's topic
    expect(w.notifications).toEqual([]);
    const said = await env.DB.prepare(
      "SELECT detail, workspace_id FROM audit WHERE action = 'notify' AND target = 'media_stores'",
    ).all<{ detail: string; workspace_id: string | null }>();
    expect(said.results.map((r) => [JSON.parse(r.detail).title, r.workspace_id])).toEqual([
      ["A media store needs attention", null],
    ]);
    const h = await createApp(w.fetch).request("/health", {}, e);
    expect(h.status).toBe(503);
    expect(((await h.json()) as { media_stores: unknown }).media_stores).toEqual([
      { kind: "drive", status: "broken", default: true },
      { kind: "s3", status: "ok", default: false },
    ]);
  });

  it("tells the instance admins when a store breaks", async () => {
    const m = await testEnv(env, {
      MAILER: "resend",
      MAIL_FROM: "Bongsu <bongsu@example.com>",
      RESEND_API_KEY: "re_test",
    } as Partial<Env>);
    // a workspace admin who isn't an instance admin isn't told: the stores aren't theirs
    await env.DB.prepare(
      "INSERT INTO users (id, email, name, created_at) VALUES ('ada', 'ada@example.com', 'Ada', 0) ON CONFLICT (id) DO NOTHING",
    ).run();
    await env.DB.prepare(
      "INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES ('default', 'ada', 'admin', 0) ON CONFLICT (workspace_id, user_id) DO NOTHING",
    ).run();
    w.googleRefuse = true;
    clearTokenCache();
    expect(await checkStores(m, { fetch: w.fetch, now: AT })).toEqual({ checked: [], broken: ["drive"] });
    expect(w.mails).toEqual([
      expect.objectContaining({
        from: "Bongsu <bongsu@example.com>",
        to: ["owner@example.com"],
        subject: "Bongsu: a media store needs attention",
        text: expect.stringMatching(/^drive: [\s\S]*\/dashboard\/media$/),
      }),
    ]);
  });

  it("writes no mail when no instance admin has an email, and still logs the notice", async () => {
    // a mailer that sees every send (Resend's skips an empty list itself; another mailer may not)
    const sent: Mail[] = [];
    registerMailer("spy", () => ({ id: "spy", send: async (mail) => void sent.push(mail) }));
    const m = await testEnv(env, { MAILER: "spy" } as Partial<Env>);
    await env.DB.prepare("UPDATE users SET email = NULL WHERE instance_admin = 1").run();
    w.googleRefuse = true;
    clearTokenCache();
    expect(await checkStores(m, { fetch: w.fetch, now: AT })).toEqual({ checked: [], broken: ["drive"] });
    expect(sent).toEqual([]);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM audit WHERE action = 'notify' AND target = 'media_stores' AND workspace_id IS NULL",
      ).first("n"),
    ).toBe(1);
  });

  it("isn't healthy without any store", async () => {
    await env.DB.prepare("DELETE FROM media_store").run();
    const h = await createApp(w.fetch).request("/health", {}, e);
    expect(h.status).toBe(503);
    expect(((await h.json()) as { media_stores: unknown }).media_stores).toEqual([]);
  });
});
