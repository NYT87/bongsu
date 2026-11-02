// Phase 13: Trial Reels. A Reel whose switch is on (its own, else its account's default; on for demo_running, the
// only account where trials are possible) gets a trial copy right after it.
import { env } from "cloudflare:workers";
import { appRoutes } from "@bongsu/api/pwa/routes";
import type { Verifiers } from "@bongsu/api/pwa/webauthn";
import { pollComments } from "@bongsu/core/comments";
import type { Env } from "@bongsu/core/env";
import { sha256Hex } from "@bongsu/core/formats/approved";
import { postResults } from "@bongsu/core/results";
import { tick } from "@bongsu/core/tick";
import { beforeEach, describe, expect, it } from "vitest";
import { clearPlan, copyText, igHappyPath, postedRows, seedReel, testEnv, World } from "./world";

const AT = new Date("2026-10-20T09:32:00Z"); // 18:32 KST
const later = (min: number) => new Date(AT.getTime() + min * 60_000);
const MELLAMO = "17841400000000002";

interface Job {
  item_key: string;
  state: string;
  last_error: string | null;
  container_id: string | null;
  payload: string;
}
const jobs = async () => (await env.DB.prepare("SELECT * FROM jobs ORDER BY id").all<Job>()).results;

let w: World;
let e: Env;
beforeEach(async () => {
  await env.DB.batch(
    [
      "jobs",
      "audit",
      "locks",
      "trial_posts",
      "account_settings",
      "post_results",
      "comments",
      "comment_polls",
      "passkeys",
      "sessions",
      "challenges",
      "setup_codes",
    ].map((t) => env.DB.prepare(`DELETE FROM ${t}`)),
  );
  await clearPlan();
  w = new World();
  e = await testEnv(env);
  igHappyPath(w);
  let n = 0;
  w.composio.INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH = () => ({ id: `media-${++n}` });
});

/** Ticks five minutes apart, from AT. */
async function run(ticks: number, from = 0) {
  for (let i = 0; i < ticks; i++) await tick(e, { fetch: w.fetch, now: later(from + 5 * i) });
}

