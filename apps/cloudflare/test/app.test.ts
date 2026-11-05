import { env } from "cloudflare:workers";
import { appRoutes } from "@bongsu/api/pwa/routes";
import type { Verifiers } from "@bongsu/api/pwa/webauthn";
import { setAccountSettings } from "@bongsu/core/accounts";
import type { Env } from "@bongsu/core/env";
import { sha256Hex } from "@bongsu/core/formats/approved";
import { tick } from "@bongsu/core/tick";
import { beforeEach, describe, expect, it } from "vitest";
import {
  approve,
  clearPlan,
  copyText,
  igHappyPath,
  MD5,
  planItem,
  seedMediaStore,
  seedReel,
  testEnv,
  World,
} from "./world";

// Stand-ins for a real authenticator: the routes' own logic (codes, challenges, snapshots, sessions) is what's tested.
const fake: Verifiers = {
  registration: (async () => ({
    verified: true,
    registrationInfo: {
      credential: { id: "cred1", publicKey: new Uint8Array([1, 2, 3]), counter: 0, transports: ["internal"] },
    },
  })) as unknown as Verifiers["registration"],
  authentication: (async () => ({
    verified: true,
    authenticationInfo: { newCounter: 1 },
  })) as unknown as Verifiers["authentication"],
};
const refusing: Verifiers = {
  ...fake,
  authentication: (async () => ({
    verified: false,
    authenticationInfo: { newCounter: 0 },
  })) as unknown as Verifiers["authentication"],
};

let w: World;
let e: Env;
let cookie = "";

async function call(path: string, init: RequestInit = {}, verifiers: Verifiers = fake) {
  const r = await appRoutes(w.fetch, verifiers).request(
    `https://bongsu.test${path}`,
    {
      ...init,
      headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...(init.headers ?? {}) },
    },
    e,
  );
  const set = r.headers.get("Set-Cookie");
  if (set) cookie = set.split(";")[0];
  return r;
}
const post = (path: string, body: unknown = {}, v?: Verifiers) =>
  call(path, { method: "POST", body: JSON.stringify(body) }, v);

async function signUp() {
  await env.DB.prepare("INSERT INTO setup_codes (code_hash, expires_at) VALUES (?1, ?2)")
    .bind(await sha256Hex("CODE-1234"), Math.floor(Date.now() / 1000) + 600)
    .run();
  const o = (await (await post("/app-api/setup/options", { code: "CODE-1234" })).json()) as { challengeId: string };
  return post("/app-api/setup/verify", { challengeId: o.challengeId, response: { id: "cred1" }, name: "test phone" });
}

beforeEach(async () => {
  await env.DB.batch(
    ["passkeys", "sessions", "challenges", "setup_codes", "audit", "push_subs", "drafts", "jobs"].map((t) =>
      env.DB.prepare(`DELETE FROM ${t}`),
    ),
  );
  await clearPlan();
  w = new World();
  e = await testEnv(env, { PUBLIC_URL: "https://bongsu.test", RP_ID: "bongsu.test" } as Partial<Env>);
  cookie = "";
});

describe("owner sign-in", () => {
  it("needs setup first, and only a valid one-time code starts it", async () => {
    expect(await (await call("/app-api/me")).json()).toMatchObject({ signedIn: false, setupNeeded: true });
    expect((await post("/app-api/setup/options", { code: "WRONG" })).status).toBe(403);
    expect((await signUp()).status).toBe(200);
    expect(await (await call("/app-api/me")).json()).toMatchObject({ signedIn: true, setupNeeded: false });
    cookie = "";
    expect((await post("/app-api/setup/options", { code: "CODE-1234" })).status).toBe(403); // used up
  });

  it("keeps the code after a failed attempt, and uses it up only when a passkey is created", async () => {
    await env.DB.prepare("INSERT INTO setup_codes (code_hash, expires_at) VALUES (?1, ?2)")
      .bind(await sha256Hex("CODE-9999"), Math.floor(Date.now() / 1000) + 600)
      .run();
    const failing: Verifiers = {
      ...fake,
      registration: (async () => ({ verified: false })) as unknown as Verifiers["registration"],
    };
    const o1 = (await (await post("/app-api/setup/options", { code: "code-9999" })).json()) as { challengeId: string };
    expect(
      (await post("/app-api/setup/verify", { challengeId: o1.challengeId, response: { id: "cred1" } }, failing)).status,
    ).toBe(400);
    const o2 = (await (await post("/app-api/setup/options", { code: "CODE-9999" })).json()) as { challengeId: string };
    expect(
      (await post("/app-api/setup/verify", { challengeId: o2.challengeId, response: { id: "cred1" } })).status,
    ).toBe(200);
    cookie = "";
    expect((await post("/app-api/setup/options", { code: "CODE-9999" })).status).toBe(403);
  });

  it("guards every data route with the session, and signs in again with the passkey", async () => {
    await signUp();
    expect((await call("/app-api/status")).status).toBe(200);
    await post("/app-api/logout");
    expect((await call("/app-api/status")).status).toBe(401);
    const o = (await (await post("/app-api/login/options")).json()) as { challengeId: string };
    expect(
      (await post("/app-api/login/verify", { challengeId: o.challengeId, response: { id: "cred1" } }, refusing)).status,
    ).toBe(401);
    const o2 = (await (await post("/app-api/login/options")).json()) as { challengeId: string };
    expect(
      (await post("/app-api/login/verify", { challengeId: o2.challengeId, response: { id: "cred1" } })).status,
    ).toBe(200);
    expect((await call("/app-api/status")).status).toBe(200);
  });

  it("uses each challenge once", async () => {
    await signUp();
    await post("/app-api/logout");
    const o = (await (await post("/app-api/login/options")).json()) as { challengeId: string };
    expect(
      (await post("/app-api/login/verify", { challengeId: o.challengeId, response: { id: "cred1" } })).status,
    ).toBe(200);
    await post("/app-api/logout");
    expect(
      (await post("/app-api/login/verify", { challengeId: o.challengeId, response: { id: "cred1" } })).status,
    ).toBe(401);
  });
});

