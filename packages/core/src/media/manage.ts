// Setting up the media stores (the dashboard's Media page for the instance's, a workspace's own in the app;
// docs/media-stores.md): save one (its settings, its credentials encrypted), test it before saving, make it the
// default of its scope, remove it (the instance's: with how many waiting approvals that voids; a workspace's: refused
// while an approved item uses it), connect Google Drive with the owner's Google app, and check every store weekly in
// the inbox's cron run.
import {
  authorizeUrl,
  type CallbackQuery,
  ConnectError,
  driveRedirectUri,
  oauthApp,
  type StartedFlow,
  takeState,
} from "../connections";
import { decryptSecret, encryptSecret } from "../crypto";
import type { Env } from "../env";
import { notifier, notifyInstanceAdmins } from "../notify";
import { mediaStoreProblem } from "../texts/notifications";
import { workspaceSettings } from "../workspaces";
import { DRIVE_SCOPE } from "./drive";
import { mediaPath } from "./folders";
import { buildStore, offeredKinds, type StoreKind, type StoreScope, storeId, storeRows } from "./index";
import type { S3Settings } from "./s3";

/** The oauth_states flow name of Connect Google Drive. */
const DRIVE_FLOW = "media:drive";
const GOOGLE_AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
/** How often each store is checked (a revoked Drive grant, a bucket key that stopped working). */
export const CHECK_EVERY_S = 7 * 86400;

export class StoreError extends Error {}

// ---- what the dashboard sends

/** An S3 store's settings from the form, checked: nothing else is kept. */
export function s3Settings(b: Record<string, unknown>): S3Settings {
  const endpoint = String(b.endpoint ?? "").trim();
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    throw new StoreError(
      "the endpoint is a URL: https://s3.eu-west-1.amazonaws.com, https://<account>.r2.cloudflarestorage.com…",
    );
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new StoreError("the endpoint starts with https://");
  if (u.search || u.hash || u.username) throw new StoreError("the endpoint is the service's address only");
  const bucket = String(b.bucket ?? "").trim();
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket))
    throw new StoreError("the bucket name: 3–63 lowercase letters, digits, dots and dashes");
  const region = String(b.region ?? "").trim() || "auto";
  if (!/^[a-z0-9-]{2,30}$/.test(region)) throw new StoreError("the region: like eu-west-1, or auto");
  const prefix = String(b.prefix ?? "")
    .trim()
    .replace(/^\/+|\/+$/g, "");
  if (prefix.length > 200 || !/^[A-Za-z0-9._/ -]*$/.test(prefix) || /(^|\/)\.\.?(\/|$)/.test(prefix))
    throw new StoreError("the prefix: a folder path like bongsu/");
  return { endpoint: `${u.origin}${u.pathname.replace(/\/+$/, "")}`, region, bucket, prefix, pathStyle: !!b.pathStyle };
}

/** The bucket's keys from the form; null when both are left empty (keep the saved ones). */
export function s3Credentials(b: Record<string, unknown>): string | null {
  const accessKeyId = String(b.accessKeyId ?? "").trim();
  const secretAccessKey = String(b.secretAccessKey ?? "").trim();
  if (!accessKeyId && !secretAccessKey) return null;
  if (!accessKeyId || !secretAccessKey) throw new StoreError("paste both the access key id and the secret");
  return JSON.stringify({ accessKeyId, secretAccessKey });
}

// ---- testing, saving, removing

/** The folder a scope's stores are tested in: the workspace's own media folder, UPLOADS for the instance's. */
async function testFolder(env: Env, scope: StoreScope): Promise<string> {
  return scope.workspaceId === null ? "UPLOADS" : (await workspaceSettings(env.DB, scope.workspaceId)).mediaFolder;
}

/** What Test does with settings before they're saved: find (or make) <folder>/inbox, so reading and writing both
 *  work. */
