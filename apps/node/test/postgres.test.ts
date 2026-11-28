// Bongsu on Postgres: the database built from migrations/postgres (PGlite: Postgres in WebAssembly, no server), and
// the app's main paths on it: /health, the schedules, the dashboard's sign-up and pages, keys on /v1, the app's API.
import { join } from "node:path";
import { createApp } from "@bongsu/api/app";
import { adminRoutes } from "@bongsu/api/dashboard/routes";
import { appRoutes } from "@bongsu/api/pwa/routes";
import type { Verifiers } from "@bongsu/api/pwa/webauthn";
import { removeMember, setRole } from "@bongsu/core/invites";
import { registerStore } from "@bongsu/core/media/index";
import { sampleMetrics } from "@bongsu/core/metrics";
import { deleteAccount } from "@bongsu/core/people";
import { pgliteDriver } from "@bongsu/core/pglite";
import { PostgresDb } from "@bongsu/core/postgres";
import { runSchedule } from "@bongsu/core/schedules";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { nodeEnv } from "../src/env";
import { LocalStore } from "../src/local-store";
import { migratePostgres } from "../src/migrate";

registerStore("local", (e) => new LocalStore(e.MEDIA_DIR as string));

const offline: typeof fetch = async (input) => {
  throw new Error(`no network in this test: ${String(input)}`);
};
const fake: Verifiers = {
  registration: (async (o: { response: { id: string } }) => ({
    verified: true,
    registrationInfo: { credential: { id: o.response.id, publicKey: new Uint8Array([1]), counter: 0, transports: [] } },
  })) as unknown as Verifiers["registration"],
  authentication: (async () => ({
    verified: true,
    authenticationInfo: { newCounter: 1 },
  })) as unknown as Verifiers["authentication"],
};

