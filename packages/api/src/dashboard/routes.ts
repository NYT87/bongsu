// The dashboard's API, /admin-api (docs/PLAN.md 2.8, Phase 4b): setting up and managing an instance. People sign in
// with an email and a passkey (their own passkeys only); the first one bootstraps the instance with SETUP_TOKEN.
// Its sessions are separate from the PWA's (their own cookie, 12 hours), and changes to who can do what (agent keys,
// devices, passkeys, revoking) need a passkey check from the last 10 minutes. Agent keys and PWA sessions can't reach
// anything here.
import {
  type Account,
  captionRules,
  DEFAULT_WORKSPACE,
  listAccounts,
  setAccountSettings,
  trialCapable,
  trialDefaultOn,
  youtubeAccounts,
} from "@bongsu/core/accounts";
import { channelUploads } from "@bongsu/core/calendar";
import { ReleaseError } from "@bongsu/core/clients/youtube";
import {
  ConnectError,
  finishConnect,
  oauthApps,
  pasteConnect,
  removeConnection,
  removeOAuthApp,
  saveOAuthApp,
  startConnect,
} from "@bongsu/core/connections";
import { CryptoError } from "@bongsu/core/crypto";
import { dueFrom, WhenError, waitingApproval } from "@bongsu/core/data";
import type { Env } from "@bongsu/core/env";
import { sha256Hex } from "@bongsu/core/formats/approved";
import type { LintRules } from "@bongsu/core/formats/caption-lint";
import { isTimeZone, utcIso, zoneStamp } from "@bongsu/core/formats/time";
import { platform, platforms } from "@bongsu/core/platforms/index";
import { describePlatform } from "@bongsu/core/platforms/types";
import { connectSpecs, providerRegistration } from "@bongsu/core/providers/index";
import { moveRelease, releaseStatus } from "@bongsu/core/release";
import { callerZone, setWorkspaceSettings, userRole, userWorkspace, workspaceSettings } from "@bongsu/core/workspaces";
import { type Context, Hono } from "hono";
import { ROLE_SCOPES, withinAttempts } from "../agent/auth";
import {
  createSession,
  endSession,
  markVerified,
  randomToken,
  readCookie,
  type Session,
  sessionCookie,
  validSession,
} from "../pwa/session";
import {
  authenticationOptions,
  realVerifiers,
  registrationOptions,
  type Verifiers,
  verifyAuthentication,
  verifyRegistration,
} from "../pwa/webauthn";

type C = Context<{
  Bindings: Env;
  Variables: { session: Session; token: string; workspace: string; role: string };
}>;
/** Changes to the instance (connections, accounts, OAuth apps, agent keys, settings): an owner's or admin's. Reading,
 *  and the person's own passkeys, devices and CLI tokens, are every member's. */
const MANAGING = /^\/admin-api\/(keys|accounts|videos|connections|oauth-apps|settings|connect\/)/;

/** How recent the last passkey check must be for changes to who can do what. */
export const FRESH_S = 10 * 60;
const DEVICE_CODE_S = 15 * 60;
/** Recovery-code sign-ins an email gets in RECOVERY_MIN minutes, right or wrong. */
const RECOVERY_TRIES = 5;
const RECOVERY_MIN = 15;
const SCOPES = ["read", "draft", "plan", "pause", "reschedule", "metrics"] as const;
/** How long a CLI token may last, in days. */
const TOKEN_DAYS = [30, 90, 365] as const;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