export async function testStore(
  env: Env,
  fetcher: typeof fetch,
  kind: StoreKind,
  settings: Record<string, unknown>,
  credentials: string | null,
  scope: StoreScope = { workspaceId: null },
): Promise<{ ok: boolean; error: string | null }> {
  try {
    const store = buildStore(env, fetcher, kind, settings, credentials, storeId(kind, scope.workspaceId));
    const inbox = mediaPath(await testFolder(env, scope), "inbox");
    if (!(await store.resolve(inbox))) await store.ensureFolder(inbox);
    if (!(await store.resolve(inbox))) return { ok: false, error: `${inbox} can't be found after making it` };
    return { ok: true, error: null };
  } catch (e) {
    return { ok: false, error: (e as Error).message.slice(0, 300) };
  }
}

/** The saved credentials of a store, decrypted (null when it has none). */
export async function savedCredentials(env: Env, scope: StoreScope, kind: StoreKind): Promise<string | null> {
  const id = storeId(kind, scope.workspaceId);
  const row = (await storeRows(env.DB)).find((r) => r.id === id);
  return row?.credentials ? decryptSecret(env.ENCRYPTION_KEY, row.credentials) : null;
}

/** The rows of exactly one scope (not the instance's too, as storeRows gives a workspace). */
const ownRows = async (env: Env, scope: StoreScope) =>
  (await storeRows(env.DB, scope)).filter((r) => r.workspaceId === scope.workspaceId);

/** Saves a store (tested first: a store that doesn't answer isn't saved). The first store of a scope becomes its
 *  default. */
export async function saveStore(
  env: Env,
  fetcher: typeof fetch,
  scope: StoreScope,
  kind: StoreKind,
  settings: Record<string, unknown>,
  credentials: string | null,
  userId: string,
  nowS: number,
): Promise<{ ok: true }> {
  if (!offeredKinds().includes(kind)) throw new StoreError(`this server doesn't offer the ${kind} store`);
  if (scope.workspaceId !== null && kind === "local")
    throw new StoreError("a workspace's own store is a bucket or a Drive, not the server's disk");
  const t = await testStore(env, fetcher, kind, settings, credentials, scope);
  if (!t.ok) throw new StoreError(`the store didn't answer as it should: ${t.error}`);
  const first = !(await ownRows(env, scope)).length;
  await env.DB.prepare(
    `INSERT INTO media_store (id, kind, workspace_id, is_default, settings, credentials, status, last_error, last_checked_at, updated_at, updated_by)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'ok', NULL, ?7, ?7, ?8)
     ON CONFLICT (id) DO UPDATE SET settings = excluded.settings, credentials = excluded.credentials, status = 'ok',
       last_error = NULL, last_checked_at = excluded.last_checked_at, updated_at = excluded.updated_at,
       updated_by = excluded.updated_by`,
  )
    .bind(
      storeId(kind, scope.workspaceId),
      kind,
      scope.workspaceId,
      first ? 1 : 0,
      JSON.stringify(settings),
      credentials ? await encryptSecret(env.ENCRYPTION_KEY, credentials) : null,
      nowS,
      userId,
    )
    .run();
  return { ok: true };
}

/** Makes a store the default of its scope; the other scopes' defaults stay. */
export async function setDefaultStore(env: Env, scope: StoreScope, kind: StoreKind, nowS: number) {
  const id = storeId(kind, scope.workspaceId);
  if (!(await ownRows(env, scope)).some((r) => r.id === id)) throw new StoreError(`no ${kind} store is set up`);
  const inScope = scope.workspaceId === null ? "workspace_id IS NULL" : "workspace_id = ?3";
  const bind = (sql: string, ...v: unknown[]) =>
    env.DB.prepare(sql).bind(...v, ...(scope.workspaceId === null ? [] : [scope.workspaceId]));
  await env.DB.batch([
    bind(
      `UPDATE media_store SET is_default = 0, updated_at = ?1 WHERE is_default = 1 AND id != ?2 AND ${inScope}`,
      nowS,
      id,
    ),
    bind(`UPDATE media_store SET is_default = 1, updated_at = ?1 WHERE id = ?2 AND ${inScope}`, nowS, id),
  ]);
}