describe("adding a device", () => {
  it("registers another passkey with a one-time code from the dashboard (the app no longer makes codes)", async () => {
    await signUp();
    expect((await post("/app-api/setup-code")).status).toBe(404); // Devices & passkeys in the dashboard makes them
    const code = "ABCD-EFGH-JKLM";
    await env.DB.prepare("INSERT INTO setup_codes (code_hash, expires_at, user_id) VALUES (?1, ?2, 'owner')")
      .bind(await sha256Hex(code), Math.floor(Date.now() / 1000) + 900)
      .run();
    cookie = "";
    const o = (await (await post("/app-api/setup/options", { code })).json()) as { challengeId: string };
    const second: Verifiers = {
      ...fake,
      registration: (async () => ({
        verified: true,
        registrationInfo: {
          credential: { id: "cred2", publicKey: new Uint8Array([4]), counter: 0, transports: ["internal"] },
        },
      })) as unknown as Verifiers["registration"],
    };
    expect(
      (
        await post(
          "/app-api/setup/verify",
          { challengeId: o.challengeId, response: { id: "cred2" }, name: "phone" },
          second,
        )
      ).status,
    ).toBe(200);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM passkeys").first<{ n: number }>())?.n).toBe(2);
  });
});

describe("approving from the app", () => {
  async function reelOnDrive(approve = false) {
    const { folder, base } = await seedReel(w, { approve });
    w.drivePut(`UPLOADS/${folder}/exports/shorts/instagram/${base}.mp4`, { md5: MD5, mimeType: "video/mp4" });
    return `reel:20260823_LISBON/${base}`;
  }

  it("shows an item with preview links and refuses to approve what isn't on Drive", async () => {
    await signUp();
    const { base } = await seedReel(w, { approve: false });
    const key = `reel:20260823_LISBON/${base}`;
    const blocked = await post("/app-api/approve/options", { key });
    expect(blocked.status).toBe(409);
    expect(((await blocked.json()) as { problems: string[] }).problems[0]).toContain("not in the media store yet");
    w.drivePut(`UPLOADS/vlogs/CONTENT/20260823_LISBON/exports/shorts/instagram/${base}.mp4`, {
      md5: MD5,
      mimeType: "video/mp4",
    });
    const item = (await (await call(`/app-api/item?key=${encodeURIComponent(key)}`)).json()) as {
      media: { url: string }[];
      caption: string;
      problems: string[];
      due: string;
    };
    expect(item.problems).toEqual([]);
    expect(item.due).toBe("2026-10-20 18:00");
    expect(item.media[0].url).toMatch(/^https:\/\/bongsu\.test\/m\/.+\.mp4\?exp=\d+&sig=[0-9a-f]{64}$/);
  });

  it("records the approval in D1 after a passkey check (no repo write), and it matches what was shown", async () => {
    await signUp();
    const key = await reelOnDrive();
    const o = (await (await post("/app-api/approve/options", { key })).json()) as { challengeId: string };
    const r = await post("/app-api/approve/verify", { challengeId: o.challengeId, response: { id: "cred1" } });
    expect(await r.json()).toMatchObject({ approved: true, key, due: "2026-10-20 18:00" });
    const a = await env.DB.prepare("SELECT * FROM approvals WHERE item_key = ?1 ORDER BY id DESC")
      .bind(key)
      .first<{ approved_by: string; caption_sha: string; media: string; due_at: number }>();
    expect(a!.approved_by).toBe("owner@app");
    expect(a!.due_at).toBe(Date.UTC(2026, 9, 20, 9, 0) / 1000); // 18:00 in Seoul, kept in UTC
    expect(a!.caption_sha).toBe(await sha256Hex("A caption\n\nWhere next?\n\n#travel"));
    expect(JSON.parse(a!.media)).toEqual([{ store: "drive", id: expect.any(String), checksum: MD5 }]);
    const item = (await (await call(`/app-api/item?key=${encodeURIComponent(key)}`)).json()) as {
      approved: { matches: boolean };
    };
    expect(item.approved.matches).toBe(true);
  });

  it("refuses when the item changed between looking and approving", async () => {
    await signUp();
    const key = await reelOnDrive();
    const o = (await (await post("/app-api/approve/options", { key })).json()) as { challengeId: string };
    await copyText(
      "channels/vlogs/CONTENT/20260823_LISBON/shorts/instagram/short1_x.txt",
      "Someone edited the caption",
    );
    const r = await post("/app-api/approve/verify", { challengeId: o.challengeId, response: { id: "cred1" } });
    expect(r.status).toBe(409);
  });

  it("refuses a failed passkey check", async () => {
    await signUp();
    const key = await reelOnDrive();
    const o = (await (await post("/app-api/approve/options", { key })).json()) as { challengeId: string };
    expect(
      (await post("/app-api/approve/verify", { challengeId: o.challengeId, response: { id: "cred1" } }, refusing))
        .status,
    ).toBe(401);
  });
  it("holds and releases one approved item, keeping its approval", async () => {
    await signUp();
    const key = await reelOnDrive();
    const o = (await (await post("/app-api/approve/options", { key })).json()) as { challengeId: string };
    await post("/app-api/approve/verify", { challengeId: o.challengeId, response: { id: "cred1" } });
    expect(await (await post("/app-api/item/hold", { key, hold: true })).json()).toMatchObject({
      key,
      hold: true,
      approved: true,
    });
    const held = (await (await call(`/app-api/item?key=${encodeURIComponent(key)}`)).json()) as {
      hold: boolean;
      approved: { matches: boolean };
    };
    expect(held).toMatchObject({ hold: true, approved: { matches: true } });
    expect(await (await post("/app-api/item/hold", { key, hold: false })).json()).toMatchObject({
      hold: false,
      approved: true,
    });
    expect((await post("/app-api/item/hold", { key: "reel:nope/x", hold: true })).status).toBe(404);
  });

  it("offers a failed item for approval again, and a new approval starts it over (#148)", async () => {
    await signUp();
    const key = await reelOnDrive();
    const approveIt = async () => {
      const o = (await (await post("/app-api/approve/options", { key })).json()) as { challengeId: string };
      await post("/app-api/approve/verify", { challengeId: o.challengeId, response: { id: "cred1" } });
    };
    await approveIt();
    const failedJob = (payload: Record<string, unknown>) =>
      env.DB.batch([
        env.DB.prepare("DELETE FROM jobs WHERE item_key = ?1").bind(key),
        env.DB.prepare(
          `INSERT INTO jobs (item_key, kind, account, due_at, state, last_error, dry_run, payload, created_at, updated_at,
             workspace_id, attempts, container_id)
           VALUES (?1, 'video', 'instagram_conn-a', ?2, 'failed', 'Instagram busy', 0, ?3, 0, ?4, 'default', 3, 'old')`,
        ).bind(key, Date.UTC(2026, 9, 20, 9, 0) / 1000, JSON.stringify(payload), Math.floor(Date.now() / 1000) - 60),
      ]);
    const view = async () =>
      (await (await call(`/app-api/item?key=${encodeURIComponent(key)}`)).json()) as {
        approved: { matches: boolean };
        failed: { error: string | null; again: boolean } | null;
      };

    await failedJob({ publishing: true }); // the publishing call was made: it may be live
    expect((await view()).failed).toEqual({ error: "Instagram busy", again: false });

    await failedJob({ approvedAt: "2026-10-17T01:00:00Z" });
    const item = await view();
    expect(item).toMatchObject({ approved: { matches: true }, failed: { error: "Instagram busy", again: true } });
    await approveIt(); // nothing changed, but the owner approves again
    expect(
      (await env.DB.prepare("SELECT COUNT(*) AS n FROM approvals WHERE item_key = ?1").bind(key).first<{ n: number }>())
        ?.n,
    ).toBe(2);
    igHappyPath(w);
    await tick(e, { fetch: w.fetch, now: new Date("2026-10-20T09:32:00Z") });
    expect(
      await env.DB.prepare("SELECT state, attempts, container_id FROM jobs WHERE item_key = ?1").bind(key).first(),
    ).toEqual({ state: "container_created", attempts: 0, container_id: "container-1" });
    expect((await view()).failed).toBeNull();
  });

  it("refuses to approve when the item changed since the page loaded", async () => {
    await signUp();
    const key = await reelOnDrive();
    const item = (await (await call(`/app-api/item?key=${encodeURIComponent(key)}`)).json()) as { fingerprint: string };
    expect(item.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    const stale = await post("/app-api/approve/options", { key, fingerprint: "0".repeat(64) });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ changed: true });
    expect((await post("/app-api/approve/options", { key, fingerprint: item.fingerprint })).status).toBe(200);
    // A resume challenge can't be used to approve.
    const r = (await (await post("/app-api/resume/options")).json()) as { challengeId: string };
    expect(
      (await post("/app-api/approve/verify", { challengeId: r.challengeId, response: { id: "cred1" } })).status,
    ).toBe(401);
  });
});