describe("Trial Reels", () => {
  it("after a Reel on an account with Trial Reels on by default, its trial copy goes out with trial_params, the same caption and comments", async () => {
    const { key } = await seedReel(w, { account: "demo_running", comment2: "Second" });
    await run(3); // container → publish → comments, done; the trial job is queued
    let js = await jobs();
    expect(js.map((j) => [j.item_key, j.state])).toEqual([
      [key, "done"],
      [`trial:${key}`, "pending"],
    ]);
    expect(w.raw).toEqual([]);

    await run(3, 15); // trial container (raw) → publish → comments, done
    js = await jobs();
    expect(js[1].state).toBe("done");
    expect(w.raw).toHaveLength(1);
    expect(w.raw[0]).toMatchObject({
      user: MELLAMO,
      method: "POST",
      url: `https://graph.instagram.com/v23.0/${MELLAMO}/media`,
      body: {
        media_type: "REELS",
        caption: "A caption\n\nWhere next?\n\n#travel",
        location_id: "111",
        trial_params: { graduation_strategy: "SS_PERFORMANCE" },
      },
    });
    expect(String(w.raw[0].body!.video_url)).toMatch(/^https:\/\/scheduler\.test\//);
    const comments = w.calls.filter((c) => c.slug === "INSTAGRAM_POST_IG_MEDIA_COMMENTS");
    expect(comments.map((c) => c.args.ig_media_id)).toEqual(["media-1", "media-1", "media-2", "media-2"]);
    expect(
      await env.DB.prepare("SELECT item_key, account, media_id FROM trial_posts")
        .all()
        .then((r) => r.results),
    ).toEqual([{ item_key: key, account: "demo_running", media_id: "media-2" }]);
    expect(await postedRows()).toHaveLength(1); // the regular Reel only: the mirror and the Drive cleanup never see the copy
    expect(w.notifications.at(-1)!.title).toBe(`published Trial Reel ${key}`);
  });

  it("an account where trials aren't possible gets no trial copy", async () => {
    await seedReel(w); // demo_travel
    await run(5);
    expect((await jobs()).map((j) => j.item_key)).toEqual(["reel:20260823_LISBON/short1_x"]);
    expect(w.raw).toEqual([]);
  });

  it("a refused raw call (Instagram's message) fails the trial copy only, after its retries", async () => {
    const { key } = await seedReel(w, { account: "demo_running" });
    w.workbench = () => ({
      data: {
        result_type: "completed",
        status: 400,
        data: {
          error: {
            message: "Application does not have permission",
            error_user_msg:
              "The instagram account does not meet the trial reel follower requirement to create trial reels.",
          },
        },
      },
    });
    await run(6);
    const js = await jobs();
    expect(js[0].state).toBe("done");
    expect(js[1]).toMatchObject({ item_key: `trial:${key}`, state: "failed" });
    expect(js[1].last_error).toMatch(/follower requirement/);
    expect(await postedRows()).toHaveLength(1);
  });

  it("the trial copy refuses a caption changed since approval, and a wrong default account", async () => {
    const { key } = await seedReel(w, { account: "demo_running" });
    await run(3);
    await copyText("channels/vlogs/CONTENT/20260823_LISBON/shorts/instagram/short1_x.txt", "Edited\n");
    await run(1, 15);
    expect((await jobs())[1]).toMatchObject({
      state: "refused",
      last_error: "trial copy: the caption changed after approval",
    });
    expect(w.raw).toEqual([]);

    await env.DB.prepare("DELETE FROM jobs WHERE item_key = ?1").bind(`trial:${key}`).run();
    await copyText(
      "channels/vlogs/CONTENT/20260823_LISBON/shorts/instagram/short1_x.txt",
      "A caption\n\nWhere next?\n\n#travel\n",
    );
    await env.DB.prepare(
      "INSERT INTO jobs (item_key, kind, account, due_at, state, dry_run, payload, created_at, updated_at) SELECT 'trial:' || item_key, 'reel', account, ?1, 'pending', 0, json_set(json_remove(payload, '$.mediaId', '$.commented', '$.commented2'), '$.trial', json('true')), ?1, ?1 FROM jobs WHERE item_key = ?2",
    )
      .bind(Math.floor(later(20).getTime() / 1000), key)
      .run();
    w.workbench = () => ({ error: "Composio's default Instagram account is not 17841400000000002: {'id': '1'}" });
    await run(1, 20);
    expect((await jobs())[1].last_error).toMatch(/default Instagram account is not/);
  });

  it("24 h results: the copy is compared with its regular Reel and kept out of the account's median", async () => {
    const { key } = await seedReel(w, { account: "demo_running" });
    await run(6);
    w.composio.INSTAGRAM_GET_IG_MEDIA_INSIGHTS = (a) => ({
      data: [{ name: "views", values: [{ value: a.ig_media_id === "media-1" ? 100 : 250 }] }],
    });
    await postResults(e, { fetch: w.fetch, now: later(60 * 25) });
    await postResults(e, { fetch: w.fetch, now: later(60 * 25 + 15) });
    const rows = (await env.DB.prepare("SELECT item_key, median_views FROM post_results ORDER BY item_key").all())
      .results;
    expect(rows).toEqual([
      { item_key: key, median_views: null },
      { item_key: `trial:${key}`, median_views: 100 },
    ]);
    expect(w.notifications.some((n) => n.body.includes("Trial: ") && n.body.includes("(2.5× the regular Reel)"))).toBe(
      true,
    );

    w.composio.INSTAGRAM_GET_IG_MEDIA_COMMENTS = () => ({ data: [] });
    await pollComments(e, { fetch: w.fetch, now: later(60) });
    expect((await env.DB.prepare("SELECT media_id FROM comment_polls ORDER BY media_id").all()).results).toEqual([
      { media_id: "media-1" },
      { media_id: "media-2" },
    ]);
  });

  it("the item page shows the trial copy: planned before, then its link and state", async () => {
    const call = await signedIn();
    const { key } = await seedReel(w, { account: "demo_running" });
    const before = (await (await call(`/app-api/item?key=${encodeURIComponent(key)}`)).json()) as {
      trial: { state: string; on: boolean; explicit: boolean } | null;
    };
    expect(before.trial).toMatchObject({ state: "planned", on: true, explicit: false });
    await run(6);
    const after = (await (await call(`/app-api/item?key=${encodeURIComponent(key)}`)).json()) as {
      trial: { state: string; permalink: string };
    };
    expect(after.trial).toMatchObject({ state: "published", permalink: "https://www.instagram.com/reel/media-2/" });

    const { key: other } = await seedReel(w, { base: "short2_y", date: "2026-10-21" }); // demo_travel
    expect(
      ((await (await call(`/app-api/item?key=${encodeURIComponent(other)}`)).json()) as { trial: unknown }).trial,
    ).toBeNull();
  });

  it("each Reel's switch beats the account's default, both ways", async () => {
    const call = await signedIn();
    const post = (path: string, b: unknown) => call(path, { method: "POST", body: JSON.stringify(b) });
    const { key } = await seedReel(w, { account: "demo_running" });
    const off = (await (await post("/app-api/item/trial", { key, on: false })).json()) as {
      on: boolean;
      explicit: boolean;
      byDefault: boolean;
    };
    expect(off).toMatchObject({ on: false, explicit: true, byDefault: true });
    await run(6);
    expect((await jobs()).map((j) => j.item_key)).toEqual([key]); // no trial copy
    expect((await post("/app-api/item/trial", { key, on: true })).status).toBe(409); // published: too late

    await env.DB.batch(
      ["DELETE FROM jobs", "DELETE FROM posted", "DELETE FROM plan_items"].map((q) => env.DB.prepare(q)),
    );
    // The account's default, off (set in the dashboard's Accounts page)
    await env.DB.prepare(
      `UPDATE accounts SET settings = json_set(settings, '$.trialReels', json('false')) WHERE handle = 'demo_running'`,
    ).run();
    const { key: k2 } = await seedReel(w, {
      account: "demo_running",
      base: "short2_y",
      date: "2026-10-20",
      time: "19:00",
    });
    expect(
      ((await (await call(`/app-api/item?key=${encodeURIComponent(k2)}`)).json()) as { trial: { on: boolean } }).trial
        .on,
    ).toBe(false);
    await post("/app-api/item/trial", { key: k2, on: true });
    await run(6, 30); // 19:02 onwards
    expect((await jobs()).map((j) => [j.item_key, j.state])).toEqual([
      [k2, "done"],
      [`trial:${k2}`, "done"],
    ]);
    const back = (await (await post("/app-api/item/trial", { key: "reel:nope/x", on: null })).json()) as {
      error: string;
    };
    expect(back.error).toMatch(/isn't planned/);
  });

  it("switched off after the Reel went out: the queued trial copy doesn't go", async () => {
    const { key } = await seedReel(w, { account: "demo_running" });
    await run(3);
    await env.DB.prepare(`UPDATE plan_items SET options = '{"trial":false}' WHERE item_key = ?1`).bind(key).run();
    await run(1, 15);
    expect((await jobs())[1]).toMatchObject({ state: "done", last_error: "trial copy switched off" });
    expect(w.raw).toEqual([]);
  });

  it("the account settings left the app: the dashboard's Accounts page has them", async () => {
    const call = await signedIn();
    expect((await call("/app-api/account?account=demo_running")).status).toBe(404);
    expect(
      (
        await call("/app-api/account/trial", {
          method: "POST",
          body: JSON.stringify({ account: "demo_running", on: true }),
        })
      ).status,
    ).toBe(404);
  });
});

async function signedIn() {
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
  const ae = await testEnv(env, { PUBLIC_URL: "https://bongsu.test", RP_ID: "bongsu.test" } as Partial<Env>);
  let cookie = "";
  const call = async (path: string, init: RequestInit = {}) => {
    const r = await appRoutes(w.fetch, fake).request(
      `https://bongsu.test${path}`,
      { ...init, headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) } },
      ae,
    );
    const set = r.headers.get("Set-Cookie");
    if (set) cookie = set.split(";")[0];
    return r;
  };
  await env.DB.prepare("INSERT INTO setup_codes (code_hash, expires_at) VALUES (?1, ?2)")
    .bind(await sha256Hex("CODE-1234"), Math.floor(Date.now() / 1000) + 600)
    .run();
  const o = (await (
    await call("/app-api/setup/options", { method: "POST", body: JSON.stringify({ code: "CODE-1234" }) })
  ).json()) as { challengeId: string };
  await call("/app-api/setup/verify", {
    method: "POST",
    body: JSON.stringify({ challengeId: o.challengeId, response: { id: "cred1" }, name: "t" }),
  });
  return call;
}
