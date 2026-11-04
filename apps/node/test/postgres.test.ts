// Bongsu on Postgres: the database built from migrations/postgres (PGlite: Postgres in WebAssembly, no server), and
// the app's main paths on it: /health, the schedules, the dashboard's sign-up and pages, keys on /v1, the app's API.
import { join } from "node:path";
import { createApp } from "@bongsu/api/app";
import { adminRoutes } from "@bongsu/api/dashboard/routes";
import { appRoutes } from "@bongsu/api/pwa/routes";
import type { Verifiers } from "@bongsu/api/pwa/webauthn";
import { CRON_INBOX, CRON_INSTAGRAM, CRON_SHORTS } from "@bongsu/core/constants";
import { registerStore } from "@bongsu/core/media/index";
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
  // a fresh instance has no workspace or user (0018 drops the baseline's empty seed): the tests' own, as on SQLite
  expect(await db.prepare("SELECT COUNT(*) AS n FROM users").first()).toEqual({ n: 0 });
  await db.batch([
    db.prepare("INSERT INTO workspaces (id, name, created_at) VALUES ('default', 'Default', 0) ON CONFLICT DO NOTHING"),
    db.prepare(
      "INSERT INTO workspace_settings (workspace_id, timezone, digest_hour, locale, updated_at) VALUES ('default', 'Asia/Seoul', 8, 'en', 0) ON CONFLICT DO NOTHING",
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
      "INSERT INTO media_store (kind, is_default, settings, status, updated_at) VALUES ('local', 1, '{}', 'ok', 0)",
    )
    .run(); // the server's disk, as the dashboard's Media page sets it up
});

describe("Bongsu on Postgres (PGlite)", () => {
  it("answers /health", async () => {
    const r = await createApp(offline).request("/health", {}, env);
    expect(await r.json()).toMatchObject({ ok: true, missing_secrets: [] });
  });

  it("runs the three schedules", async () => {
    const at = new Date("2026-10-20T09:30:00Z");
    for (const cron of [CRON_INSTAGRAM, CRON_SHORTS, CRON_INBOX]) await runSchedule(env, offline, cron, at);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM locks").first())?.n).toBe(0);
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
    expect((await call("/admin-api/state")).json).toMatchObject({ signedIn: true, bootstrapNeeded: false });
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
    const audit = (await call("/admin-api/audit")).json.entries as { action: string }[];
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(["bootstrap", "settings", "key_create"]));
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