describe("pause, resume and push", () => {
  it("pauses and resumes (in D1)", async () => {
    await signUp();
    await post("/app-api/pause", { reason: "checking captions" });
    expect(
      await env.DB.prepare(
        "SELECT paused FROM workspace_settings WHERE workspace_id = 'default' AND paused IS NOT NULL",
      ).first(),
    ).not.toBeNull();
    expect((await post("/app-api/resume")).status).toBe(404); // no passkey-less resume
    const o = (await (await post("/app-api/resume/options")).json()) as { challengeId: string };
    expect(
      (await post("/app-api/resume/verify", { challengeId: o.challengeId, response: { id: "cred1" } }, refusing))
        .status,
    ).toBe(401);
    const o2 = (await (await post("/app-api/resume/options")).json()) as { challengeId: string };
    expect(
      await (await post("/app-api/resume/verify", { challengeId: o2.challengeId, response: { id: "cred1" } })).json(),
    ).toMatchObject({ paused: false, wasPaused: true });
    expect(
      await env.DB.prepare(
        "SELECT paused FROM workspace_settings WHERE workspace_id = 'default' AND paused IS NOT NULL",
      ).first(),
    ).toBeNull();
  });

  it("stores a device's push subscription", async () => {
    await signUp();
    expect(
      (
        await post("/app-api/push/subscribe", {
          endpoint: "https://fcm.googleapis.com/fcm/send/abc",
          keys: {
            p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM",
            auth: "tBHItJI5svbpez7KI4CCXg",
          },
          device: "Pixel",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await post("/app-api/push/subscribe", {
          endpoint: "http://insecure",
          keys: { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4", auth: "tBHItJI5svbpez7KI4CCXg" },
        })
      ).status,
    ).toBe(400);
    expect((await env.DB.prepare("SELECT device FROM push_subs").all()).results).toEqual([{ device: "Pixel" }]);
  });
});

describe("the calendar", () => {
  it("shows Instagram items with their state and both channels' YouTube uploads, for one month", async () => {
    await signUp();
    await seedReel(w, { base: "short1_x", date: "2026-10-20" }); // approved
    await seedReel(w, { base: "short2_y", date: "2026-10-21", approve: false }); // not approved
    await planItem({ folder: "vlogs/CONTENT/20260823_LISBON", name: "short3_z", date: "2026-10-22", hold: true });
    const done = await planItem({ folder: "vlogs/CONTENT/20260823_LISBON", name: "short0_old", date: "2026-10-05" });
    await env.DB.prepare(
      "INSERT INTO posted (item_key, account, published_at, permalink, source) VALUES (?1, 'demo_travel', unixepoch('2026-10-05 03:00'), 'https://ig/p/', 'manual')",
    )
      .bind(done)
      .run();
    await planItem({ folder: "vlogs/CONTENT/20260823_LISBON", name: "short9_nov", date: "2026-11-02" }); // another month
    w.ytUploads = [
      {
        id: "vidPUB000001",
        title: "Public video",
        privacy: "public",
        publishedAt: "2026-10-10T03:00:00Z",
        duration: "PT12M3S",
      },
      {
        id: "vidSCH000002",
        title: "Scheduled Short",
        privacy: "private",
        publishedAt: "2026-10-01T00:00:00Z",
        publishAt: "2026-10-25T12:00:00Z",
        duration: "PT35S",
      },
    ];
    const r = (await (await call("/app-api/calendar?month=2026-10")).json()) as {
      events: {
        date: string;
        time: string | null;
        platform: string;
        format: string | null;
        label: string;
        title: string;
        status: string;
        account?: string;
      }[];
      warnings: string[];
    };
    expect(r.warnings).toEqual([]);
    const ig = r.events
      .filter((e) => e.platform === "instagram" && e.format === "video")
      .map((e) => [e.date, e.title, e.status]);
    expect(r.events.find((e) => e.platform === "instagram")?.label).toBe("Reel");
    expect(ig).toEqual([
      ["2026-10-05", "short0_old", "posted"],
      ["2026-10-20", "short1_x", "approved"],
      ["2026-10-21", "short2_y", "not approved"],
      ["2026-10-22", "short3_z", "hold"],
    ]);
    const yt = r.events
      .filter((e) => e.platform === "youtube")
      .map((e) => [e.account, e.date, e.time, e.title, e.status]);
    expect(r.events.find((e) => e.title === "Short · Scheduled Short")?.label).toBe("Short");
    expect(yt).toContainEqual(["main", "2026-10-10", "12:00", "Public video", "public"]);
    expect(yt).toContainEqual(["vlogs", "2026-10-25", "21:00", "Short · Scheduled Short", "scheduled"]);
    expect((await call("/app-api/calendar?month=10-2026")).status).toBe(400);
  });
});

describe("the day view and the queue from tomorrow", () => {
  it("lists a day's items posted or not, and the queue can start from a date", async () => {
    await signUp();
    await seedReel(w, { base: "short1_today", date: "2026-10-20" });
    const done = await planItem({ folder: "vlogs/CONTENT/20260823_LISBON", name: "short0_done", date: "2026-10-20" });
    await env.DB.prepare(
      "INSERT INTO posted (item_key, account, permalink, source, published_at) VALUES (?1, 'demo_travel', 'https://ig/p/', 'scheduler', unixepoch('2026-10-20T03:31:00'))",
    )
      .bind(done)
      .run();
    await seedReel(w, { base: "short2_tomorrow", date: "2026-10-21" });
    const day = (await (await call("/app-api/day?date=2026-10-20")).json()) as {
      events: { title: string; status: string; posted_at?: string }[];
    };
    expect(day.events.map((e) => [e.title, e.status]).sort()).toEqual([
      ["short0_done", "posted"],
      ["short1_today", "approved"],
    ]);
    expect(day.events.find((e) => e.title === "short0_done")).toMatchObject({
      posted_at: "2026-10-20 12:31",
      time: "12:31",
    });
    const it = (await (await call(`/app-api/item?key=${encodeURIComponent(done)}`)).json()) as {
      published: { at: string; permalink: string };
    };
    expect(it.published).toMatchObject({ permalink: "https://ig/p/" });
    const q = (await (await call("/app-api/queue?days=120&from=2026-10-21")).json()) as { items: { key: string }[] };
    expect(q.items.map((i) => i.key)).toEqual(["reel:20260823_LISBON/short2_tomorrow"]);
  });
});

describe("a draft becomes a scheduled item (texts in D1)", () => {
  it("schedules, approves with the passkey, publishes from the draft's media; editing a text needs a new approval", async () => {
    await signUp();
    await planItem({ folder: "vlogs/CONTENT/20260823_LISBON", name: "short1_x" }); // the project is known: its folder is reused
    const vid = w.drivePut("UPLOADS/inbox/20260823_LISBON/short9_new.mp4", { md5: MD5, mimeType: "video/mp4" });
    await env.DB.prepare(
      "INSERT INTO drafts (id, kind, account, payload, source, created_by) VALUES ('d_1', 'reel', 'demo_travel', ?1, 'drive', 'drive-inbox')",
    )
      .bind(
        JSON.stringify({
          title: "20260823_LISBON/short9_new",
          folder: "20260823_LISBON",
          name: "short9_new",
          caption: "Draft caption",
          media: [{ store: "drive", id: vid }],
        }),
      )
      .run();

    expect((await post("/app-api/drafts/d_1/schedule", { date: "2026-10-20", time: "18:00" })).status).toBe(400); // no caption
    const busy = await post("/app-api/drafts/d_1/schedule", {
      account: "demo_travel",
      date: "2026-10-20",
      time: "18:00",
      caption: "x",
    });
    expect(busy.status).toBe(409); // short1_x has 18:00 that day
    expect(((await busy.json()) as { error: string }).error).toMatch(/one item per account per hour/);
    const s = await post("/app-api/drafts/d_1/schedule", {
      account: "demo_travel",
      date: "2026-10-20",
      time: "19:30",
      caption: "Lisbon turbines\n\nBeen there?",
      comment: "",
    });
    const { key } = (await s.json()) as { key: string };
    expect(key).toBe("reel:20260823_LISBON/short9_new");
    expect(await env.DB.prepare("SELECT status FROM drafts WHERE id = 'd_1'").first("status")).toBe("approved");
    expect(
      await env.DB.prepare("SELECT folder, content FROM plan_items WHERE item_key = ?1").bind(key).first(),
    ).toEqual({ folder: "vlogs/CONTENT/20260823_LISBON", content: "db" });
    expect((await post("/app-api/drafts/d_1/schedule", { date: "2026-10-20", caption: "x" })).status).toBe(404); // only once

    const item = (await (await call(`/app-api/item?key=${encodeURIComponent(key)}`)).json()) as {
      content: string;
      caption: string;
      comment: string;
      media: { id: string }[];
      problems: string[];
    };
    expect(item).toMatchObject({
      content: "db",
      caption: "Lisbon turbines\n\nBeen there?",
      comment: "Been there?",
      problems: [],
    });
    expect(item.media.map((m) => m.id)).toEqual([vid]);
    const o = (await (await post("/app-api/approve/options", { key })).json()) as { challengeId: string };
    expect(
      await (await post("/app-api/approve/verify", { challengeId: o.challengeId, response: { id: "cred1" } })).json(),
    ).toMatchObject({ approved: true });

    // Edited after approval: the approval no longer matches (the scheduler would refuse it) until approved again.
    expect((await post("/app-api/item/texts", { key, caption: "Lisbon turbines!" })).status).toBe(200);
    const again = (await (await call(`/app-api/item?key=${encodeURIComponent(key)}`)).json()) as {
      approved: { matches: boolean };
    };
    expect(again.approved.matches).toBe(false);
    // A repo item's texts are edited the same way now (the scheduler's copy; the repo files aren't touched).
    const { key: repoKey } = await seedReel(w, { base: "short9_repo", date: "2026-10-22" });
    expect((await post("/app-api/item/texts", { key: repoKey, caption: "Fixed on the phone" })).status).toBe(200);
    const repo = (await (await call(`/app-api/item?key=${encodeURIComponent(repoKey)}`)).json()) as {
      caption: string;
      texts: { by: string; files: { caption: string } };
    };
    expect(repo).toMatchObject({
      caption: "Fixed on the phone",
      texts: {
        by: "owner@app",
        files: { caption: "channels/vlogs/CONTENT/20260823_LISBON/shorts/instagram/short9_repo.txt" },
      },
    });
    const o2 = (await (await post("/app-api/approve/options", { key })).json()) as { challengeId: string };
    await post("/app-api/approve/verify", { challengeId: o2.challengeId, response: { id: "cred1" } });

    igHappyPath(w);
    for (const m of [31, 36, 41, 46]) await tick(e, { fetch: w.fetch, now: new Date(Date.UTC(2026, 9, 20, 10, m)) });
    const created = w.calls.find((c) => c.slug === "INSTAGRAM_POST_IG_USER_MEDIA")!;
    expect(created.args).toMatchObject({ caption: "Lisbon turbines!", media_type: "REELS" });
    expect(String(created.args.video_url)).toContain(`/m/drive/${vid}.mp4`);
    expect(await env.DB.prepare("SELECT source FROM posted WHERE item_key = ?1").bind(key).first("source")).toBe(
      "scheduler",
    );
  });
});

describe("uploads from the app", () => {
  it("opens resumable sessions in the workspace's _uploads folder in Drive, then makes a draft of the uploaded files", async () => {
    await signUp();
    await env.DB.prepare("DELETE FROM media_store").run();
    expect((await post("/app-api/uploads/start", { name: "a.mp4", mimeType: "video/mp4", size: 10 })).status).toBe(503); // no store
    expect(await (await call("/app-api/uploads/enabled")).json()).toEqual({ enabled: false, stores: [] });
    await seedMediaStore();
    expect(await (await call("/app-api/uploads/enabled")).json()).toEqual({ enabled: true, stores: ["drive"] });
    expect((await post("/app-api/uploads/start", { name: "a.txt", mimeType: "text/plain", size: 10 })).status).toBe(
      400,
    );
    const s = (await (
      await post("/app-api/uploads/start", { name: "short3_x.mp4", mimeType: "video/mp4", size: 1234 })
    ).json()) as { uploadUrl: string; chunked: boolean; store: string };
    expect(s.uploadUrl).toMatch(/^https:\/\/www\.googleapis\.com\/upload\/drive\/v3\/files\?upload_id=/);
    expect(s).toMatchObject({ chunked: true, store: "drive", id: null });
    await post("/app-api/uploads/start", { name: "b.jpg", mimeType: "image/jpeg", size: 99 });
    const folder = w.uploads[0].parents[0];
    expect(w.drive.get(folder)!.name).toBe("_uploads"); // UPLOADS/_uploads: the default workspace's folder
    expect(w.uploads.map((u) => u.parents[0])).toEqual([folder, folder]); // created once
    expect(w.uploads[0]).toMatchObject({ origin: "https://bongsu.test", type: "video/mp4" });
    expect(w.shares).toEqual([]); // the owner's own grant reads it: nothing to share

    // The browser sent the bytes to Google: the file is in the folder.
    const vid = w.drivePut("UPLOADS/_uploads/short3_x.mp4", { md5: MD5, mimeType: "video/mp4" });
    const outside = w.drivePut("UPLOADS/other.mp4", { md5: MD5, mimeType: "video/mp4" });
    await planItem({ folder: "demo_running/CONTENT/20260201_RUN", name: "short1_x", account: "demo_running" });
    expect((await post("/app-api/drafts/new", { files: [outside], project: "20260201_RUN", name: "x" })).status).toBe(
      400,
    );
    const d = (await (
      await post("/app-api/drafts/new", {
        files: [vid],
        project: "20260201_RUN",
        name: "short3_x",
        caption: "Field test",
      })
    ).json()) as { id: string };
    const row = await env.DB.prepare("SELECT kind, account, source, payload FROM drafts WHERE id = ?1")
      .bind(d.id)
      .first<{ kind: string; account: string; source: string; payload: string }>();
    expect(row).toMatchObject({ kind: "reel", account: "demo_running", source: "pwa" });
    expect(JSON.parse(row!.payload)).toMatchObject({
      folder: "20260201_RUN",
      name: "short3_x",
      caption: "Field test",
      media: [{ store: "drive", id: vid }],
    });
    // …and it schedules like any draft
    expect((await post(`/app-api/drafts/${d.id}/schedule`, { date: "2026-10-25", caption: "Field test" })).status).toBe(
      200,
    );
  });
});

describe("changing the release date from the item page", () => {
  it("moves an item (approval then needs renewing), refuses a taken hour and published items", async () => {
    await signUp();
    const { key } = await seedReel(w, { base: "short1_move", date: "2026-10-20" }); // approved for 18:00
    await planItem({
      folder: "vlogs/CONTENT/20260823_LISBON",
      name: "short2_other",
      date: "2026-10-24",
      time: "18:00",
    });
    const taken = await post("/app-api/item/reschedule", { key, date: "2026-10-24", time: "18:20" });
    expect(taken.status).toBe(409);
    const r = (await (await post("/app-api/item/reschedule", { key, date: "2026-10-24", time: "20:00" })).json()) as {
      due: string;
      approved: boolean;
      note?: string;
    };
    expect(r).toMatchObject({
      due: "2026-10-24 20:00 Asia/Seoul",
      approved: false,
      note: expect.stringMatching(/approve again/),
    });
    expect((await post("/app-api/item/reschedule", { key })).status).toBe(400); // no date
    await env.DB.prepare(
      "INSERT INTO posted (item_key, account, published_at, source) VALUES (?1, 'demo_travel', unixepoch('2026-10-20 09:00'), 'scheduler')",
    )
      .bind(key)
      .run();
    expect((await post("/app-api/item/reschedule", { key, date: "2026-10-25", time: "18:00" })).status).toBe(409);
  });
});

describe("an item's display name", () => {
  it("is set and cleared from the item page; the queue and calendar show it, the key and approval don't change", async () => {
    await signUp();
    const { key } = await seedReel(w, { base: "short1_name", date: "2026-10-20" });
    expect(await (await post("/app-api/item/title", { key, title: "  Turbines   at sunset " })).json()).toEqual({
      key,
      title: "Turbines at sunset",
    });
    const q = (await (await call("/app-api/queue?days=120")).json()) as {
      items: { key: string; title: string; approved: boolean }[];
    };
    expect(q.items.find((i) => i.key === key)).toMatchObject({ title: "Turbines at sunset", approved: true });
    const day = (await (await call("/app-api/day?date=2026-10-20")).json()) as {
      events: { key?: string; title: string }[];
    };
    expect(day.events.find((e) => e.key === key)?.title).toBe("Turbines at sunset");
    expect(await (await post("/app-api/item/title", { key, title: "" })).json()).toEqual({ key, title: null });
    expect((await post("/app-api/item/title", { key: "reel:X/nope", title: "x" })).status).toBe(404);
  });
});

describe("approving just the comments", () => {
  it("says when only the comments changed, and one approval makes it match again", async () => {
    await signUp();
    const { key, folder, base } = await seedReel(w, { base: "short1_cmt", date: "2026-10-30", approve: false });
    const id = w.drivePut(`UPLOADS/${folder}/exports/shorts/instagram/${base}.mp4`, {
      md5: MD5,
      mimeType: "video/mp4",
    });
    await approve(key, {
      due: "2026-10-30 18:00",
      caption: "A caption\n\nWhere next?\n\n#travel",
      comment: "📍 Somewhere. Have you been?",
      media: [{ driveId: id, md5: MD5 }],
    });
    await copyText(`channels/${folder}/shorts/instagram/${base}.comment2.txt`, "🎵 Music: Autumn Sky\n"); // added after approval
    const before = (await (await call(`/app-api/item?key=${encodeURIComponent(key)}`)).json()) as {
      comment2: string;
      approved: { matches: boolean; commentsOnly: boolean };
    };
    expect(before).toMatchObject({
      comment2: "🎵 Music: Autumn Sky",
      approved: { matches: false, commentsOnly: true },
    });
    const o = (await (await post("/app-api/approve/options", { key })).json()) as { challengeId: string };
    expect(
      await (await post("/app-api/approve/verify", { challengeId: o.challengeId, response: { id: "cred1" } })).json(),
    ).toMatchObject({ approved: true });
    const after = (await (await call(`/app-api/item?key=${encodeURIComponent(key)}`)).json()) as {
      approved: { matches: boolean; commentsOnly: boolean };
    };
    expect(after.approved).toMatchObject({ matches: true, commentsOnly: false });
    // a caption change is not "comments only"
    await copyText(`channels/${folder}/shorts/instagram/${base}.txt`, "Another caption\n");
    const changed = (await (await call(`/app-api/item?key=${encodeURIComponent(key)}`)).json()) as {
      approved: { matches: boolean; commentsOnly: boolean };
    };
    expect(changed.approved).toMatchObject({ matches: false, commentsOnly: false });
  });
});

describe("me.accounts", () => {
  const active = async () =>
    (
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM accounts WHERE workspace_id = 'default' AND status = 'active'",
      ).first<{
        n: number;
      }>()
    )?.n ?? 0;
  it("counts the workspace's active accounts, so the app can show the setup note when there are none", async () => {
    await signUp();
    const n = await active();
    expect(n).toBeGreaterThan(0);
    expect(await (await call("/app-api/me")).json()).toMatchObject({ accounts: n });
    // another workspace's accounts don't count
    await env.DB.prepare(
      "INSERT INTO workspaces (id, name, created_at) VALUES ('b', 'B', 0) ON CONFLICT (id) DO NOTHING",
    ).run();
    await env.DB.prepare(
      "INSERT INTO accounts (id, workspace_id, platform, handle, capabilities, settings, status, sort, created_at, updated_at) VALUES ('demo_other', 'b', 'instagram', 'demo_other', '{}', '{}', 'active', 0, 0, 0)",
    ).run();
    expect(await (await call("/app-api/me")).json()).toMatchObject({ accounts: n });
    // disabled ones don't either: all disabled means the setup note
    await env.DB.prepare("UPDATE accounts SET status = 'disabled' WHERE workspace_id = 'default'").run();
    expect(await (await call("/app-api/me")).json()).toMatchObject({ accounts: 0 });
    await env.DB.prepare("UPDATE accounts SET status = 'active' WHERE workspace_id = 'default'").run();
    await env.DB.prepare("DELETE FROM accounts WHERE id = 'demo_other'").run();
  });

  it("answers the workspace's locale for the app's text: en, and en when signed out", async () => {
    expect(await (await call("/app-api/me")).json()).toMatchObject({ signedIn: false, locale: "en" });
    await signUp();
    expect(await (await call("/app-api/me")).json()).toMatchObject({ signedIn: true, locale: "en" });
    await env.DB.prepare(
      "INSERT INTO workspace_settings (workspace_id, timezone, digest_hour, locale, updated_at) VALUES ('default', 'UTC', 8, 'xx', 0) ON CONFLICT (workspace_id) DO UPDATE SET locale = excluded.locale",
    ).run();
    expect(await (await call("/app-api/me")).json()).toMatchObject({ locale: "xx" });
    await env.DB.prepare("UPDATE workspace_settings SET locale = 'en' WHERE workspace_id = 'default'").run();
  });
});

describe("me.scopes", () => {
  it("answers the caller's scopes, so the app shows only what the role can do: none signed out, the role's after", async () => {
    expect(await (await call("/app-api/me")).json()).toMatchObject({ signedIn: false, scopes: [] });
    await signUp();
    const owner = (await (await call("/app-api/me")).json()) as { scopes: string[] };
    expect(owner.scopes).toEqual(expect.arrayContaining(["read", "approve", "resume", "reschedule"]));
    const user = await env.DB.prepare("SELECT user_id FROM passkeys LIMIT 1").first<{ user_id: string }>();
    // an editor's: no approve, pause or resume (not an instance admin meanwhile, whose rights are an admin's)
    await env.DB.prepare("UPDATE users SET instance_admin = 0 WHERE id = ?1").bind(user?.user_id).run();
    await env.DB.prepare("UPDATE memberships SET role = 'editor' WHERE user_id = ?1").bind(user?.user_id).run();
    try {
      expect(((await (await call("/app-api/me")).json()) as { scopes: string[] }).scopes).toEqual([
        "read",
        "draft",
        "plan",
        "reschedule",
        "metrics",
      ]);
    } finally {
      await env.DB.prepare("UPDATE memberships SET role = 'admin' WHERE user_id = ?1").bind(user?.user_id).run();
      await env.DB.prepare("UPDATE users SET instance_admin = 1 WHERE id = ?1").bind(user?.user_id).run();
    }
  });
});

describe("caption rules per account", () => {
  it("approving an 8-tag caption fails at the default cap and passes once the account allows 10", async () => {
    await signUp();
    const { folder, base } = await seedReel(w, {
      approve: false,
      caption: "A real opening line about Lisbon.\n\n#a #b #c #d #e #f #g #h",
    });
    w.drivePut(`UPLOADS/${folder}/exports/shorts/instagram/${base}.mp4`, { md5: MD5, mimeType: "video/mp4" });
    const key = `reel:20260823_LISBON/${base}`;
    const blocked = await post("/app-api/approve/options", { key });
    expect(blocked.status).toBe(409);
    expect(((await blocked.json()) as { problems: string[] }).problems.join("\n")).toContain("caption hashtags");
    await setAccountSettings(env.DB, "demo_travel", { captionRules: { hashtagMax: 10 } }, 0);
    expect((await post("/app-api/approve/options", { key })).status).toBe(200);
    await setAccountSettings(env.DB, "demo_travel", { captionRules: {} }, 0);
    expect((await post("/app-api/approve/options", { key })).status).toBe(409); // Review Focus 1: {} keeps the default
  });
});