/** The latest approvals of items not published yet whose media are in a store (by id): what removing it voids. */
async function approvalsIn(env: Env, id: string): Promise<string[]> {
  const r = await env.DB.prepare(
    `SELECT DISTINCT a.item_key FROM approvals a
     WHERE a.media LIKE ?1 AND NOT EXISTS (SELECT 1 FROM posted p WHERE p.item_key = a.item_key)
       AND a.id = (SELECT MAX(b.id) FROM approvals b WHERE b.item_key = a.item_key)
     ORDER BY a.item_key`,
  )
    .bind(`%"store":"${id}"%`)
    .all<{ item_key: string }>();
  return r.results.map((x) => x.item_key);
}

/** How many approvals of items not published yet have media in the store: what removing it voids. */
export async function waitingApprovalsIn(env: Env, id: string): Promise<number> {
  return (await approvalsIn(env, id)).length;
}

/** Removes a store (its files then count as missing); the scope's default moves to another of its stores if there is
 *  one. A workspace's own store isn't removed while an approved item uses it (the instance's: the owner is told how
 *  many approvals it voids, waitingApprovalsIn). */
export async function removeStore(env: Env, scope: StoreScope, kind: StoreKind, nowS: number) {
  const id = storeId(kind, scope.workspaceId);
  const rows = await ownRows(env, scope);
  const row = rows.find((r) => r.id === id);
  if (!row) throw new StoreError(`no ${kind} store is set up`);
  if (scope.workspaceId !== null) {
    const keys = await approvalsIn(env, id);
    if (keys.length) throw new StoreError(`${keys.length} approved items use this store: ${keys.join(", ")}`);
  }
  await env.DB.prepare("DELETE FROM media_store WHERE id = ?1").bind(id).run();
  const next = rows.find((r) => r.id !== id);
  if (row.isDefault && next) await setDefaultStore(env, scope, next.kind, nowS);
  // the folder ids remembered for it (its inboxes, Drive's upload folders) belong to the old store
  await env.DB.prepare("DELETE FROM settings WHERE key = ?1 OR key LIKE ?2 OR key LIKE ?3")
    .bind(`inbox_folder:${id}`, `inbox_folder:${id}:%`, `drive_upload_folder:${id}:%`)
    .run();
}

// ---- Connect Google Drive

/** Starts Connect Google Drive: the owner's Google app (the one YouTube uses), scope drive, a refresh token. */
export async function startDriveConnect(env: Env, userId: string, nowS: number): Promise<StartedFlow> {
  if (!offeredKinds().includes("drive")) throw new StoreError("this server doesn't offer Google Drive");
  const app = await oauthApp(env, "google", driveRedirectUri(env.PUBLIC_URL));
  return authorizeUrl(
    env,
    {
      authorizeUrl: GOOGLE_AUTHORIZE,
      scopes: [DRIVE_SCOPE],
      pkce: true,
      // a refresh token every time, so connecting again replaces it
      authorizeParams: { access_type: "offline", prompt: "consent" },
    },
    app,
    { flow: DRIVE_FLOW, userId, workspaceId: null, connectionId: null, nowS },
  );
}

/** Google's redirect back, in the browser that started the flow (`browser`: its cookie): the code becomes the Drive
 *  store's grant (saved after testing it). */
