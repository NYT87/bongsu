// A third network that plugs in without touching the core (Phase 4, docs/PLAN.md 2.10, docs/platforms.md): a
// platform with text and image posts, and a provider that posts in one call. The real API, approval page and tick
// handle it like Instagram.
import { env } from "cloudflare:workers";
import { listAccountsOp, planAdd, planUpdate } from "@bongsu/api/agent/ops";
import { resolveItem } from "@bongsu/api/pwa/approve";
import { upsertAccount, upsertConnection } from "@bongsu/core/accounts";
import type { Env } from "@bongsu/core/env";
import { registerPlatform } from "@bongsu/core/platforms/index";
import { NO_FEATURES, NO_LINT } from "@bongsu/core/platforms/types";
import { registerProvider } from "@bongsu/core/providers/index";
import type { OutgoingPost, Provider } from "@bongsu/core/providers/types";
import { tick } from "@bongsu/core/tick";
import { beforeEach, describe, expect, it } from "vitest";
import { approve, clearPlan, postedRows, testEnv, World } from "./world";

const AT = new Date("2026-10-20T10:01:00Z"); // 19:01 in Seoul
const sent: { op: string; args: unknown }[] = [];

registerPlatform({
  id: "fakenet",
  name: "FakeNet",
  formats: ["text", "image"],
  labels: { text: { name: "Note", plural: "Notes" }, post: { name: "Note", plural: "Notes" } },
  accountNoun: "profile",
  limits: { mediaMax: 4, videoSecondsMax: 0, captionMax: 280 },
  features: { ...NO_FEATURES, firstComment: true },
  options: [{ key: "audience", type: "string", label: "Who sees it", maxLength: 20 }],
  lint: (c) =>
    c.length > 280 ? [{ check: "LENGTH", status: "FAIL", detail: `${c.length} characters (280 max)` }] : [],
  lintDefaults: NO_LINT,
});

class FakeNetProvider implements Provider {
  readonly id = "fakenet-api";
  readonly platform = "fakenet";
  async start(post: OutgoingPost) {
    sent.push({ op: "post", args: post });
    return { state: "ready" as const, data: { id: `fn-${sent.length}` } }; // posted at once: nothing to wait for
  }
  async check(step: { state: "processing" | "ready" | "failed"; data: Record<string, unknown> }) {
    return step;
  }
  async finish(step: { data: Record<string, unknown> }) {
    return { mediaId: String(step.data.id), permalink: `https://fakenet.example/p/${step.data.id}`, publishedAt: null };
  }
  async comment(mediaId: string, text: string) {
    sent.push({ op: "comment", args: { mediaId, text } });
    return `c-${mediaId}`;
  }
  async verify() {
    return { id: "fn-user", username: "fake_writer", followers: 3 };
  }
}
registerProvider("fakenet", {
  factory: async () => new FakeNetProvider(),
  connect: { kind: "token", label: "FakeNet", platform: "fakenet", docs: "docs/platforms.md" },
});

const ctx = (e: Env) => ({
  env: e,
  fetch: new World().fetch,
  now: new Date("2026-10-19T00:00:00Z"),
  caller: { id: "k", name: "test", scopes: ["read", "plan"] as const, workspaceId: "default" },
});

beforeEach(async () => {
  sent.length = 0;
  await clearPlan();
  await env.DB.batch(["DELETE FROM jobs", "DELETE FROM locks"].map((s) => env.DB.prepare(s)));
});

