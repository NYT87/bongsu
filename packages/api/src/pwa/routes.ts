// The owner's app API under /app-api . The app itself is static (packages/web, Workers
// assets) and talks only to these routes, same origin. Sign-in is a passkey (the first one registered with a
// one-time code made in the dashboard's Devices & passkeys); approving needs a fresh passkey assertion every time.

import { instagramAccounts, listAccounts } from "@bongsu/core/accounts";
import { calendar } from "@bongsu/core/calendar";
import { ReleaseError } from "@bongsu/core/clients/youtube";
import { replyToComment } from "@bongsu/core/comments";
import { ConnectError, startConnect } from "@bongsu/core/connections";
import { LINK_TTL_S } from "@bongsu/core/constants";
import { dueFrom, getItem, getPosted, isPosted, itemOptions, trialFor, WhenError } from "@bongsu/core/data";
import type { Env } from "@bongsu/core/env";
import { sha256Hex } from "@bongsu/core/formats/approved";
import { zoneDate, zoneStamp } from "@bongsu/core/formats/time";
import { mediaUrl } from "@bongsu/core/media";
import { mediaStores, storeRows } from "@bongsu/core/media/index";
import { isVideo, type MediaStore } from "@bongsu/core/media/store";
import { effectivePrefs, isNoteGroup, setPref } from "@bongsu/core/notify-prefs";
import { platforms } from "@bongsu/core/platforms/index";
import { describePlatform } from "@bongsu/core/platforms/types";
import { connectSpecs } from "@bongsu/core/providers/index";
import { isPushEndpoint, sendPush } from "@bongsu/core/push";
import { moveRelease, releaseStatus } from "@bongsu/core/release";
import { mayConnect } from "@bongsu/core/roles";
import { mayBeLive } from "@bongsu/core/tick";
import {
  callerZone,
  FALLBACK_ZONE,
  sessionWorkspace,
  setUserZone,
  workspaceRef,
  workspaceSettings,
  workspacesOf,
  workspaceZone,
} from "@bongsu/core/workspaces";
import { type Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { type Caller, type Scope, scopesOf } from "../agent/auth";
import * as ops from "../agent/ops";
import { resolveItem, type Snapshot, sameSnapshot, snapshot, writeApproval } from "./approve";
import { AcceptError, APP_ROLES, inviteOptions, invitePreview, inviteVerify } from "./invite";
import { editTexts, ScheduleError, scheduleDraft } from "./schedule";
import {
  createSession,
  endSession,
  oauthCookie,
  openWorkspace,
  readCookie,
  type Session,
  sessionCookie,
  setSessionWorkspace,
  validSession,
} from "./session";
import { draftFromUploads, startUpload, UploadError } from "./uploads";
import {
  authenticationOptions,
  realVerifiers,
  registrationOptions,
  type Verifiers,
  verifyAuthentication,
  verifyRegistration,
} from "./webauthn";

type Vars = {
  Bindings: Env;
  Variables: {
    caller: Caller;
    connects: boolean;
    needs: { scope: Scope | null };
    session: Session;
    /** Tagged by the router (below): a route a signed-in person in no workspace still reaches. */
    noWorkspace: true;
  };
};
type C = Context<Vars>;
// The app works as the signed-in user, in their session's workspace (core/workspaces.ts sessionWorkspace), with their
// role's rights there (agent/auth.ts ROLE_SCOPES; an instance admin's are an admin's): approving and resuming need
// "approve" / "resume", pausing "pause", changing the plan "plan". The signed-out routes (who am I, setup, login) act
// for no one and in no workspace.
/** The scope each change needs, by route pattern; a POST not listed needs "plan" unless it's the person's own (session,
 *  device, zone). The router tags each request with its pattern's (below), never a second look at the URL: Hono
 *  matches the decoded path, so a regex on the raw one would miss `/app-api/%61pprove/options`. */
const NEEDS: [string, Scope | null][] = [
  ["/app-api/approve/*", "approve"],
  ["/app-api/resume/*", "resume"],
  ["/app-api/pause", "pause"],
  ["/app-api/youtube/release/*", "reschedule"],
  // connecting accounts needs the role itself (an admin's or a creator's: core/roles.ts mayConnect), not a scope
  ["/app-api/connect/*", null],
  ["/app-api/logout", null],
  ["/app-api/me/timezone", null],
  // switching workspaces is the person's own; where they may go is mayOpen's (session.ts openWorkspace)
  ["/app-api/session/*", null],
  ["/app-api/push/*", null],
  // a person's own notification settings
  ["/app-api/notify-prefs", null],
  ["/app-api/client-error", null],
  ["/app-api/comments/seen", null],
];
const nowS = () => Math.floor(Date.now() / 1000);

export function appRoutes(fetcher: typeof fetch, verifiers: Verifiers = realVerifiers) {
  const app = new Hono<Vars>();
  /** The signed-in caller, set by the session check below; a request without one is refused, never defaulted. */
  const me = (c: C): Caller => {
    const caller = c.get("caller");
    if (!caller) throw new HTTPException(401, { res: Response.json({ error: "sign in" }, { status: 401 }) });
    return caller;
  };
  /** The signed-in user's id: every app caller is one (callerFor). */
  const userOf = (c: C): string => {
    const u = me(c).userId;
    if (!u) throw new HTTPException(401, { res: Response.json({ error: "sign in" }, { status: 401 }) });
    return u;
  };
  const callerFor = async (c: C, s: Session): Promise<Caller | null> => {
    const where = await sessionWorkspace(c.env.DB, s);
    if (!where) return null;
    const scopes = scopesOf(where.role, where.instanceAdmin);
    c.set("connects", mayConnect(where.role));
    return { id: s.userId, name: `${s.userId} (app)`, scopes, workspaceId: where.workspaceId, userId: s.userId };
  };
  const origin = (c: C) => c.env.PUBLIC_URL.replace(/\/$/, "");
  const body = async (c: C) => {
    try {
      return (await c.req.json()) as Record<string, unknown>;
    } catch {
      return {};
    }
  };
  const opctx = (c: C): ops.OpCtx => ({ env: c.env, fetch: fetcher, now: new Date(), caller: me(c) });
  /** The signed-in user's time zone (their own, else the workspace's): what the app shows and takes times in. */
  const zone = (c: C) => callerZone(c.env.DB, me(c).workspaceId, me(c).userId);
  /** An audit row of the caller's (`user:<id>`, as the dashboard writes it), in their workspace; a signed-out route's
   *  (a new passkey) names its user and, without a workspace, is the instance's. */
  const audit = (c: C, action: string, target: string | null, detail: unknown, userId?: string) => {
    const who = userId ?? c.get("caller")?.userId ?? null;
    return c.env.DB.prepare(
      "INSERT INTO audit (at, actor, action, target, detail, user_id, workspace_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
    )
      .bind(
        nowS(),
        `user:${who ?? "?"}`,
        action,
        target,
        JSON.stringify(detail),
        who,
        c.get("caller")?.workspaceId ?? null,
      )
      .run();
  };
  /** Sets (or, with null, removes) one of an item's platform options; returns the item, or null when it isn't one of
   *  the workspace's. The options are read and written whole (no database-specific JSON functions). */
  const setOption = async (c: C, key: string, name: string, value: unknown) => {
    const i = await getItem(c.env.DB, key, me(c).workspaceId);
    if (!i) return null;
    const options = itemOptions(i);
    if (value === null) delete options[name];
    else options[name] = value;
    await c.env.DB.prepare(
      "UPDATE plan_items SET options = ?1, updated_at = ?2, updated_by = 'owner@app' WHERE item_key = ?3 AND workspace_id = ?4",
    )
      .bind(JSON.stringify(options), nowS(), key, me(c).workspaceId)
      .run();
    return { ...i, options: JSON.stringify(options) };
  };
  /** A short-lived link to show a file in the app (the same kind Instagram gets). */
  const preview = (c: C, store: MediaStore, m: { id: string; mime: string }) =>
    mediaUrl(store, {
      base: origin(c),
      secret: c.env.MEDIA_SIGNING_KEY,
      id: m.id,
      video: isVideo(m),
      nowS: nowS(),
      ttlS: LINK_TTL_S,
    });
  const signIn = async (c: C, userId: string) => {
    c.header("Set-Cookie", sessionCookie(await createSession(c.env.DB, nowS(), { userId })));
    return c.json({ signedIn: true });
  };

  // ---- public: who am I, setup, login
  // The platforms the app shows: names, what each calls its formats, features and options (no secrets, no accounts).
  app.get("/app-api/platforms", (c) =>
    c.json({ platforms: platforms().map(describePlatform), connections: connectSpecs() }),
  );
  app.get("/app-api/me", async (c) => {
    const n = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM passkeys").first<{ n: number }>();
    const s = await validSession(c.env.DB, readCookie(c.req.header("Cookie")), nowS());
    const caller = s && (await callerFor(c, s));
    if (caller) c.set("caller", caller);
    // active accounts of the caller's workspace: none means the app points at the dashboard's setup
    const accounts = caller
      ? await c.env.DB.prepare("SELECT COUNT(*) AS n FROM accounts WHERE workspace_id = ?1 AND status = 'active'")
          .bind(caller.workspaceId)
          .first<{ n: number }>()
      : null;
    return c.json({
      signedIn: !!s,
      // the role's scopes (ROLE_SCOPES): the app shows an action only to someone who can take it
      scopes: caller?.scopes ?? [],
      // an admin or a creator there (core/roles.ts mayConnect): Settings offers Connect Instagram and YouTube
      connects: !!caller && !!c.get("connects"),
      setupNeeded: (n?.n ?? 0) === 0,
      // signed in, but a member of no workspace (yet, or any more): the app says to ask for one
      noWorkspace: !!s && !caller,
      accounts: accounts?.n ?? 0,
      vapidPublicKey: c.env.VAPID_PUBLIC_KEY,
      dryRun: c.env.DRY_RUN !== "0",
      // the user's own zone, else their workspace's; UTC without one (never another workspace's)
      timezone: s ? await callerZone(c.env.DB, caller?.workspaceId ?? null, s.userId) : FALLBACK_ZONE,
      workspaceTimezone: caller ? await workspaceZone(c.env.DB, caller.workspaceId) : FALLBACK_ZONE,
      // the text the app shows (packages/web/src/i18n.ts): the workspace's, English for someone not signed in
      locale: caller ? (await workspaceSettings(c.env.DB, caller.workspaceId)).locale : "en",
      // where the session works, and the picker's list (creators included: the app is theirs)
      workspace: caller ? await workspaceRef(c.env.DB, caller.workspaceId) : null,
      workspaces: s ? await workspacesOf(c.env.DB, s.userId) : [],
    });
  });

  // The code is checked here but only used up once a passkey is actually created (a failed attempt keeps it).
  app.post("/app-api/setup/options", async (c) => {
    const code = String((await body(c)).code ?? "")
      .trim()
      .toUpperCase();
    const codeHash = await sha256Hex(code);
    const valid = await c.env.DB.prepare(
      "SELECT s.user_id, u.email, u.name FROM setup_codes s JOIN users u ON u.id = s.user_id WHERE s.code_hash = ?1 AND s.used_at IS NULL AND s.expires_at >= ?2",
    )
      .bind(codeHash, nowS())
      .first<{ user_id: string; email: string | null; name: string | null }>();
    if (!code || !valid)
      return c.json(
        { error: "invalid or expired setup code: make a new one in the dashboard (Devices & passkeys)" },
        403,
      );
    // the passkey belongs to the user who made the code
    return c.json(
      await registrationOptions(
        c.env.DB,
        c.env.RP_ID,
        nowS(),
        { codeHash, userId: valid.user_id },
        { id: valid.user_id, email: valid.email, name: valid.name },
      ),
    );
  });

  app.post("/app-api/setup/verify", async (c) => {
    const b = await body(c);
    // the code's user, whom the challenge names: a code always belongs to someone (made in the dashboard)
    let userId: string | null = null;
    const useCode = async (data: unknown) => {
      userId = (data as { userId?: string } | null)?.userId ?? null;
      if (!userId) return false;
      return !!(await c.env.DB.prepare(
        "UPDATE setup_codes SET used_at = ?1 WHERE code_hash = ?2 AND used_at IS NULL AND expires_at >= ?1 RETURNING code_hash",
      )
        .bind(nowS(), (data as { codeHash?: string } | null)?.codeHash ?? "")
        .first());
    };
    const ok = await verifyRegistration(
      c.env.DB,
      verifiers,
      c.env.RP_ID,
      origin(c),
      String(b.challengeId ?? ""),
      b.response,
      String(b.name ?? "device"),
      nowS(),
      useCode,
    );
    const user = userId as string | null; // set by useCode
    if (!ok || !user) return c.json({ error: "passkey registration failed" }, 400);
    // logged in the workspace the new device's user works in (the instance's log when they have none yet)
    const caller = await callerFor(c, { userId: user, app: "pwa", verifiedAt: nowS(), workspaceId: null });
    if (caller) c.set("caller", caller);
    await audit(c, "passkey_add", null, { name: b.name ?? "device", user }, user);
    return signIn(c, user);
  });

  app.post("/app-api/login/options", async (c) => {
    const n = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM passkeys").first<{ n: number }>();
    if (!n?.n) return c.json({ error: "no passkey yet: set one up first" }, 409);
    return c.json(await authenticationOptions(c.env.DB, c.env.RP_ID, "login", null, nowS()));
  });

  app.post("/app-api/login/verify", async (c) => {
    const b = await body(c);
    const ok = await verifyAuthentication(
      c.env.DB,
      verifiers,
      c.env.RP_ID,
      origin(c),
      String(b.challengeId ?? ""),
      "login",
      b.response as { id?: string },
      nowS(),
    );
    if (!ok) return c.json({ error: "sign-in failed" }, 401);
    return signIn(c, ok.userId);
  });

  app.post("/app-api/logout", async (c) => {
    await endSession(c.env.DB, readCookie(c.req.header("Cookie")));
    c.header("Set-Cookie", sessionCookie("x", 0));
    return c.json({ signedIn: false });
  });

  // ---- accepting an invite (pwa/invite.ts), signed out: creators join here; an admin's or editor's invite is the
  // dashboard's, and here answers like any other unusable one
  const accepting = (fn: (c: C) => Promise<unknown>) => async (c: C) => {
    try {
      return c.json(await fn(c));
    } catch (e) {
      if (e instanceof AcceptError) return c.json(e.answer, e.status);
      throw e;
    }
  };
  app.get(
    "/app-api/invite/:token",
    accepting((c) => invitePreview(c.env, c.req.param("token") ?? "", nowS(), APP_ROLES)),
  );
  app.post(
    "/app-api/invite/:token/options",
    accepting(async (c) => inviteOptions(c.env, c.req.param("token") ?? "", (await body(c)).name, nowS(), APP_ROLES)),
  );
  app.post(
    "/app-api/invite/:token/verify",
    accepting(async (c) => {
      const j = await inviteVerify(
        c.env,
        verifiers,
        origin(c),
        c.req.param("token") ?? "",
        await body(c),
        nowS(),
        APP_ROLES,
      );
      // signed in, working in the workspace just joined
      const token = await createSession(c.env.DB, nowS(), { userId: j.userId });
      await setSessionWorkspace(c.env.DB, token, j.workspaceId);
      c.header("Set-Cookie", sessionCookie(token));
      const caller = await callerFor(c, {
        userId: j.userId,
        app: "pwa",
        verifiedAt: nowS(),
        workspaceId: j.workspaceId,
      });
      if (caller) c.set("caller", caller);
      await audit(c, "invite_accept", `user:${j.userId}`, { role: j.role, isNew: j.isNew }, j.userId);
      return { signedIn: true, role: j.role };
    }),
  );

  // ---- everything else needs a session, and a workspace to work in, except for switching to one: someone whose
  // session works nowhere (an instance admin in none) picks one there, as the dashboard's `session` area allows.
  // Tagged by the router, before the check reads it.
  app.use("/app-api/session/*", async (c, next) => {
    c.set("noWorkspace", true);
    await next();
  });
  app.use("/app-api/*", async (c, next) => {
    const s = await validSession(c.env.DB, readCookie(c.req.header("Cookie")), nowS());
    if (!s) return c.json({ error: "sign in" }, 401);
    c.set("session", s);
    const caller = await callerFor(c, s);
    if (caller) c.set("caller", caller);
    else if (!c.get("noWorkspace"))
      return c.json({ error: "you're not a member of any workspace", noWorkspace: true }, 403);
    await next();
  });
  // ---- and a role that allows the change
  for (const [pattern, scope] of NEEDS)
    app.use(pattern, async (c, next) => {
      c.set("needs", { scope });
      await next();
    });
  app.use("/app-api/*", async (c, next) => {
    if (c.req.method === "GET") return next();
    const needs = c.get("needs");
    const scope = needs ? needs.scope : "plan";
    if (scope && !me(c).scopes.includes(scope))
      return c.json({ error: `your role in this workspace can't do that (it needs "${scope}")` }, 403);
    await next();
  });

  const wrap = (fn: (c: C) => Promise<unknown>) => async (c: C) => {
    try {
      return c.json(await fn(c));
    } catch (e) {
      if (e instanceof ops.ApiError) return c.json({ error: e.message, ...(e.extra ?? {}) }, e.status as 400);
      throw e;
    }
  };
  const num = (v: string | undefined) => (v === undefined ? undefined : Number(v));
  app.get(
    "/app-api/status",
    wrap((c) => ops.status(opctx(c))),
  );
  app.get(
    "/app-api/queue",
    wrap((c) =>
      ops.queue(opctx(c), {
        days: num(c.req.query("days")),
        account: c.req.query("account"),
        channel: c.req.query("channel"),
        group: c.req.query("group"),
        from: c.req.query("from"),
      }),
    ),
  );
  app.get(
    "/app-api/queue/groups",
    wrap((c) => ops.queueFacets(opctx(c), { days: num(c.req.query("days")) })),
  );
  app.get(
    "/app-api/jobs",
    wrap((c) => ops.jobs(opctx(c), { days: num(c.req.query("days")) })),
  );
  app.get(
    "/app-api/notifications",
    wrap((c) => ops.notifications(opctx(c), { limit: num(c.req.query("limit")) })),
  );
  // Drafts, with short-lived preview links for their media (inbox drops and uploads).
  app.get(
    "/app-api/drafts",
    wrap(async (c) => {
      const r = await ops.listDrafts(opctx(c), { status: c.req.query("status") });
      const stores = await mediaStores(c.env, fetcher);
      return {
        accounts: (await instagramAccounts(c.env.DB, me(c).workspaceId)).map((a) => a.id),
        drafts: await Promise.all(
          r.drafts.map(async (d) => {
            const files = (d.payload as { files?: { store: string; id: string; name: string; mime: string }[] }).files;
            if (!Array.isArray(files)) return d;
            return {
              ...d,
              previews: await Promise.all(
                files.flatMap((f) => {
                  const store = stores.for(f);
                  return store ? [preview(c, store, f).then((url) => ({ name: f.name, mime: f.mime, url }))] : [];
                }),
              ),
            };
          }),
        ),
      };
    }),
  );

  // The calendar: ?month=YYYY-MM (the workspace's zone); &refresh=1 re-reads YouTube instead of the hour-old cache.
  app.get("/app-api/calendar", async (c) => {
    const tz = await zone(c);
    const month = c.req.query("month") ?? zoneDate(new Date(), tz).slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) return c.json({ error: "month must be YYYY-MM" }, 400);
    const [y, m] = month.split("-").map(Number);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const ws = { id: me(c).workspaceId, tz };
    return c.json({
      month,
      ...(await calendar(
        c.env,
        fetcher,
        ws,
        `${month}-01`,
        `${month}-${String(last).padStart(2, "0")}`,
        c.req.query("refresh") === "1",
      )),
    });
  });

  // The Stats tab: the accounts' followers and the last 7 days' posts, most viewed first.
  app.get(
    "/app-api/stats",
    wrap((c) => ops.statsOverview(opctx(c))),
  );
  // An account's page: followers over a period, views per day, what brought followers (#140 reuses the op).
  app.get(
    "/app-api/stats/channel",
    wrap((c) => ops.channelStats(opctx(c), { account: c.req.query("account") ?? "", days: c.req.query("days") })),
  );

  // One day's events, posted or pending (Instagram + YouTube): ?date=YYYY-MM-DD (the workspace's zone, default today).
  app.get("/app-api/day", async (c) => {
    const tz = await zone(c);
    const date = c.req.query("date") ?? zoneDate(new Date(), tz);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return c.json({ error: "date must be YYYY-MM-DD" }, 400);
    return c.json({ date, ...(await calendar(c.env, fetcher, { id: me(c).workspaceId, tz }, date, date)) });
  });

  // A draft becomes a scheduled item (texts and media in D1); it's approved afterwards like any other item.
  const owned = (fn: (c: C) => Promise<unknown>) => async (c: C) => {
    try {
      return c.json(await fn(c));
    } catch (e) {
      if (e instanceof ScheduleError) return c.json({ error: e.message, ...(e.extra ?? {}) }, e.status);
      if (e instanceof UploadError) return c.json({ error: e.message }, e.status);
      throw e;
    }
  };
  app.post(
    "/app-api/drafts/:id/schedule",
    owned(async (c) =>
      scheduleDraft(c.env, c.req.param("id") ?? "", await body(c), nowS(), await zone(c), me(c).workspaceId, userOf(c)),
    ),
  );
  // Uploads from the app: the store's upload target per file (the browser sends the bytes straight to it), then the draft.
  app.post(
    "/app-api/uploads/start",
    owned(async (c) => startUpload(c.env, fetcher, await body(c))),
  );
  app.post(
    "/app-api/drafts/new",
    owned(async (c) => draftFromUploads(c.env, fetcher, await body(c), nowS(), me(c).workspaceId, userOf(c))),
  );
  // What went wrong on a device (upload failures): kept in the audit log of the caller's workspace, read in the
  // dashboard's audit page.
  app.post("/app-api/client-error", async (c) => {
    const b = await body(c);
    await c.env.DB.prepare(
      "INSERT INTO audit (at, actor, action, target, detail, user_id, workspace_id) VALUES (?1, ?2, 'client_error', NULL, ?3, ?4, ?5)",
    )
      .bind(
        nowS(),
        `user:${userOf(c)}`,
        JSON.stringify({ msg: String(b.msg ?? "").slice(0, 300), detail: b.detail ?? null }).slice(0, 2000),
        me(c).userId ?? null,
        me(c).workspaceId,
      )
      .run();
    return c.json({ ok: true });
  });
  // The media stores, for Settings (read-only: they're set up in the dashboard; no settings or secrets here).
  app.get("/app-api/media-stores", async (c) =>
    c.json({
      stores: (await storeRows(c.env.DB)).map((r) => ({
        kind: r.kind,
        default: r.isDefault,
        status: r.status,
        where: r.kind === "s3" ? String(r.settings.bucket ?? "") : null,
      })),
    }),
  );
  // ---- connecting accounts (Settings): admins and creators connect Instagram and YouTube with the instance's OAuth
  // apps, into their workspace. The provider sends the browser back to the dashboard's callback (the one redirect URL
  // registered in the app), which sends it on to the app's Settings (dashboard/routes.ts).
  const connector = (c: C) => {
    if (!c.get("connects")) throw new ops.ApiError(403, "only the workspace's admins and creators connect accounts");
  };
  app.get(
    "/app-api/connections",
    wrap(async (c) => {
      connector(c);
      const ws = me(c).workspaceId;
      const r = await c.env.DB.prepare(
        "SELECT id, provider, label, status, expires_at FROM connections WHERE workspace_id = ?1 ORDER BY provider, id",
      )
        .bind(ws)
        .all<{ id: string; provider: string; label: string | null; status: string; expires_at: number | null }>();
      const accounts = await listAccounts(c.env.DB, { workspaceId: ws, all: true });
      const apps = new Set(
        (await c.env.DB.prepare("SELECT id FROM oauth_apps").all<{ id: string }>()).results.map((x) => x.id),
      );
      return {
        connections: r.results.map((x) => ({
          ...x,
          accounts: accounts.filter((a) => a.connection?.id === x.id).map((a) => a.id),
        })),
        // what can be connected from here: the authorization flows; `ready` once the instance's OAuth app is added
        providers: connectSpecs()
          .filter((k) => k.kind === "oauth2" && k.app && k.authorizeUrl)
          .map((k) => ({ provider: k.provider, label: k.label, platform: k.platform, ready: apps.has(k.app ?? "") })),
      };
    }),
  );
  app.post(
    "/app-api/connect/:provider/start",
    wrap(async (c) => {
      connector(c);
      const b = await body(c);
      try {
        const flow = await startConnect(c.env, c.req.param("provider") ?? "", {
          userId: userOf(c),
          workspaceId: me(c).workspaceId,
          back: "app",
          reconnect: typeof b.reconnect === "string" ? b.reconnect : null,
          nowS: nowS(),
        });
        // only this browser can finish the flow at the dashboard's callback (core/connections.ts authorizeUrl)
        c.header("Set-Cookie", oauthCookie(flow.browser, flow.cookiePath), { append: true });
        return { url: flow.url };
      } catch (e) {
        if (e instanceof ConnectError) throw new ops.ApiError(400, e.message);
        throw e;
      }
    }),
  );
  // The stores the app can upload to (the default first): the upload page offers a choice when there are several.
  app.get("/app-api/uploads/enabled", async (c) => {
    const stores = await mediaStores(c.env, fetcher);
    const up = stores.uploadable.sort((a, b) => Number(b === stores.default) - Number(a === stores.default));
    return c.json({ enabled: up.length > 0, stores: up.map((s) => s.id) });
  });
  app.post(
    "/app-api/item/texts",
    owned(async (c) => {
      const b = await body(c);
      return editTexts(c.env, String(b.key ?? ""), b, nowS(), me(c).workspaceId, userOf(c));
    }),
  );

  app.post("/app-api/drafts/:id/refuse", async (c) => {
    const r = await c.env.DB.prepare(
      "UPDATE drafts SET status = 'refused', updated_at = ?1 WHERE id = ?2 AND status = 'draft' AND workspace_id = ?3 RETURNING id",
    )
      .bind(nowS(), c.req.param("id"), me(c).workspaceId)
      .first();
    if (!r) return c.json({ error: "no open draft" }, 404);
    await audit(c, "draft_refuse", c.req.param("id"), {});
    return c.json({ status: "refused" });
  });

  // The metrics series of an item (and its Trial Reel copy) or of a YouTube upload, for the charts.
  const metricsQuery = (c: C) => ({
    daily: c.req.query("daily") === "1" || c.req.query("daily") === "true",
    from: c.req.query("from"),
    to: c.req.query("to"),
  });
  app.get(
    "/app-api/item/metrics",
    wrap((c) => ops.itemMetrics(opctx(c), { key: c.req.query("key") ?? "", ...metricsQuery(c) })),
  );
  app.get(
    "/app-api/video/metrics",
    wrap((c) => ops.videoMetrics(opctx(c), { video: c.req.query("video") ?? "", ...metricsQuery(c) })),
  );

  // One item as it would be published, with short-lived links to preview its media.
  app.get("/app-api/item", async (c) => {
    const tz = await zone(c);
    const r = await resolveItem(c.env, fetcher, c.req.query("key") ?? "", tz, me(c).workspaceId);
    if (!r) return c.json({ error: "this item isn't in the plan any more" }, 404);
    const stores = await mediaStores(c.env, fetcher);
    const media = await Promise.all(
      r.media.map(async (m) => {
        const store = stores.for(m);
        return { ...m, url: store ? await preview(c, store, m) : null };
      }),
    );
    const p = r.posted ? await getPosted(c.env.DB, r.key) : null;
    const published = p ? { at: zoneStamp(p.published_at, tz), permalink: p.permalink } : null;
    // What the page shows: approve/options gets it back and refuses if the item changed since (nothing approved unseen).
    const fingerprint = await sha256Hex(JSON.stringify(await snapshot(r)));
    const ctx = opctx(c);
    const results = p ? await ops.results24h(ctx, r.key, p.published_at) : null;
    // The Trial Reel copy: the Reel's switch (default: its account's), then the copy's state once it's queued.
    const reel = r.postFormat === "video" || (r.postFormat === null && r.media.length === 1 && isVideo(r.media[0]));
    const plan = reel ? await getItem(c.env.DB, r.key, me(c).workspaceId) : null;
    const sw = plan ? await trialFor(c.env.DB, plan) : null;
    let trial: Record<string, unknown> | null = null;
    if (sw?.capable) {
      const [t, job] = await Promise.all([
        c.env.DB.prepare("SELECT permalink, published_at, at FROM trial_posts WHERE item_key = ?1")
          .bind(r.key)
          .first<{ permalink: string | null; published_at: number | null; at: number }>(),
        c.env.DB.prepare("SELECT state, last_error FROM jobs WHERE item_key = ?1")
          .bind(`trial:${r.key}`)
          .first<{ state: string; last_error: string | null }>(),
      ]);
      trial = {
        on: sw.on,
        byDefault: sw.byDefault,
        explicit: sw.explicit,
        state: t ? "published" : (job?.state ?? "planned"),
        error: job?.last_error ?? null,
        permalink: t?.permalink ?? null,
        at: t?.published_at != null ? zoneStamp(t.published_at, tz) : null,
        results: t ? await ops.results24h(ctx, `trial:${r.key}`, t.published_at ?? t.at) : null,
      };
    }
    // A failed job: approving again starts it over, unless its post may be live (tick.ts reopens()).
    const job = await c.env.DB.prepare(
      "SELECT state, last_error, media_id, payload FROM jobs WHERE item_key = ?1 AND workspace_id = ?2",
    )
      .bind(r.key, me(c).workspaceId)
      .first<{ state: string; last_error: string | null; media_id: string | null; payload: string }>();
    const failed =
      job?.state === "failed" ? { error: job.last_error, again: !mayBeLive(job, JSON.parse(job.payload)) } : null;
    return c.json({ ...r, media, published, fingerprint, results, trial, failed });
  });

  // Approve: options bind the passkey challenge to a snapshot of what was shown (the page's fingerprint must still match
  // the item); verify re-resolves and compares again.
  app.post("/app-api/approve/options", async (c) => {
    const b = await body(c);
    const key = String(b.key ?? "");
    const r = await resolveItem(c.env, fetcher, key, await zone(c), me(c).workspaceId);
    if (!r) return c.json({ error: "this item isn't in the plan any more" }, 404);
    if (r.problems.length) return c.json({ error: "can't approve yet", problems: r.problems }, 409);
    const snap = await snapshot(r);
    if (b.fingerprint !== undefined && b.fingerprint !== (await sha256Hex(JSON.stringify(snap))))
      return c.json(
        { error: "it changed since you opened it: check the new version, then approve", changed: true },
        409,
      );
    return c.json(await authenticationOptions(c.env.DB, c.env.RP_ID, "approve", snap, nowS(), userOf(c)));
  });

  app.post("/app-api/approve/verify", async (c) => {
    const b = await body(c);
    const v = await verifyAuthentication(
      c.env.DB,
      verifiers,
      c.env.RP_ID,
      origin(c),
      String(b.challengeId ?? ""),
      "approve",
      b.response as { id?: string },
      nowS(),
      userOf(c),
    );
    if (!v) return c.json({ error: "passkey check failed" }, 401);
    const shown = v.data as Snapshot;
    if (!shown || typeof shown.key !== "string") return c.json({ error: "passkey check failed" }, 401); // e.g. a resume challenge
    const r = await resolveItem(c.env, fetcher, shown.key, await zone(c), me(c).workspaceId);
    if (!r || r.problems.length)
      return c.json({ error: "the item can't be approved any more", problems: r?.problems ?? [] }, 409);
    const now = await snapshot(r);
    if (!sameSnapshot(shown, now))
      return c.json(
        { error: "it changed since you opened it: check the new version, then approve", changed: true },
        409,
      );
    await writeApproval(c.env, fetcher, r, now, new Date(), userOf(c), "owner@app");
    await audit(c, "approve", shown.key, { due_at: shown.dueAt, media: shown.media.length });
    return c.json({ approved: true, key: shown.key, due: r.due });
  });

  // Pause and resume the session's workspace (resume needs a passkey: no API key can do it).
  app.post(
    "/app-api/pause",
    wrap(async (c) => ops.pause(opctx(c), String((await body(c)).reason ?? "paused from the app"))),
  );
  // Resuming can release approved items at once, so it needs a fresh passkey assertion, like approving. The challenge
  // reuses the "approve" purpose, tagged { action: "resume" }; each verify route rejects the other's challenges.
  app.post("/app-api/resume/options", async (c) =>
    c.json(await authenticationOptions(c.env.DB, c.env.RP_ID, "approve", { action: "resume" }, nowS(), userOf(c))),
  );
  app.post("/app-api/resume/verify", async (c) => {
    const b = await body(c);
    const v = await verifyAuthentication(
      c.env.DB,
      verifiers,
      c.env.RP_ID,
      origin(c),
      String(b.challengeId ?? ""),
      "approve",
      b.response as { id?: string },
      nowS(),
      userOf(c),
    );
    if (!v || (v.data as { action?: string } | null)?.action !== "resume")
      return c.json({ error: "passkey check failed" }, 401);
    return c.json(await ops.resume(opctx(c)));
  });
  // Moving a scheduled YouTube video's release date needs a fresh passkey assertion too. The challenge binds the video
  // and the instant ({ action: "release", video, at }), so verify moves exactly what the owner confirmed.
  app.post(
    "/app-api/youtube/release/options",
    wrap(async (c) => {
      const b = await body(c);
      const video = String(b.video ?? "");
      if (!video) throw new ops.ApiError(400, "give the video id");
      let at: number | null | undefined;
      try {
        at = dueFrom({ date: b.date, time: b.time }, "video", await zone(c));
      } catch (e) {
        if (e instanceof WhenError) throw new ops.ApiError(400, e.message);
        throw e;
      }
      if (typeof at !== "number") throw new ops.ApiError(400, "give a date and time");
      return authenticationOptions(
        c.env.DB,
        c.env.RP_ID,
        "approve",
        { action: "release", video, at },
        nowS(),
        userOf(c),
      );
    }),
  );
  app.post("/app-api/youtube/release/verify", async (c) => {
    const b = await body(c);
    const v = await verifyAuthentication(
      c.env.DB,
      verifiers,
      c.env.RP_ID,
      origin(c),
      String(b.challengeId ?? ""),
      "approve",
      b.response as { id?: string },
      nowS(),
      userOf(c),
    );
    const bound = v?.data as { action?: string; video?: string; at?: number } | null | undefined;
    if (!v || bound?.action !== "release" || !bound.video || typeof bound.at !== "number")
      return c.json({ error: "passkey check failed" }, 401);
    const { video, at } = bound;
    try {
      return c.json(
        await moveRelease(c.env, fetcher, {
          workspaceId: me(c).workspaceId,
          videoId: video,
          at,
          nowS: nowS(),
          tz: await zone(c),
          actor: { kind: "owner", userId: userOf(c) },
        }),
      );
    } catch (e) {
      if (e instanceof ReleaseError) return c.json({ error: e.message }, releaseStatus(e) as 400);
      throw e;
    }
  });
  // Hold or release one item (no passkey: holding only stops it; the approval is kept, so releasing restores it).
  app.post(
    "/app-api/item/hold",
    wrap(async (c) => {
      const b = await body(c);
      return ops.planUpdate(opctx(c), { key: String(b.key ?? ""), hold: b.hold === true });
    }),
  );

  // The comments inbox: others' comments on the workspace's recent posts and Shorts, newest first, with the post's name.
  app.get("/app-api/comments", async (c) => {
    const r = await c.env.DB.prepare(
      `SELECT k.id, k.platform, k.account, k.media_id, k.item_key, k.author, k.text, k.at, k.seen, k.reply_text, k.replied_at,
              p.title, p.name, x.permalink
         FROM comments k LEFT JOIN plan_items p ON p.item_key = k.item_key LEFT JOIN posted x ON x.item_key = k.item_key
        WHERE k.own = 0 AND k.workspace_id = ?1 ORDER BY k.at DESC LIMIT 100`,
    )
      .bind(me(c).workspaceId)
      .all();
    return c.json({ comments: r.results });
  });
  app.get("/app-api/comments/unseen", async (c) =>
    c.json({
      n:
        (
          await c.env.DB.prepare("SELECT COUNT(*) AS n FROM comments WHERE own = 0 AND seen = 0 AND workspace_id = ?1")
            .bind(me(c).workspaceId)
            .first<{ n: number }>()
        )?.n ?? 0,
    }),
  );
  app.post("/app-api/comments/seen", async (c) => {
    await c.env.DB.prepare("UPDATE comments SET seen = 1 WHERE own = 0 AND seen = 0 AND workspace_id = ?1")
      .bind(me(c).workspaceId)
      .run();
    return c.json({ ok: true });
  });
  app.post("/app-api/comments/:id/reply", async (c) => {
    const text = String((await body(c)).text ?? "")
      .trim()
      .slice(0, 2000);
    if (!text) return c.json({ error: "write a reply first" }, 400);
    try {
      return c.json(await replyToComment(c.env, fetcher, c.req.param("id") ?? "", text, nowS(), me(c).workspaceId));
    } catch (e) {
      return c.json({ error: `the reply didn't go out: ${(e as Error).message}` }, 502);
    }
  });

  // A video's cover frame: ms into the video (Instagram's thumb_offset). Not part of the approval fingerprint,
  // like the location: it's a setting of the post, not its content.
  app.post(
    "/app-api/item/cover",
    wrap(async (c) => {
      const b = await body(c);
      const key = String(b.key ?? "");
      if (await isPosted(c.env.DB, key)) throw new ops.ApiError(409, "it was already published");
      const ms = b.ms === null ? null : Math.round(Number(b.ms));
      if (ms !== null && !(Number.isFinite(ms) && ms >= 0 && ms <= 15 * 60_000))
        throw new ops.ApiError(400, "ms: 0 to 15 minutes");
      if (!(await setOption(c, key, "coverMs", ms))) throw new ops.ApiError(404, `${key} isn't planned`);
      return { key, cover_ms: ms };
    }),
  );

  // The location from a pasted Instagram location link or a place id.
  // Trial Reels: one Reel's switch (true/false, or null for the account's default) and the account's default.
  app.post(
    "/app-api/item/trial",
    wrap(async (c) => {
      const b = await body(c);
      const key = String(b.key ?? "");
      if (await isPosted(c.env.DB, key)) throw new ops.ApiError(409, "it was already published");
      const on = b.on === null || b.on === undefined ? null : !!b.on;
      const r = await setOption(c, key, "trial", on);
      if (!r) throw new ops.ApiError(404, `${key} isn't planned`);
      await audit(c, "item_trial", key, { on });
      return { key, ...(await trialFor(c.env.DB, r)) };
    }),
  );
  app.post(
    "/app-api/item/location",
    wrap(async (c) => {
      const b = await body(c);
      const key = String(b.key ?? "");
      if (await isPosted(c.env.DB, key)) throw new ops.ApiError(409, "it was already published");
      const raw = String(b.location ?? "").trim();
      const id = raw ? (/\/explore\/locations\/(\d+)/.exec(raw)?.[1] ?? (/^\d{5,25}$/.test(raw) ? raw : null)) : null;
      if (raw && !id)
        throw new ops.ApiError(
          400,
          "paste an Instagram location link (instagram.com/explore/locations/…) or the place's number",
        );
      return ops.planUpdate(opctx(c), { key, location: id });
    }),
  );

  // The item's display name (the item page): only what the app shows; its key, files and approval are untouched.
  app.post(
    "/app-api/item/title",
    wrap(async (c) => {
      const b = await body(c);
      const key = String(b.key ?? "");
      const title =
        typeof b.title === "string" && b.title.trim() ? b.title.trim().replace(/\s+/g, " ").slice(0, 80) : null;
      const r = await c.env.DB.prepare(
        "UPDATE plan_items SET title = ?1, updated_at = ?3, updated_by = 'owner@app' WHERE item_key = ?2 AND workspace_id = ?4 RETURNING item_key",
      )
        .bind(title, key, nowS(), me(c).workspaceId)
        .first();
      if (!r) throw new ops.ApiError(404, `${key} isn't planned`);
      return { key, title };
    }),
  );

  // Change when an item goes out (the item page). Same rules as plan_update: one item per account per hour, and an
  // approved item needs approving again for the new time. A published item stays where it went out.
  app.post(
    "/app-api/item/reschedule",
    wrap(async (c) => {
      const b = await body(c);
      const key = String(b.key ?? "");
      if (await isPosted(c.env.DB, key)) throw new ops.ApiError(409, "it was already published");
      if (!b.date) throw new ops.ApiError(400, "pick a date");
      return ops.planUpdate(opctx(c), { key, date: String(b.date), time: b.time ? String(b.time) : null });
    }),
  );

  // Switch the app's session to another workspace the person can open (session.ts openWorkspace, creators included).
  app.post(
    "/app-api/session/workspace",
    wrap(async (c) => {
      // the app's session only: the dashboard's keeps its own workspace
      const token = readCookie(c.req.header("Cookie"));
      const id = String((await body(c)).id ?? "");
      // the session's user, with or without a workspace now: mayOpen decides where they may go
      const w = token && (await openWorkspace(c.env.DB, token, c.get("session").userId, id, nowS()));
      if (!w) throw new ops.ApiError(403, "you can't open that workspace");
      return { ok: true, id: w.id };
    }),
  );
  // The signed-in user's own time zone (null: the workspace's). Only how times are shown and entered changes: the
  // database keeps UTC, so nothing planned moves.
  app.post(
    "/app-api/me/timezone",
    wrap(async (c) => {
      const tz = (await body(c)).timezone;
      try {
        await setUserZone(c.env.DB, userOf(c), tz ? String(tz) : null);
      } catch (e) {
        throw new ops.ApiError(400, (e as Error).message);
      }
      await audit(c, "user_timezone", userOf(c), { timezone: tz ?? null });
      return { timezone: await zone(c), workspaceTimezone: await workspaceZone(c.env.DB, me(c).workspaceId) };
    }),
  );

  // Web Push subscriptions for this device: they belong to the signed-in user, in no particular workspace (each
  // workspace's notes reach the members it should, core/push.ts), and only a browser push service's endpoint is taken
  // (Bongsu sends requests to it).
  app.post("/app-api/push/subscribe", async (c) => {
    const b = (await body(c)) as { endpoint?: string; keys?: { p256dh?: string; auth?: string }; device?: string };
    const key = (v: unknown) => typeof v === "string" && /^[A-Za-z0-9_=-]{8,200}$/.test(v);
    if (typeof b.endpoint !== "string" || b.endpoint.length > 1000 || !isPushEndpoint(b.endpoint))
      return c.json({ error: "not a browser push service's address" }, 400);
    if (!key(b.keys?.p256dh) || !key(b.keys?.auth)) return c.json({ error: "bad subscription" }, 400);
    const { userId } = me(c);
    if (!userId) return c.json({ error: "sign in" }, 401);
    // the same device signed in as someone else moves to them
    await c.env.DB.prepare(
      `INSERT INTO push_subs (endpoint, p256dh, auth, device, created_at, user_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT (endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, device = excluded.device,
         user_id = excluded.user_id`,
    )
      .bind(b.endpoint, b.keys!.p256dh, b.keys!.auth, String(b.device ?? "").slice(0, 80) || null, nowS(), userId)
      .run();
    return c.json({ subscribed: true });
  });
  // A test to the caller's own devices only, whatever their notification settings.
  app.post("/app-api/push/test", async (c) => {
    const { userId } = me(c);
    if (!userId) return c.json({ error: "sign in" }, 401);
    return c.json(
      await sendPush(
        c.env,
        fetcher,
        { title: "Bongsu", body: "Push notifications work on this device.", url: "/#/settings" },
        nowS(),
        { userId },
      ),
    );
  });

  // The signed-in person's own notification groups in the session's workspace (core/notify-prefs.ts): what they
  // changed from their role's defaults. A person's own settings, so no scope; an agent key never reaches /app-api.
  const prefsFor = async (c: C) => {
    const { workspaceId } = me(c);
    const where = await sessionWorkspace(c.env.DB, c.get("session"));
    if (!where?.role) return c.json({ error: "you're not a member of any workspace", noWorkspace: true }, 403);
    return { workspaceId, userId: userOf(c), role: where.role };
  };
  app.get("/app-api/notify-prefs", async (c) => {
    const who = await prefsFor(c);
    if (who instanceof Response) return who;
    return c.json({ groups: await effectivePrefs(c.env.DB, who.workspaceId, who.userId, who.role) });
  });
  app.put("/app-api/notify-prefs", async (c) => {
    const who = await prefsFor(c);
    if (who instanceof Response) return who;
    const b = await body(c);
    if (!isNoteGroup(b.grp)) return c.json({ error: "unknown group" }, 400);
    if (typeof b.enabled !== "boolean") return c.json({ error: "enabled is true or false" }, 400);
    await setPref(c.env.DB, who.workspaceId, who.userId, who.role, b.grp, b.enabled, nowS());
    return c.json({ groups: await effectivePrefs(c.env.DB, who.workspaceId, who.userId, who.role) });
  });

  return app;
}