export async function finishDriveConnect(
  env: Env,
  fetcher: typeof fetch,
  q: CallbackQuery,
  browser: string | null,
  nowS: number,
) {
  const st = await takeState(env, DRIVE_FLOW, q, browser, nowS);
  const app = await oauthApp(env, "google", driveRedirectUri(env.PUBLIC_URL));
  const r = await fetcher(GOOGLE_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: st.code,
      client_id: app.clientId,
      client_secret: app.clientSecret,
      redirect_uri: app.redirectUri,
      grant_type: "authorization_code",
      ...(st.verifier ? { code_verifier: st.verifier } : {}),
    }),
  });
  const j = (await r.json().catch(() => ({}))) as {
    refresh_token?: string;
    scope?: string;
    error?: string;
    error_description?: string;
  };
  if (!r.ok)
    throw new ConnectError(
      `Google refused the code: ${j.error_description ?? j.error ?? `HTTP ${r.status}`}`.slice(0, 300),
    );
  if (!j.refresh_token)
    throw new ConnectError(
      "Google returned no refresh token: remove Bongsu's access in your Google account and connect again",
    );
  if (j.scope && !j.scope.split(" ").includes(DRIVE_SCOPE))
    throw new ConnectError("Google didn't grant access to Drive: connect again and allow it");
  const grant = JSON.stringify({
    client_id: app.clientId,
    client_secret: app.clientSecret,
    refresh_token: j.refresh_token,
    token_uri: GOOGLE_TOKEN,
  });
  await saveStore(env, fetcher, { workspaceId: null }, "drive", {}, grant, st.userId, nowS);
  return { userId: st.userId };
}

// ---- the weekly check

/** Each store, weekly (in the inbox's cron run): it still answers, or it's marked broken and its owner is told once:
 *  the instance admins for the instance's stores, the workspace's people for its own.
 *  Answering means the media folder of a workspace that uses it can be looked up: the store's own workspace, or for
 *  an instance store the first workspace not archived (none: the store is only built). A folder not made yet is
 *  fine; a request that fails is not. */
export async function checkStores(
  env: Env,
  deps: { fetch: typeof fetch; now: Date },
): Promise<{ checked: string[]; broken: string[] }> {
  const nowS = Math.floor(deps.now.getTime() / 1000);
  const out = { checked: [] as string[], broken: [] as string[] };
  const instance: string[] = [];
  const byWorkspace = new Map<string, string[]>();
  const firstActive = await env.DB.prepare(
    "SELECT id FROM workspaces WHERE archived_at IS NULL ORDER BY id LIMIT 1",
  ).first<{
    id: string;
  }>();
  for (const r of await storeRows(env.DB)) {
    if (r.lastCheckedAt !== null && r.lastCheckedAt > nowS - CHECK_EVERY_S) continue;
    let error: string | null = null;
    try {
      const creds = r.credentials ? await decryptSecret(env.ENCRYPTION_KEY, r.credentials) : null;
      const store = buildStore(env, deps.fetch, r.kind, r.settings, creds, r.id);
      const ws = r.workspaceId ?? firstActive?.id;
      if (ws) await store.resolve(mediaPath((await workspaceSettings(env.DB, ws)).mediaFolder));
    } catch (e) {
      error = (e as Error).message.slice(0, 300);
    }
    await env.DB.prepare("UPDATE media_store SET status = ?1, last_error = ?2, last_checked_at = ?3 WHERE id = ?4")
      .bind(error ? "broken" : "ok", error, nowS, r.id)
      .run();
    (error ? out.broken : out.checked).push(r.id);
    if (error && r.status !== "broken") {
      const line = `${r.kind}: ${error}`;
      if (r.workspaceId === null) instance.push(line);
      else byWorkspace.set(r.workspaceId, [...(byWorkspace.get(r.workspaceId) ?? []), line]);
    }
  }
  if (instance.length) await notifyInstanceAdmins(env, deps.fetch, mediaStoreProblem(instance.join("\n")), nowS);
  const notify = notifier(env, deps.fetch, nowS);
  for (const [workspaceId, lines] of byWorkspace) await notify.send(mediaStoreProblem(lines.join("\n")), workspaceId);
  return out;
}