describe("a third network", () => {
  it("is listed, planned, approved and published through the same code as Instagram", async () => {
    const e = await testEnv(env);
    await upsertConnection(
      env.DB,
      { workspaceId: "default", id: "c_fake", provider: "fakenet", kind: "oauth", secretName: "UNUSED" },
      0,
    );
    await upsertAccount(
      env.DB,
      {
        workspaceId: "default",
        id: "fake_writer",
        platform: "fakenet",
        handle: "fake_writer",
        externalId: "fn-user",
        connectionId: "c_fake",
      },
      0,
    );
    const c = { ...ctx(e), caller: { ...ctx(e).caller, scopes: ["read", "plan"] as ("read" | "plan")[] } };
    expect((await listAccountsOp(c)).accounts.find((a) => a.id === "fake_writer")).toMatchObject({
      platform: "fakenet",
      connected: true,
    });

    // planning: its own formats and options are checked; Instagram's aren't accepted
    await expect(
      planAdd(c, { account: "fake_writer", folder: "notes/CONTENT/20261020_HELLO", name: "hello", format: "video" }),
    ).rejects.toThrow(/format must be one of text, image on FakeNet/);
    await expect(
      planAdd(c, {
        account: "fake_writer",
        folder: "notes/CONTENT/20261020_HELLO",
        name: "hello",
        format: "text",
        options: { trial: true },
      }),
    ).rejects.toThrow(/FakeNet has no option trial/);
    const { key } = await planAdd(c, {
      account: "fake_writer",
      folder: "notes/CONTENT/20261020_HELLO",
      name: "hello",
      format: "text",
      options: { audience: "everyone" },
      date: "2026-10-20",
      caption: "Hello from a network Bongsu didn't know yesterday.",
      comment: "And a first comment.",
    });

    // the approval page: no media for a text post, the platform's own caption rules
    const r = (await resolveItem(e, new World().fetch, key, "Asia/Seoul", "default"))!;
    expect(r.problems).toEqual([]);
    expect(r.postFormat).toBe("text");

    await approve(key, {
      due: "2026-10-20 19:00",
      caption: "Hello from a network Bongsu didn't know yesterday.",
      comment: "And a first comment.",
      media: [],
    });
    await tick(e, { fetch: new World().fetch, now: AT }); // queued and posted in one call
    await tick(e, { fetch: new World().fetch, now: new Date(AT.getTime() + 5 * 60_000) }); // first comment, recorded

    expect(sent[0]).toMatchObject({
      op: "post",
      args: {
        format: "text",
        caption: "Hello from a network Bongsu didn't know yesterday.",
        media: [],
        options: { audience: "everyone" },
      },
    });
    expect(sent[1]).toEqual({ op: "comment", args: { mediaId: "fn-1", text: "And a first comment." } });
    const job = await env.DB.prepare("SELECT kind, state, permalink FROM jobs WHERE item_key = ?1").bind(key).first();
    expect(job).toEqual({ kind: "text", state: "done", permalink: "https://fakenet.example/p/fn-1" });
    expect(await postedRows()).toMatchObject([{ item_key: key, account: "fake_writer", media_id: "fn-1" }]);
  });

  it("its caption rules block approval when they fail", async () => {
    const e = await testEnv(env);
    await upsertConnection(
      env.DB,
      { workspaceId: "default", id: "c_fake", provider: "fakenet", kind: "oauth", secretName: "UNUSED" },
      0,
    );
    await upsertAccount(
      env.DB,
      {
        workspaceId: "default",
        id: "fake_writer",
        platform: "fakenet",
        handle: "fake_writer",
        externalId: "fn-user",
        connectionId: "c_fake",
      },
      0,
    );
    const c = { ...ctx(e), caller: { ...ctx(e).caller, scopes: ["read", "plan"] as ("read" | "plan")[] } };
    const { key } = await planAdd(c, {
      account: "fake_writer",
      folder: "notes/CONTENT/20261020_HELLO",
      name: "long",
      format: "text",
      date: "2026-10-20",
    });
    // writes refuse a caption over the platform's captionMax, so plant one (an older row) to check approval's rules
    await expect(planUpdate(c, { key, caption: "x".repeat(300) })).rejects.toThrow(/at most 280/);
    await env.DB.prepare("UPDATE plan_items SET caption = ?1 WHERE item_key = ?2").bind("x".repeat(300), key).run();
    const r = (await resolveItem(e, new World().fetch, key, "Asia/Seoul", "default"))!;
    expect(r.problems).toContain("caption length: 300 characters (280 max)");
  });
});
