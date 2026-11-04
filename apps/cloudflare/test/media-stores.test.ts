// The media stores (Phase 12): set up in the dashboard (an S3 bucket from a form, Google Drive with its button), several
// side by side with one default, each file read from the store its reference names; the inbox in every store, uploads
// to the store the owner picks, the weekly check, and /health.
import { env } from "cloudflare:workers";
import { createApp } from "@bongsu/api/app";
import { adminRoutes } from "@bongsu/api/dashboard/routes";
import type { Verifiers } from "@bongsu/api/pwa/webauthn";
import { clearTokenCache } from "@bongsu/core/clients/google";
import { addApproval } from "@bongsu/core/data";
import type { Env } from "@bongsu/core/env";
import { scanInbox } from "@bongsu/core/inbox";
import { mediaStores } from "@bongsu/core/media/index";
import { CHECK_EVERY_S, checkStores } from "@bongsu/core/media/manage";
import { beforeEach, describe, expect, it } from "vitest";
import { joinDefault, seedS3Store, TEST_S3_KEYS, TEST_S3_SETTINGS, testEnv, UNBOOTSTRAP, World } from "./world";

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
async function call(path: string, body?: unknown, withCookie = true) {
  const r = await adminRoutes(w.fetch, fake).request(
    `https://bongsu.test${path}`,
    {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json", ...(cookie && withCookie ? { Cookie: cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    e,
  );
  const set = r.headers.get("Set-Cookie");
  if (set && !set.includes("Max-Age=0")) cookie = set.split(";")[0];
  const text = await r.text();
  return {
    status: r.status,
    location: r.headers.get("Location"),
    json: (text.startsWith("{") ? JSON.parse(text) : {}) as Record<string, unknown>,
  };
}
const AT = new Date("2026-10-20T00:00:00Z");
const S3_FORM = { ...TEST_S3_SETTINGS, ...TEST_S3_KEYS };

beforeEach(async () => {
  cookie = "";
  w = new World();
  await env.DB.batch(
    [
      ...UNBOOTSTRAP,
      "DELETE FROM oauth_apps",
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
    const wrong = await call(`/admin-api/connect/youtube/callback?code=g-code&state=${state}`, undefined, false);
    expect(new URL(wrong.location!).searchParams.get("error")).toMatch(/isn't valid/);

    const url2 = new URL((await call("/admin-api/media-stores/drive/start", {})).json.url as string);
    w.googleChallenge = url2.searchParams.get("code_challenge")!;
    const back = await call(
      `/admin-api/media-stores/drive/callback?code=g-code&state=${url2.searchParams.get("state")}`,
      undefined,
      false,
    );
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
    const back = await call(
      `/admin-api/media-stores/drive/callback?code=g-code&state=${url.searchParams.get("state")}`,
      undefined,
      false,
    );
    expect(new URL(back.location!).searchParams.get("error")).toMatch(/didn't grant access to Drive/);
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
    expect(w.notifications.map((n) => n.title)).toEqual(["A media store needs attention"]);
    const h = await createApp(w.fetch).request("/health", {}, e);
    expect(h.status).toBe(503);
    expect(((await h.json()) as { media_stores: unknown }).media_stores).toEqual([
      { kind: "drive", status: "broken", default: true },
      { kind: "s3", status: "ok", default: false },
    ]);
  });

  it("isn't healthy without any store", async () => {
    await env.DB.prepare("DELETE FROM media_store").run();
    const h = await createApp(w.fetch).request("/health", {}, e);
    expect(h.status).toBe(503);
    expect(((await h.json()) as { media_stores: unknown }).media_stores).toEqual([]);
  });
});