class AdminError extends Error {
  constructor(
    public status: 400 | 401 | 403 | 404 | 409 | 429,
    message: string,
    public extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** "ABCD-EFGH": unambiguous letters and digits (no 0/O, 1/I). */
const code = (n: number) => {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 32 letters: the low 5 bits of a random byte pick one without bias
  const b = crypto.getRandomValues(new Uint8Array(n));
  const s = [...b].map((x) => A[x & 31]).join("");
  return s.replace(/(.{4})(?=.)/g, "$1-");
};

export function adminRoutes(fetcher: typeof fetch, verifiers: Verifiers = realVerifiers) {
  const app = new Hono<{
    Bindings: Env;
    Variables: { session: Session; token: string; workspace: string; role: string };
  }>();
  const nowS = () => Math.floor(Date.now() / 1000);
  const origin = (c: C) => c.env.PUBLIC_URL.replace(/\/$/, "");
  const body = async (c: C) => {
    try {
      return (await c.req.json()) as Record<string, unknown>;
    } catch {
      return {};
    }
  };
  /** The signed-in user's workspace (set with the session; the default one before sign-in). */
  const ws = (c: C) => c.get("workspace") ?? DEFAULT_WORKSPACE;
  const audit = (c: C, action: string, target: string | null, detail: unknown, userId?: string, workspaceId?: string) =>
    c.env.DB.prepare(
      "INSERT INTO audit (at, actor, action, target, detail, user_id, workspace_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
    )
      .bind(
        nowS(),
        `user:${userId ?? c.get("session")?.userId ?? "?"}`,
        action,
        target,
        JSON.stringify(detail),
        userId ?? c.get("session")?.userId ?? null,
        workspaceId ?? ws(c),
      )
      .run();
  const wrap = (fn: (c: C) => Promise<unknown>) => async (c: C) => {
    try {
      return c.json(await fn(c));
    } catch (e) {
      if (e instanceof AdminError) return c.json({ error: e.message, ...e.extra }, e.status);
      if (e instanceof ConnectError) return c.json({ error: e.message }, 400);
      if (e instanceof CryptoError) return c.json({ error: e.message }, 409);
      throw e;
    }
  };
  /** A provider's refusal (a bad token, a refused code) as the owner's error, not a server failure. */
  const providerSays = async <T>(run: () => Promise<T>) => {
    try {
      return await run();
    } catch (e) {
      if (e instanceof AdminError || e instanceof ConnectError || e instanceof CryptoError) throw e;
      throw new AdminError(400, (e as Error).message.slice(0, 300));
    }
  };
  /** Changes to who can do what need a passkey check from the last FRESH_S seconds (POST /admin-api/verify/…). */
  const fresh = (c: C) => {
    if (nowS() - c.get("session").verifiedAt > FRESH_S)
      throw new AdminError(403, "confirm with your passkey first", { verify: true });
  };
  const signIn = async (c: C, userId: string) => {
    c.header(
      "Set-Cookie",
      sessionCookie(await createSession(c.env.DB, nowS(), { app: "dashboard", userId }), undefined, "dashboard"),
    );
  };
  const bootstrapped = async (c: C) =>
    !!(await c.env.DB.prepare("SELECT 1 FROM users WHERE email IS NOT NULL LIMIT 1").first()) ||
    !!(await c.env.DB.prepare("SELECT 1 FROM settings WHERE key = 'bootstrap_done'").first());
  const userByEmail = (c: C, email: string) =>
    c.env.DB.prepare("SELECT id, email, name FROM users WHERE email = ?1")
      .bind(email.trim().toLowerCase())
      .first<{ id: string; email: string; name: string | null }>();
  const newRecoveryCodes = async (c: C, userId: string) => {
    const codes = Array.from({ length: 10 }, () => code(8));
    await c.env.DB.prepare("DELETE FROM recovery_codes WHERE user_id = ?1").bind(userId).run();
    for (const k of codes)
      await c.env.DB.prepare("INSERT INTO recovery_codes (code_hash, user_id, created_at) VALUES (?1, ?2, ?3)")
        .bind(await sha256Hex(k), userId, nowS())
        .run();
    return codes;
  };

  // ---- signed out: the instance's state, the bootstrap, sign-in
  app.get(
    "/admin-api/state",
    wrap(async (c) => {
      const s = await validSession(c.env.DB, readCookie(c.req.header("Cookie"), "dashboard"), nowS(), "dashboard");
      const user = s
        ? await c.env.DB.prepare("SELECT id, email, name FROM users WHERE id = ?1").bind(s.userId).first()
        : null;
      return {
        bootstrapNeeded: !(await bootstrapped(c)),
        setupTokenSet: !!c.env.SETUP_TOKEN,
        signedIn: !!s,
        user,
        dryRun: c.env.DRY_RUN !== "0",
        publicUrl: origin(c),
      };
    }),
  );

  app.post(
    "/admin-api/bootstrap/options",
    wrap(async (c) => {
      const b = await body(c);
      if (await bootstrapped(c)) throw new AdminError(409, "this instance is already set up: sign in");
      if (!c.env.SETUP_TOKEN)
        throw new AdminError(409, "SETUP_TOKEN isn't set on the Worker (site/docs/deploy-cloudflare.md)");
      if ((await sha256Hex(String(b.token ?? "").trim())) !== (await sha256Hex(c.env.SETUP_TOKEN)))
        throw new AdminError(403, "that isn't the setup token");
      const email = String(b.email ?? "")
        .trim()
        .toLowerCase();
      const name =
        String(b.name ?? "")
          .trim()
          .slice(0, 80) || null;
      if (!EMAIL.test(email)) throw new AdminError(400, "enter an email address");
      // the first person is the owner (the user the PWA already knows as "owner")
      return registrationOptions(
        c.env.DB,
        c.env.RP_ID,
        nowS(),
        { bootstrap: true, email, name },
        { id: "owner", email, name },
      );
    }),
  );

  app.post(
    "/admin-api/bootstrap/verify",
    wrap(async (c) => {
      const b = await body(c);
      let claimed: { email?: string; name?: string | null } = {};
      const ok = await verifyRegistration(
        c.env.DB,
        verifiers,
        c.env.RP_ID,
        origin(c),
        String(b.challengeId ?? ""),
        b.response,
        String(b.device ?? "laptop").slice(0, 60),
        nowS(),
        async (data) => {
          const d = data as { bootstrap?: boolean; email?: string; name?: string | null } | null;
          if (!d?.bootstrap) return false;
          // only once, even if two tabs race: the first to set the flag wins
          const won = await c.env.DB.prepare(
            "INSERT INTO settings (key, value, updated_at) VALUES ('bootstrap_done', ?1, ?2) ON CONFLICT (key) DO NOTHING RETURNING key",
          )
            .bind(JSON.stringify({ email: d.email }), nowS())
            .first();
          claimed = d;
          return !!won;
        },
        "owner",
      );
      if (!ok) throw new AdminError(400, "the passkey couldn't be created, or the instance was set up meanwhile");
      await c.env.DB.prepare("UPDATE users SET email = ?1, name = COALESCE(?2, name) WHERE id = 'owner'")
        .bind(claimed.email ?? null, claimed.name ?? null)
        .run();
      const recoveryCodes = await newRecoveryCodes(c, "owner");
      await signIn(c, "owner");
      await audit(c, "bootstrap", "user:owner", { email: claimed.email }, "owner");
      return { signedIn: true, recoveryCodes };
    }),
  );

  app.post(
    "/admin-api/signin/options",
    wrap(async (c) => {
      const email = String((await body(c)).email ?? "");
      const u = EMAIL.test(email.trim()) ? await userByEmail(c, email) : null;
      // An unknown email gets options too (with no passkeys to offer), so the answer doesn't tell who has an account.
      return authenticationOptions(
        c.env.DB,
        c.env.RP_ID,
        "login",
        { dashboard: true, userId: u?.id ?? null },
        nowS(),
        u?.id ?? "\u0000",
      );
    }),
  );

  app.post(
    "/admin-api/signin/verify",
    wrap(async (c) => {
      const b = await body(c);
      const r = await verifyAuthentication(
        c.env.DB,
        verifiers,
        c.env.RP_ID,
        origin(c),
        String(b.challengeId ?? ""),
        "login",
        b.response as { id?: string },
        nowS(),
      );
      const d = r?.data as { dashboard?: boolean; userId?: string | null } | undefined;
      if (!r || !d?.dashboard || !d.userId || d.userId !== r.userId) throw new AdminError(401, "sign-in failed");
      await signIn(c, r.userId);
      await audit(c, "signin", `user:${r.userId}`, {}, r.userId);
      return { signedIn: true };
    }),
  );

  app.post(
    "/admin-api/signin/recovery",
    wrap(async (c) => {
      const b = await body(c);
      const email = String(b.email ?? "")
        .trim()
        .toLowerCase();
      // a recovery code is 40 bits and lasts until used: a few tries per email, whether or not the email is known
      const id = `recovery:${await sha256Hex(email)}`;
      if (!(await withinAttempts(c.env.DB, id, nowS(), RECOVERY_TRIES, RECOVERY_MIN)))
        throw new AdminError(429, `too many tries: wait ${RECOVERY_MIN} minutes`);
      const u = await userByEmail(c, email);
      const k = String(b.code ?? "")
        .trim()
        .toUpperCase();
      const used = u
        ? await c.env.DB.prepare(
            "UPDATE recovery_codes SET used_at = ?1 WHERE code_hash = ?2 AND user_id = ?3 AND used_at IS NULL RETURNING code_hash",
          )
            .bind(nowS(), await sha256Hex(k), u.id)
            .first()
        : null;
      if (!u || !used) throw new AdminError(401, "that email and recovery code don't match");
      await signIn(c, u.id);
      await audit(c, "signin_recovery", `user:${u.id}`, {}, u.id);
      return { signedIn: true, recovered: true };
    }),
  );

  app.post("/admin-api/signout", async (c) => {
    await endSession(c.env.DB, readCookie(c.req.header("Cookie"), "dashboard"));
    c.header("Set-Cookie", sessionCookie("x", 0, "dashboard"));
    return c.json({ signedIn: false });
  });

  // The provider sends the browser back here. The dashboard's cookie is SameSite=Strict, so it doesn't come along on
  // this cross-site redirect: the flow's single-use state says who started it (core/connections.ts).
  app.get("/admin-api/connect/:provider/callback", async (c) => {
    const provider = c.req.param("provider") ?? "";
    const back = (q: Record<string, string>) =>
      c.redirect(`${origin(c)}/dashboard/connections?${new URLSearchParams(q)}`, 302);
    try {
      const r = await finishConnect(
        c.env,
        fetcher,
        provider,
        {
          code: c.req.query("code"),
          state: c.req.query("state"),
          error: c.req.query("error"),
          errorDescription: c.req.query("error_description") ?? c.req.query("error_reason"),
        },
        nowS(),
      );
      await audit(
        c,
        "connect",
        r.connectionId,
        { provider, accounts: r.accounts.map((a) => a.id) },
        r.userId,
        r.workspaceId,
      );
      return back({ connected: r.label, accounts: String(r.accounts.length) });
    } catch (e) {
      return back({ error: (e as Error).message.slice(0, 300) });
    }
  });

  // ---- everything else needs a dashboard session
  app.use("/admin-api/*", async (c, next) => {
    const token = readCookie(c.req.header("Cookie"), "dashboard");
    const s = await validSession(c.env.DB, token, nowS(), "dashboard");
    if (!s || !token) return c.json({ error: "sign in" }, 401);
    // Everything below works in the user's workspace (Phase 13 adds a picker for users in several).
    const workspace = await userWorkspace(c.env.DB, s.userId);
    if (!workspace) return c.json({ error: "you're not a member of any workspace" }, 403);
    c.set("session", s);
    c.set("token", token);
    c.set("workspace", workspace);
    c.set("role", (await userRole(c.env.DB, s.userId, workspace)) ?? "viewer");
    await next();
  });
  app.use("/admin-api/*", async (c, next) => {
    const path = new URL(c.req.url).pathname;
    if (c.req.method !== "GET" && MANAGING.test(path) && !["owner", "admin"].includes(c.get("role")))
      return c.json({ error: "only an owner or admin of the workspace can change this" }, 403);
    await next();
  });

  // A fresh passkey check, for the changes that ask for one.
  app.post(
    "/admin-api/verify/options",
    wrap(async (c) =>
      authenticationOptions(
        c.env.DB,
        c.env.RP_ID,
        "login",
        { verify: c.get("session").userId },
        nowS(),
        c.get("session").userId,
      ),
    ),
  );
  app.post(
    "/admin-api/verify/verify",
    wrap(async (c) => {
      const b = await body(c);
      const r = await verifyAuthentication(
        c.env.DB,
        verifiers,
        c.env.RP_ID,
        origin(c),
        String(b.challengeId ?? ""),
        "login",
        b.response as { id?: string },
        nowS(),
        c.get("session").userId,
      );
      const d = r?.data as { verify?: string } | undefined;
      if (!r || d?.verify !== c.get("session").userId || r.userId !== c.get("session").userId)
        throw new AdminError(401, "the passkey check failed");
      await markVerified(c.env.DB, c.get("token"), nowS());
      return { verified: true };
    }),
  );

  app.get(
    "/admin-api/overview",
    wrap(async (c) => {
      const db = c.env.DB;
      const count = async (sql: string, ...v: unknown[]) =>
        (
          await db
            .prepare(sql)
            .bind(...v)
            .first<{ n: number }>()
        )?.n ?? 0;
      const conns = await db
        .prepare("SELECT status, COUNT(*) AS n FROM connections WHERE workspace_id = ?1 GROUP BY status")
        .bind(ws(c))
        .all<{ status: string; n: number }>();
      const uid = c.get("session").userId;
      const connections = conns.results.reduce((n, r) => n + r.n, 0);
      return {
        dryRun: c.env.DRY_RUN !== "0",
        // The first-run checklist (Get started), read from the data itself: nothing stores its progress.
        setup: {
          // the seeded row has updated_at 0; saving the settings sets it
          timezone:
            (await count(
              "SELECT COUNT(*) AS n FROM workspace_settings WHERE workspace_id = ?1 AND updated_at > 0",
              ws(c),
            )) > 0,
          // a Composio connection needs no app of the owner's
          oauthApp: connections > 0 || (await count("SELECT COUNT(*) AS n FROM oauth_apps")) > 0,
          connection: connections > 0,
          device:
            (await count(
              `SELECT (SELECT COUNT(*) FROM sessions WHERE user_id = ?1 AND app = 'pwa')
                    + (SELECT COUNT(*) FROM push_subs WHERE user_id = ?1) AS n`,
              uid,
            )) > 0,
        },
        accounts: await count(
          "SELECT COUNT(*) AS n FROM accounts WHERE status = 'active' AND workspace_id = ?1",
          ws(c),
        ),
        connections: Object.fromEntries(conns.results.map((r) => [r.status, r.n])),
        keys: await count(
          "SELECT COUNT(*) AS n FROM api_keys WHERE revoked_at IS NULL AND user_id IS NULL AND workspace_id = ?1",
          ws(c),
        ),
        passkeys: await count("SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?1", uid),
        recoveryCodesLeft: await count(
          "SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ?1 AND used_at IS NULL",
          uid,
        ),
        // the app's Needs you rule: no approval, or one for another time
        waitingApproval: await waitingApproval(db, ws(c), nowS()),
      };
    }),
  );

  // ---- agent keys
  app.get(
    "/admin-api/keys",
    wrap(async (c) => {
      const r = await c.env.DB.prepare(
        "SELECT id, name, scopes, created_at, last_used_at, revoked_at, created_by FROM api_keys WHERE workspace_id = ?1 AND user_id IS NULL ORDER BY revoked_at IS NOT NULL, created_at DESC",
      )
        .bind(ws(c))
        .all<{
          id: string;
          name: string;
          scopes: string;
          created_at: number;
          last_used_at: number | null;
          revoked_at: number | null;
          created_by: string | null;
        }>();
      return { scopes: SCOPES, keys: r.results.map((k) => ({ ...k, scopes: JSON.parse(k.scopes) as string[] })) };
    }),
  );
  app.post(
    "/admin-api/keys",
    wrap(async (c) => {
      fresh(c);
      const b = await body(c);
      const name = String(b.name ?? "")
        .trim()
        .slice(0, 60);
      const scopes = Array.isArray(b.scopes) ? b.scopes.map(String) : [];
      if (!name) throw new AdminError(400, "name the key (e.g. the agent or machine using it)");
      if (!scopes.length || scopes.some((s) => !SCOPES.includes(s as (typeof SCOPES)[number])))
        throw new AdminError(400, `scopes: one or more of ${SCOPES.join(", ")}`);
      const key = `bongsu_${randomToken(24)
        .replace(/[^A-Za-z0-9]/g, "")
        .slice(0, 32)
        .padEnd(32, "x")}`;
      const id = `k_${randomToken(9)}`;
      await c.env.DB.prepare(
        "INSERT INTO api_keys (id, name, key_hash, scopes, created_at, workspace_id, created_by) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
      )
        .bind(id, name, await sha256Hex(key), JSON.stringify(scopes), nowS(), ws(c), c.get("session").userId)
        .run();
      await audit(c, "key_create", id, { name, scopes });
      return { id, key, name, scopes };
    }),
  );
  app.post(
    "/admin-api/keys/:id/revoke",
    wrap(async (c) => {
      fresh(c);
      const id = c.req.param("id") ?? "";
      const r = await c.env.DB.prepare(
        "UPDATE api_keys SET revoked_at = ?1 WHERE id = ?2 AND workspace_id = ?3 AND user_id IS NULL AND revoked_at IS NULL RETURNING name",
      )
        .bind(nowS(), id, ws(c))
        .first<{ name: string }>();
      if (!r) throw new AdminError(404, "no active key with that id");
      await audit(c, "key_revoke", id, { name: r.name });
      return { id, revoked: true };
    }),
  );

  // ---- CLI tokens: the signed-in person's own, acting as them with their role's rights (agent/auth.ts ROLE_SCOPES)
  const role = async (c: C) => c.get("role");
  app.get(
    "/admin-api/tokens",
    wrap(async (c) => {
      const r = await c.env.DB.prepare(
        `SELECT id, name, created_at, last_used_at, expires_at, revoked_at FROM api_keys
         WHERE user_id = ?1 AND workspace_id = ?2 ORDER BY revoked_at IS NOT NULL, created_at DESC`,
      )
        .bind(c.get("session").userId, ws(c))
        .all();
      return { rights: ROLE_SCOPES[(await role(c)) ?? ""] ?? [], days: TOKEN_DAYS, tokens: r.results };
    }),
  );
  app.post(
    "/admin-api/tokens",
    wrap(async (c) => {
      fresh(c);
      const b = await body(c);
      const name = String(b.name ?? "")
        .trim()
        .slice(0, 60);
      const days = Number(b.days ?? 90);
      if (!name) throw new AdminError(400, "name the token (e.g. the computer it's for)");
      if (!(TOKEN_DAYS as readonly number[]).includes(days))
        throw new AdminError(400, `lasts ${TOKEN_DAYS.join(", ")} days`);
      if (!(await role(c))) throw new AdminError(403, "you're not a member of this workspace");
      const token = `bongsu_cli_${randomToken(24)
        .replace(/[^A-Za-z0-9]/g, "")
        .slice(0, 32)
        .padEnd(32, "x")}`;
      const id = `t_${randomToken(9)}`;
      const expiresAt = nowS() + days * 86400;
      await c.env.DB.prepare(
        `INSERT INTO api_keys (id, name, key_hash, scopes, created_at, workspace_id, created_by, user_id, expires_at)
         VALUES (?1, ?2, ?3, '[]', ?4, ?5, ?6, ?6, ?7)`,
      )
        .bind(id, name, await sha256Hex(token), nowS(), ws(c), c.get("session").userId, expiresAt)
        .run();
      await audit(c, "token_create", id, { name, days });
      return { id, token, name, expiresAt };
    }),
  );
  app.post(
    "/admin-api/tokens/:id/revoke",
    wrap(async (c) => {
      fresh(c);
      const id = c.req.param("id") ?? "";
      const r = await c.env.DB.prepare(
        "UPDATE api_keys SET revoked_at = ?1 WHERE id = ?2 AND user_id = ?3 AND revoked_at IS NULL RETURNING name",
      )
        .bind(nowS(), id, c.get("session").userId)
        .first<{ name: string }>();
      if (!r) throw new AdminError(404, "no active token of yours with that id");
      await audit(c, "token_revoke", id, { name: r.name });
      return { id, revoked: true };
    }),
  );

  // ---- devices and passkeys
  app.get(
    "/admin-api/passkeys",
    wrap(async (c) => {
      const uid = c.get("session").userId;
      const keys = await c.env.DB.prepare(
        "SELECT id, name, created_at, last_used_at FROM passkeys WHERE user_id = ?1 ORDER BY created_at",
      )
        .bind(uid)
        .all<{ id: string; name: string | null; created_at: number; last_used_at: number | null }>();
      const devices = await c.env.DB.prepare(
        "SELECT device, created_at FROM push_subs WHERE user_id = ?1 ORDER BY created_at",
      )
        .bind(uid)
        .all<{ device: string | null; created_at: number }>();
      return {
        passkeys: keys.results.map((k) => ({ ...k, id: k.id, short: k.id.slice(0, 8) })),
        devices: devices.results,
      };
    }),
  );
  // Add a device: a one-time code (and its link, for a QR code) the device opens to create its passkey and sign in.
  app.post(
    "/admin-api/devices",
    wrap(async (c) => {
      fresh(c);
      const k = code(12);
      const hash = await sha256Hex(k);
      await c.env.DB.prepare("INSERT INTO setup_codes (code_hash, expires_at, user_id) VALUES (?1, ?2, ?3)")
        .bind(hash, nowS() + DEVICE_CODE_S, c.get("session").userId)
        .run();
      await audit(c, "device_code", null, {});
      return {
        id: hash.slice(0, 16),
        code: k,
        link: `${origin(c)}/#/setup?code=${encodeURIComponent(k)}`,
        expiresAt: nowS() + DEVICE_CODE_S,
      };
    }),
  );
  app.get(
    "/admin-api/devices/:id",
    wrap(async (c) => {
      const r = await c.env.DB.prepare(
        "SELECT used_at, expires_at FROM setup_codes WHERE substr(code_hash, 1, 16) = ?1 AND user_id = ?2",
      )
        .bind(c.req.param("id") ?? "", c.get("session").userId)
        .first<{ used_at: number | null; expires_at: number }>();
      if (!r) throw new AdminError(404, "no such code");
      return { used: r.used_at !== null, expired: r.used_at === null && r.expires_at < nowS() };
    }),
  );
  // Another passkey for this user, on this computer (or a security key).
  app.post(
    "/admin-api/passkeys/options",
    wrap(async (c) => {
      fresh(c);
      const u = await c.env.DB.prepare("SELECT id, email, name FROM users WHERE id = ?1")
        .bind(c.get("session").userId)
        .first<{ id: string; email: string | null; name: string | null }>();
      return registrationOptions(c.env.DB, c.env.RP_ID, nowS(), { userId: u!.id, addPasskey: true }, u!);
    }),
  );
  app.post(
    "/admin-api/passkeys/verify",
    wrap(async (c) => {
      fresh(c);
      const b = await body(c);
      const uid = c.get("session").userId;
      const ok = await verifyRegistration(
        c.env.DB,
        verifiers,
        c.env.RP_ID,
        origin(c),
        String(b.challengeId ?? ""),
        b.response,
        String(b.name ?? "passkey").slice(0, 60),
        nowS(),
        async (data) => (data as { userId?: string; addPasskey?: boolean } | null)?.userId === uid,
        uid,
      );
      if (!ok) throw new AdminError(400, "the passkey couldn't be added");
      await audit(c, "passkey_add", null, { name: b.name ?? "passkey" });
      return { added: true };
    }),
  );
  app.post(
    "/admin-api/passkeys/:id/rename",
    wrap(async (c) => {
      const name = String((await body(c)).name ?? "")
        .trim()
        .slice(0, 60);
      if (!name) throw new AdminError(400, "a name, please");
      const r = await c.env.DB.prepare("UPDATE passkeys SET name = ?1 WHERE id = ?2 AND user_id = ?3 RETURNING id")
        .bind(name, c.req.param("id") ?? "", c.get("session").userId)
        .first();
      if (!r) throw new AdminError(404, "no such passkey");
      return { renamed: true };
    }),
  );
  app.post(
    "/admin-api/passkeys/:id/revoke",
    wrap(async (c) => {
      fresh(c);
      const uid = c.get("session").userId;
      const n = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?1")
        .bind(uid)
        .first<{ n: number }>();
      if ((n?.n ?? 0) <= 1) throw new AdminError(409, "that's your only passkey: add another one first");
      const r = await c.env.DB.prepare("DELETE FROM passkeys WHERE id = ?1 AND user_id = ?2 RETURNING name")
        .bind(c.req.param("id") ?? "", uid)
        .first<{ name: string | null }>();
      if (!r) throw new AdminError(404, "no such passkey");
      await audit(c, "passkey_revoke", null, { name: r.name });
      return { revoked: true };
    }),
  );
  app.post(
    "/admin-api/recovery-codes",
    wrap(async (c) => {
      fresh(c);
      const recoveryCodes = await newRecoveryCodes(c, c.get("session").userId);
      await audit(c, "recovery_codes", null, {});
      return { recoveryCodes };
    }),
  );

  // ---- accounts and connections
  /** An account's effective caption rules with its platform's defaults, or null where the platform lints nothing. */
  const accountCaptionRules = (a: Account) => {
    const p = platform(a.platform);
    return p?.formats.length ? { ...captionRules(p, a), defaults: p.lintDefaults } : null;
  };
  const CAPTION_RULES_HELP = "caption rules: hashtagMax 0–30, foldChars 50–500, languageChecks true/false";
  /** A change to the owner's overrides: each present field checked (so a stray value can't reach the lint), null
   *  meaning "back to the platform's default". Fields not sent are left as they are. */
  const parseCaptionRules = (v: unknown): { [K in keyof LintRules]?: LintRules[K] | null } => {
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new AdminError(400, CAPTION_RULES_HELP);
    const o = v as Record<string, unknown>;
    const out: { [K in keyof LintRules]?: LintRules[K] | null } = {};
    const int = (k: "hashtagMax" | "foldChars", min: number, max: number) => {
      if (!(k in o) || o[k] === undefined) return;
      if (o[k] === null) out[k] = null;
      else if (typeof o[k] !== "number" || !Number.isInteger(o[k]) || o[k] < min || o[k] > max)
        throw new AdminError(400, CAPTION_RULES_HELP);
      else out[k] = o[k];
    };
    int("hashtagMax", 0, 30);
    int("foldChars", 50, 500);
    if ("languageChecks" in o && o.languageChecks !== undefined) {
      if (o.languageChecks !== null && typeof o.languageChecks !== "boolean")
        throw new AdminError(400, CAPTION_RULES_HELP);
      out.languageChecks = o.languageChecks;
    }
    return out;
  };
  /** The account's overrides with a change applied: a null field is dropped, the rest stays. */
  const mergeCaptionRules = (acc: Account, change: ReturnType<typeof parseCaptionRules>) => {
    const was = acc.settings.captionRules;
    const next: Record<string, unknown> = was && typeof was === "object" ? { ...(was as object) } : {};
    for (const [k, v] of Object.entries(change)) {
      if (v === null) delete next[k];
      else next[k] = v;
    }
    return next;
  };
  app.get(
    "/admin-api/accounts",
    wrap(async (c) => ({
      platforms: platforms().map(describePlatform),
      accounts: (await listAccounts(c.env.DB, { workspaceId: ws(c), all: true })).map((a) => ({
        id: a.id,
        platform: a.platform,
        handle: a.handle,
        name: a.displayName ?? a.handle,
        status: a.status,
        connection: a.connection
          ? {
              id: a.connection.id,
              provider: a.connection.provider,
              label: a.connection.label,
              status: a.connection.status,
            }
          : null,
        trialReels: platform(a.platform)?.features.trial ? { capable: trialCapable(a), on: trialDefaultOn(a) } : null,
        captionRules: accountCaptionRules(a),
      })),
    })),
  );
  app.post(
    "/admin-api/accounts/:id",
    wrap(async (c) => {
      const id = c.req.param("id") ?? "";
      const b = await body(c);
      const acc = (await listAccounts(c.env.DB, { workspaceId: ws(c), all: true })).find((a) => a.id === id);
      if (!acc) throw new AdminError(404, "no such account");
      if ("trialReels" in b) {
        if (!trialCapable(acc)) throw new AdminError(409, "Trial Reels aren't possible on this account yet");
        await setAccountSettings(c.env.DB, id, { trialReels: !!b.trialReels }, nowS());
      }
      if ("captionRules" in b) {
        const captionRules = mergeCaptionRules(acc, parseCaptionRules(b.captionRules));
        await setAccountSettings(c.env.DB, id, { captionRules }, nowS());
      }
      if ("name" in b)
        await c.env.DB.prepare("UPDATE accounts SET display_name = ?1, updated_at = ?2 WHERE id = ?3")
          .bind(
            String(b.name ?? "")
              .trim()
              .slice(0, 80) || null,
            nowS(),
            id,
          )
          .run();
      if ("status" in b) {
        if (b.status !== "active" && b.status !== "disabled") throw new AdminError(400, "status: active or disabled");
        await c.env.DB.prepare("UPDATE accounts SET status = ?1, updated_at = ?2 WHERE id = ?3")
          .bind(b.status, nowS(), id)
          .run();
      }
      await audit(c, "account_update", id, b);
      return { id, updated: true };
    }),
  );
  // Removing an account: only a disabled one with nothing left to publish (its published history keeps its name).
  app.post(
    "/admin-api/accounts/:id/remove",
    wrap(async (c) => {
      fresh(c);
      const id = c.req.param("id") ?? "";
      const acc = (await listAccounts(c.env.DB, { workspaceId: ws(c), all: true })).find((a) => a.id === id);
      if (!acc) throw new AdminError(404, "no such account");
      if (acc.status === "active") throw new AdminError(409, "disable it first");
      const left = await c.env.DB.prepare(
        `SELECT (SELECT COUNT(*) FROM plan_items p WHERE p.account = ?1 AND p.workspace_id = ?2
                   AND NOT EXISTS (SELECT 1 FROM posted x WHERE x.item_key = p.item_key))
              + (SELECT COUNT(*) FROM drafts d WHERE d.account = ?1 AND d.workspace_id = ?2 AND d.status = 'draft') AS n`,
      )
        .bind(id, ws(c))
        .first<{ n: number }>();
      if (left?.n)
        throw new AdminError(409, `it still has ${left.n} item(s) or draft(s) to publish: remove or move them first`);
      await c.env.DB.prepare("DELETE FROM accounts WHERE id = ?1 AND workspace_id = ?2").bind(id, ws(c)).run();
      await audit(c, "account_remove", id, { handle: acc.handle, platform: acc.platform });
      return { id, removed: true };
    }),
  );
  // ---- YouTube videos: each channel's uploads, and moving a scheduled one's release date
  app.get(
    "/admin-api/videos",
    wrap(async (c) => {
      const tz = await callerZone(c.env.DB, ws(c), c.get("session").userId);
      const refresh = c.req.query("refresh") === "1";
      const warnings: string[] = [];
      const channels = [];
      for (const ch of await youtubeAccounts(c.env.DB, ws(c))) {
        const name = ch.displayName ?? ch.handle;
        try {
          const videos = (await channelUploads(c.env, fetcher, ch, refresh)).map((u) => {
            const at = u.when ? Math.floor(Date.parse(u.when) / 1000) : null;
            return {
              id: u.id,
              title: u.title,
              short: u.short,
              // the calendar's mapping: a private video with a release time is the scheduled one
              status: u.privacy === "public" ? "public" : u.privacy === "private" && u.when ? "scheduled" : u.privacy,
              when: at === null ? null : zoneStamp(at, tz),
              when_at: at === null ? null : utcIso(at),
              url: `https://youtu.be/${u.id}`,
            };
          });
          videos.sort((a, b) => (b.when_at ?? "").localeCompare(a.when_at ?? ""));
          channels.push({ id: ch.id, name, videos });
        } catch (e) {
          channels.push({ id: ch.id, name, videos: [] });
          warnings.push(`YouTube ${name}: ${(e as Error).message}`);
        }
      }
      return { channels, warnings };
    }),
  );
  app.post(
    "/admin-api/videos/:id/release",
    wrap(async (c) => {
      fresh(c);
      const b = await body(c);
      const userId = c.get("session").userId;
      const tz = await callerZone(c.env.DB, ws(c), userId);
      let at: number | null | undefined;
      try {
        at = dueFrom({ date: b.date, time: b.time }, "video", tz);
      } catch (e) {
        if (e instanceof WhenError) throw new AdminError(400, e.message);
        throw e;
      }
      if (typeof at !== "number") throw new AdminError(400, "give a date and time");
      try {
        return await moveRelease(c.env, fetcher, {
          workspaceId: ws(c),
          videoId: c.req.param("id") ?? "",
          at,
          nowS: nowS(),
          tz,
          actor: { kind: "owner", userId },
        });
      } catch (e) {
        if (e instanceof ReleaseError) throw new AdminError(releaseStatus(e) as 400 | 404 | 409, e.message);
        throw e;
      }
    }),
  );
  app.get(
    "/admin-api/connections",
    wrap(async (c) => {
      const r = await c.env.DB.prepare(
        `SELECT id, provider, label, status, expires_at, last_error, last_checked_at FROM connections
         WHERE workspace_id = ?1 ORDER BY provider, id`,
      )
        .bind(ws(c))
        .all<{ id: string }>();
      // the accounts each one reaches (grouped here: no database-specific aggregate)
      const accounts = await listAccounts(c.env.DB, { workspaceId: ws(c), all: true });
      return {
        connections: r.results.map((x) => ({
          ...x,
          accounts: accounts.filter((a) => a.connection?.id === x.id).map((a) => a.id),
        })),
        kinds: connectSpecs().map((k) => ({ ...k, canPaste: !!providerRegistration(k.provider)?.paste })),
        // the OAuth apps already set: their providers' Connect buttons work
        appsReady: (await c.env.DB.prepare("SELECT id FROM oauth_apps").all<{ id: string }>()).results.map((r) => r.id),
      };
    }),
  );

  // ---- OAuth apps (bring your own) and connecting
  app.get(
    "/admin-api/oauth-apps",
    wrap(async (c) => ({
      apps: await oauthApps(c.env.DB, origin(c)),
      encryptionKeySet: !!c.env.ENCRYPTION_KEY,
    })),
  );
  app.post(
    "/admin-api/oauth-apps/:id",
    wrap(async (c) => {
      fresh(c);
      const b = await body(c);
      const id = c.req.param("id") ?? "";
      await saveOAuthApp(
        c.env,
        id,
        String(b.clientId ?? ""),
        String(b.clientSecret ?? ""),
        c.get("session").userId,
        nowS(),
      );
      await audit(c, "oauth_app_save", id, { clientId: String(b.clientId ?? "").trim() });
      return { saved: true };
    }),
  );
  app.post(
    "/admin-api/oauth-apps/:id/remove",
    wrap(async (c) => {
      fresh(c);
      const id = c.req.param("id") ?? "";
      await removeOAuthApp(c.env.DB, id);
      await audit(c, "oauth_app_remove", id, {});
      return { removed: true };
    }),
  );
  app.post(
    "/admin-api/connect/:provider/start",
    wrap(async (c) => {
      fresh(c);
      const b = await body(c);
      const url = await startConnect(c.env, c.req.param("provider") ?? "", {
        userId: c.get("session").userId,
        workspaceId: ws(c),
        reconnect: typeof b.reconnect === "string" ? b.reconnect : null,
        nowS: nowS(),
      });
      return { url };
    }),
  );
  app.post(
    "/admin-api/connect/:provider/paste",
    wrap(async (c) => {
      fresh(c);
      const provider = c.req.param("provider") ?? "";
      const value = String((await body(c)).value ?? "");
      if (!value.trim()) throw new AdminError(400, "paste the token or the connection id");
      const r = await providerSays(() => pasteConnect(c.env, fetcher, provider, value, nowS(), ws(c)));
      await audit(c, "connect", r.connectionId, { provider, accounts: r.accounts.map((a) => a.id), pasted: true });
      return r;
    }),
  );
  app.post(
    "/admin-api/connections/:id/remove",
    wrap(async (c) => {
      fresh(c);
      const id = c.req.param("id") ?? "";
      const r = await removeConnection(c.env, fetcher, id, ws(c));
      await audit(c, "connection_remove", id, r);
      return { removed: true, revoked: r.revoked };
    }),
  );

  // ---- settings and audit
  app.get(
    "/admin-api/settings",
    wrap(async (c) => {
      const w = await workspaceSettings(c.env.DB, ws(c));
      return { timezone: w.timezone, digestHour: w.digestHour, dryRun: c.env.DRY_RUN !== "0", publicUrl: origin(c) };
    }),
  );
  app.post(
    "/admin-api/settings",
    wrap(async (c) => {
      const b = await body(c);
      const tz = b.timezone === undefined ? undefined : String(b.timezone);
      const hour = b.digestHour === undefined ? undefined : Number(b.digestHour);
      if (tz !== undefined && !isTimeZone(tz)) throw new AdminError(400, "unknown time zone");
      if (hour !== undefined && !(Number.isInteger(hour) && hour >= 0 && hour <= 23))
        throw new AdminError(400, "digest hour: 0 to 23");
      await setWorkspaceSettings(c.env.DB, ws(c), { timezone: tz, digestHour: hour }, nowS());
      await audit(c, "settings", null, { timezone: tz, digestHour: hour });
      return { saved: true };
    }),
  );
  app.get(
    "/admin-api/audit",
    wrap(async (c) => {
      const before = Number(c.req.query("before") ?? 0) || null;
      const r = await c.env.DB.prepare(
        `SELECT id, at, actor, action, target, detail FROM audit
         WHERE (CAST(?1 AS BIGINT) IS NULL OR id < ?1) AND (workspace_id = ?2 OR workspace_id IS NULL) ORDER BY id DESC LIMIT 50`,
      )
        .bind(before, ws(c))
        .all<{ id: number; at: number; actor: string; action: string; target: string | null; detail: string | null }>();
      return { entries: r.results };
    }),
  );

  return app;
}