const driver = pgliteDriver(new PGlite());
const db = new PostgresDb(driver);
const env = nodeEnv(
  {
    PUBLIC_URL: "https://bongsu.test",
    RP_ID: "bongsu.test",
    SETUP_TOKEN: "setup-token-123",
    MEDIA_DIR: "/tmp/bongsu-pg-media",
    MEDIA_SIGNING_KEY: "k",
    ENCRYPTION_KEY: "a-long-random-encryption-key-for-tests",
  },
  db,
);
const jar: Record<string, string> = {};
async function call(path: string, body?: unknown, routes: "admin" | "app" = "admin") {
  const r = await (routes === "admin" ? adminRoutes(offline, fake) : appRoutes(offline, fake)).request(
    `https://bongsu.test${path}`,
    {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: Object.entries(jar)
          .map(([k, v]) => `${k}=${v}`)
          .join("; "),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    env,
  );
  const set = r.headers.get("Set-Cookie");
  if (set) {
    const [k, v] = set.split(";")[0].split("=");
    jar[k] = v;
  }
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
}

beforeAll(async () => {
  const applied = await migratePostgres(driver, join(__dirname, "../../../migrations/postgres"));
  expect(applied).toContain("0009_baseline.sql");
  expect(await migratePostgres(driver, join(__dirname, "../../../migrations/postgres"))).toEqual([]);
  // 0021: notification settings per person and workspace; a device now belongs to its person alone
  const cols = async (table: string) =>
    (
      (await db
        .prepare(
          `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = '${table}'`,
        )
        .all()) as {
        results: { column_name: string }[];
      }
    ).results.map((r) => r.column_name);
  expect(await cols("notify_prefs")).toContain("grp");
  expect(await cols("push_subs")).not.toContain("workspace_id");
  // a fresh instance has no workspace or user (0018 drops the baseline's empty seed): the tests' own, as on SQLite
  expect(await db.prepare("SELECT COUNT(*) AS n FROM users").first()).toEqual({ n: 0 });
  await db.batch([
    db.prepare("INSERT INTO workspaces (id, name, created_at) VALUES ('default', 'Default', 0) ON CONFLICT DO NOTHING"),
    db.prepare(
      "INSERT INTO workspace_settings (workspace_id, timezone, digest_hour, locale, media_folder, updated_at) VALUES ('default', 'Asia/Seoul', 8, 'en', 'UPLOADS', 0) ON CONFLICT DO NOTHING",
    ),
    db.prepare(
      "INSERT INTO users (id, email, name, created_at, instance_admin) VALUES ('owner', NULL, 'Owner', 0, 1) ON CONFLICT DO NOTHING",
    ),
    db.prepare(
      "INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES ('default', 'owner', 'admin', 0) ON CONFLICT DO NOTHING",
    ),
  ]);
  await db
    .prepare(
      "INSERT INTO media_store (id, kind, is_default, settings, status, updated_at) VALUES ('local', 'local', 1, '{}', 'ok', 0)",
    )
    .run(); // the server's disk, as the dashboard's Media page sets it up
});

describe("Bongsu on Postgres (PGlite)", () => {
  it("answers /health", async () => {
    const r = await createApp(offline).request("/health", {}, env);
    expect(await r.json()).toMatchObject({ ok: true, missing_secrets: [] });
  });

  it("keeps a workspace's last admin when two admins remove each other at once (#171)", async () => {
    await db.batch([
      db.prepare("INSERT INTO workspaces (id, name, created_at) VALUES ('race', 'Race', 0)"),
      ...["ann", "ben"].flatMap((u) => [
        db.prepare("INSERT INTO users (id, name, created_at) VALUES (?1, ?1, 0)").bind(u),
        db
          .prepare("INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES ('race', ?1, 'admin', 0)")
          .bind(u),
      ]),
    ]);
    const by = { instanceAdmin: false };
    const r = await Promise.allSettled([
      removeMember(db, "race", "ann", by, 0),
      removeMember(db, "race", "ben", by, 0),
    ]);
    expect(r.map((x) => x.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM memberships WHERE workspace_id = 'race'").first()).toEqual({
      n: 1,
    });
    // and the last one can't be demoted either
    const [left] = (
      await db.prepare("SELECT user_id FROM memberships WHERE workspace_id = 'race'").all<{ user_id: string }>()
    ).results;
    await expect(setRole(db, "race", left.user_id, "editor", by, 0)).rejects.toThrow(/keeps one admin/);
  });

  it("deletes an account in no workspace, and refuses one still in a workspace (#143)", async () => {
    await db.batch([
      db.prepare("INSERT INTO users (id, email, name, created_at) VALUES ('gone', 'gone@example.com', 'Gone', 0)"),
      db.prepare(
        "INSERT INTO passkeys (id, public_key, counter, name, created_at, user_id) VALUES ('gone-key', 'AQID', 0, 'phone', 0, 'gone')",
      ),
      // no email: the instance stays un-bootstrapped for the sign-up test below
      db.prepare("INSERT INTO users (id, email, name, created_at) VALUES ('kept', NULL, 'Kept', 0)"),
      db.prepare(
        "INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES ('default', 'kept', 'editor', 0)",
      ),
    ]);
    await deleteAccount(db, "gone", 1000);
    expect(await db.prepare("SELECT email, name, deleted_at FROM users WHERE id = 'gone'").first()).toEqual({
      email: null,
      name: null,
      deleted_at: 1000,
    });
    expect(await db.prepare("SELECT COUNT(*) AS n FROM passkeys WHERE user_id = 'gone'").first()).toEqual({ n: 0 });
    await expect(deleteAccount(db, "kept", 1000)).rejects.toThrow(/leave your workspaces first/);
    expect(await db.prepare("SELECT deleted_at FROM users WHERE id = 'kept'").first()).toEqual({ deleted_at: null });
  });

  it("runs the three schedules", async () => {
    const at = new Date("2026-10-20T09:30:00Z");
    for (const name of ["instagram", "shorts", "upkeep"] as const) await runSchedule(env, offline, name, at, 300);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM locks").first())?.n).toBe(0);
  });

  it("stamps a post whose sampling fails, and the next run goes on past it (#160)", async () => {
    // an Instagram account with no connection: its post has no insights, so the sampler stamps it as failed
    const at = new Date("2026-10-20T09:30:00Z");
    const now = Math.floor(at.getTime() / 1000);
    await db.batch([
      db.prepare(
        "INSERT INTO accounts (id, workspace_id, platform, handle, capabilities, settings, created_at, updated_at) VALUES ('demo_travel', 'default', 'instagram', 'demo_travel', '{}', '{}', 0, 0)",
      ),
      db
        .prepare(
          "INSERT INTO posted (item_key, account, media_id, source, published_at) VALUES ('reel:lisbon', 'demo_travel', 'm1', 'scheduler', ?1)",
        )
        .bind(now - 86400),
    ]);
    expect(await sampleMetrics(env, { fetch: offline, now: at })).toEqual({ sampled: [] });
    expect(
      await db.prepare("SELECT value, updated_at FROM settings WHERE key = 'metrics_failed:reel:lisbon'").first(),
    ).toEqual({
      value: String(now),
      updated_at: now,
    });
    // stamped, it waits its interval instead of stopping the next run
    expect(await sampleMetrics(env, { fetch: offline, now: new Date(at.getTime() + 60_000) })).toEqual({ sampled: [] });
    await db.batch([
      db.prepare("DELETE FROM posted WHERE item_key = 'reel:lisbon'"),
      db.prepare("DELETE FROM settings WHERE key = 'metrics_failed:reel:lisbon'"),
      db.prepare("DELETE FROM accounts WHERE id = 'demo_travel'"),
    ]);
  });

  it("signs up in the dashboard and uses its pages, keys and tokens", async () => {
    const o = await call("/admin-api/bootstrap/options", {
      token: "setup-token-123",
      email: "owner@example.com",
      name: "Owner",
    });
    expect(o.status).toBe(200);
    const v = await call("/admin-api/bootstrap/verify", {
      challengeId: o.json.challengeId,
      response: { id: "laptop" },
    });
    expect(v.status).toBe(200);
    expect((await call("/admin-api/state")).json).toMatchObject({
      signedIn: true,
      bootstrapNeeded: false,
      instanceAdmin: true,
      noWorkspace: true,
    });
    // the first run: the instance admin creates the first workspace, and works in it
    const made = await call("/admin-api/workspaces", { name: "Demo Travel", timezone: "Asia/Seoul", admin: "me" });
    expect(made.status).toBe(200);
    expect((await call("/admin-api/state")).json).toMatchObject({ noWorkspace: false, role: "admin" });
    const overview = await call("/admin-api/overview");
    expect(overview.json).toMatchObject({ accounts: 0, keys: 0, passkeys: 1 });
    await call("/admin-api/settings", { timezone: "Asia/Seoul", digestHour: 7 });
    expect((await call("/admin-api/settings")).json).toMatchObject({ timezone: "Asia/Seoul", digestHour: 7 });
    const key = await call("/admin-api/keys", { name: "agent", scopes: ["read", "plan"] });
    expect(key.status).toBe(200);
    const status = await createApp(offline).request(
      "/v1/status",
      { headers: { Authorization: `Bearer ${key.json.key}` } },
      env,
    );
    expect(status.status).toBe(200);
    expect((await call("/admin-api/tokens", { name: "laptop", days: 30 })).status).toBe(200);
    expect(((await call("/admin-api/tokens")).json.tokens as unknown[]).length).toBe(1);
    expect((await call("/admin-api/accounts")).status).toBe(200);
    expect((await call("/admin-api/connections")).status).toBe(200);
    expect((await call("/admin-api/passkeys")).status).toBe(200);
    // a workspace's audit holds only its own rows; the setup's rows are the instance's, for an instance admin
    const audit = (await call("/admin-api/audit")).json.entries as { action: string }[];
    const actions = audit.map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["settings", "key_create", "token_create"]));
    expect(actions).not.toContain("bootstrap");
    const instance = (await call("/admin-api/audit?instance=1")).json.entries as { action: string }[];
    expect(instance.map((a) => a.action)).toContain("bootstrap");
  });

  it("the app's API on a session", async () => {
    // the app's sign-in uses a device code the dashboard makes
    const code = await call("/admin-api/devices", {});
    expect(code.status).toBe(200);
    const o = await call("/app-api/setup/options", { code: code.json.code }, "app");
    expect(o.status).toBe(200);
    expect(
      (await call("/app-api/setup/verify", { challengeId: o.json.challengeId, response: { id: "phone" } }, "app"))
        .status,
    ).toBe(200);
    for (const p of ["/app-api/me", "/app-api/status", "/app-api/queue", "/app-api/drafts", "/app-api/comments"])
      expect([p, (await call(p, undefined, "app")).status]).toEqual([p, 200]);
  });
});
