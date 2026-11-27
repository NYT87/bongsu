// Setting up the media stores (the dashboard's Media page for the instance's, a workspace's own in the app;
// docs/media-stores.md): save one (its settings, its credentials encrypted), test it before saving, make it the
// default of its scope, remove it (the instance's: with how many waiting approvals that voids; a workspace's: refused
// while an approved item uses it), connect Google Drive with the owner's Google app, and check every store weekly in
// the inbox's cron run.

import { BudgetSpent, canAfford, noteFetch, type StepDeps } from "../budget";
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
import { sessionWorkspace, workspaceSettings } from "../workspaces";
import { DRIVE_SCOPE, DriveStore } from "./drive";
import { mediaPath } from "./folders";
import { buildStore, offeredKinds, type StoreKind, type StoreScope, storeId, storeRows } from "./index";
import type { S3Settings } from "./s3";
import type { MediaStore } from "./store";

/** The oauth_states flow name of Connect Google Drive. */
const DRIVE_FLOW = "media:drive";
const GOOGLE_AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
/** How often each store is checked (a revoked Drive grant, a bucket key that stopped working). */
export const CHECK_EVERY_S = 7 * 86400;
/** The most calls one store's check makes: a Drive token and a walk to the media folder (two levels), or an S3
 *  object read and a listing. */
export const STORES_UNIT_CALLS = 3;

export class StoreError extends Error {}

// ---- what the dashboard sends

/** Names only a private network resolves (or this machine): a workspace's bucket isn't at one. */
const PRIVATE_NAME = /(^|\.)(localhost|local|internal|lan|localdomain|home\.arpa)$/;

/** Why a workspace's bucket can't be at this host, or null. A workspace admin's Test and save make the server send
 *  signed requests there and report how they went, so they only reach a public name over https: not an IP address
 *  (the URL parser writes every IPv4 form as dotted quads, IPv6 in brackets), not localhost, not a one-label or
 *  private network's name. The instance admins run the server, so their endpoints aren't limited. */
function workspaceEndpointProblem(u: URL): string | null {
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (u.protocol !== "https:") return "a workspace's bucket is reached over https://";
  if (host.startsWith("[") || /^\d+(\.\d+){3}$/.test(host))
    return "a workspace's bucket is reached by its name, not an IP address";
  if (!host.includes(".") || PRIVATE_NAME.test(host))
    return "a workspace's bucket is at a public address, not localhost or a private network's name";
  return null;
}

/** An S3 store's settings from the form, checked: nothing else is kept. A workspace's own (`scope`) is only reached
 *  at a public https address (workspaceEndpointProblem). */
export function s3Settings(b: Record<string, unknown>, scope: StoreScope = { workspaceId: null }): S3Settings {
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
  const problem = scope.workspaceId === null ? null : workspaceEndpointProblem(u);
  if (problem) throw new StoreError(problem);
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

/** The media folders a scope's stores hold: the workspace's own; for the instance's, every active workspace's (any
 *  of them can use the instance's stores). */
async function scopeFolders(env: Env, scope: StoreScope): Promise<string[]> {
  if (scope.workspaceId) return [(await workspaceSettings(env.DB, scope.workspaceId)).mediaFolder];
  const r = await env.DB.prepare(
    `SELECT s.media_folder FROM workspaces w JOIN workspace_settings s ON s.workspace_id = w.id
     WHERE w.archived_at IS NULL ORDER BY w.id`,
  ).all<{ media_folder: string | null }>();
  return r.results.map((x) => x.media_folder).filter((f): f is string => !!f);
}

/** Makes <folder>/inbox in the store for each folder (the workspace's folder too, when missing), so files can be
 *  dropped in right away and reading and writing both work. */
async function makeFolders(store: MediaStore, folders: string[]): Promise<void> {
  // shortcut: one request makes every workspace's folders (about 4 Drive calls each); past ~10 new workspaces the
  // free plan's 50 calls per request run out, so make them over several requests then
  for (const folder of folders) {
    const inbox = mediaPath(folder, "inbox");
    if (!(await store.resolve(inbox))) await store.ensureFolder(inbox);
  }
}

/** What Test does with settings before they're saved: makes the inbox of every workspace folder the store holds
 *  (scopeFolders), so reading and writing both work. With no workspace, the store is only built. */
export async function testStore(
  env: Env,
  fetcher: typeof fetch,
  kind: StoreKind,
  settings: Record<string, unknown>,
  credentials: string | null,
  scope: StoreScope = { workspaceId: null },
): Promise<{ ok: boolean; error: string | null }> {
  try {
    // checked again here, whoever calls: the routes do, but a workspace's bucket must never reach a private address
    if (kind === "s3" && scope.workspaceId !== null) s3Settings(settings, scope);
    const store = buildStore(env, fetcher, kind, settings, credentials, storeId(kind, scope.workspaceId));
    await makeFolders(store, await scopeFolders(env, scope));
    return { ok: true, error: null };
  } catch (e) {
    return { ok: false, error: (e as Error).message.slice(0, 300) };
  }
}

/** A workspace's folder (and its inbox) in the stores it uses: its own and the instance's, when it's made or its
 *  folder changes. Best effort: a store that fails is named in the answer, and the folder is made again on first use. */
export async function makeWorkspaceFolders(
  env: Env,
  fetcher: typeof fetch,
  workspaceId: string,
): Promise<{ failed: string[] }> {
  const folder = (await workspaceSettings(env.DB, workspaceId)).mediaFolder;
  const failed: string[] = [];
  for (const r of await storeRows(env.DB, { workspaceId })) {
    try {
      const creds = r.credentials ? await decryptSecret(env.ENCRYPTION_KEY, r.credentials) : null;
      await makeFolders(buildStore(env, fetcher, r.kind, r.settings, creds, r.id), [folder]);
    } catch (e) {
      failed.push(`${r.kind}: ${(e as Error).message.slice(0, 200)}`);
    }
  }
  return { failed };
}

/** The saved credentials of a store, decrypted (null when it has none). */
export async function savedCredentials(env: Env, scope: StoreScope, kind: StoreKind): Promise<string | null> {
  const id = storeId(kind, scope.workspaceId);
  const row = (await storeRows(env.DB)).find((r) => r.id === id);
  return row?.credentials ? decryptSecret(env.ENCRYPTION_KEY, row.credentials) : null;
}

/** The saved settings of a store ({} when it isn't set up): Drive's root folder, a bucket's endpoint. */
export async function savedSettings(env: Env, scope: StoreScope, kind: StoreKind): Promise<Record<string, unknown>> {
  const id = storeId(kind, scope.workspaceId);
  return (await storeRows(env.DB)).find((r) => r.id === id)?.settings ?? {};
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

/** A workspace uses the instance's default again: none of its own stores is marked as its default (they stay set up,
 *  and the files that name them still resolve). */
export async function useInstanceDefault(env: Env, workspaceId: string, nowS: number) {
  await env.DB.prepare(
    "UPDATE media_store SET is_default = 0, updated_at = ?1 WHERE workspace_id = ?2 AND is_default = 1",
  )
    .bind(nowS, workspaceId)
    .run();
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

/** A root folder as typed in the dashboard (a name at the top of My Drive, a folder's link or id), trimmed. Required:
 *  without one, the workspaces' folders would land at the top of My Drive, among everything else there. */
export function rootInput(v: unknown): string {
  const r = String(v ?? "").trim();
  if (!r) throw new StoreError("type the root folder: a folder's name at the top of My Drive, or its link");
  if (r.length > 300 || [...r].some((ch) => ch < " "))
    throw new StoreError("the root folder: a folder's name or its link");
  return r;
}

/** Drive's settings for a root folder as typed (rootInput), found with the grant. */
async function driveSettings(env: Env, fetcher: typeof fetch, grant: string, root: string, id: string) {
  const store = new DriveStore({ oauth: grant, fetch: fetcher, db: env.DB, id });
  try {
    return { root: await store.findRoot(root) };
  } catch (e) {
    throw new StoreError(`the root folder: ${(e as Error).message}`);
  }
}

/** Starts Connect Google Drive: the Google app YouTube uses (a workspace's own, else the instance's), scope drive, a
 *  refresh token. `workspaceId` null connects the instance's Drive store, a workspace's its own. `root` is the root
 *  folder as typed (rootInput); undefined keeps the store's, so only a Drive already connected can leave it out (one
 *  connected before root folders keeps working without one until a root is saved). */
export async function startDriveConnect(
  env: Env,
  userId: string,
  workspaceId: string | null,
  nowS: number,
  root?: string,
): Promise<StartedFlow> {
  if (!offeredKinds().includes("drive")) throw new StoreError("this server doesn't offer Google Drive");
  if (root === undefined && !(await ownRows(env, { workspaceId })).some((r) => r.kind === "drive"))
    throw new StoreError("type the root folder: a folder's name at the top of My Drive, or its link");
  const app = await oauthApp(env, "google", driveRedirectUri(env.PUBLIC_URL), { workspaceId });
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
    {
      flow: DRIVE_FLOW,
      userId,
      workspaceId,
      connectionId: null,
      nowS,
      ...(root === undefined ? {} : { settings: { root } }),
    },
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
  // a failure from here on says whose flow it was, so the callback sends the person back to the right page
  try {
    // a workspace's own Drive is for its admins (an instance admin counts as one): re-checked, as finishConnect does
    if (st.workspaceId) {
      const where = await sessionWorkspace(env.DB, { userId: st.userId, workspaceId: st.workspaceId });
      if (where?.workspaceId !== st.workspaceId || where.role !== "admin")
        throw new ConnectError("only the workspace's admins connect its Google Drive (or it was archived)");
    }
    const app = await oauthApp(env, "google", driveRedirectUri(env.PUBLIC_URL), {
      workspaceId: st.workspaceId,
      scope: st.appScope ?? "instance",
    });
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
    const scope = { workspaceId: st.workspaceId };
    const id = storeId("drive", st.workspaceId);
    // the root typed at the start, found with the new grant; none typed: connecting again keeps the store's
    const settings =
      typeof st.settings.root === "string"
        ? await driveSettings(env, fetcher, grant, st.settings.root, id)
        : ((await ownRows(env, scope)).find((r) => r.id === id)?.settings ?? {});
    await saveStore(env, fetcher, scope, "drive", settings, grant, st.userId, nowS);
  } catch (e) {
    if (e instanceof Error) Object.assign(e, { workspaceId: st.workspaceId });
    throw e;
  }
  return { userId: st.userId, workspaceId: st.workspaceId };
}

/** Changes a connected Drive's root folder (rootInput): found with the saved grant, then saved as any
 *  store is, after making every workspace folder it holds in the new root. Files already in the old root stay there. */
export async function saveDriveRoot(
  env: Env,
  fetcher: typeof fetch,
  scope: StoreScope,
  root: string,
  userId: string,
  nowS: number,
): Promise<Record<string, unknown>> {
  const grant = await savedCredentials(env, scope, "drive");
  if (!grant) throw new StoreError("connect Google Drive first");
  const settings = await driveSettings(env, fetcher, grant, root, storeId("drive", scope.workspaceId));
  await saveStore(env, fetcher, scope, "drive", settings, grant, userId, nowS);
  return settings;
}

// ---- the weekly check

/** Each store, weekly (in the inbox's cron run): it still answers, or it's marked broken and its owner is told once:
 *  the instance admins for the instance's stores, the workspace's people for its own.
 *  Answering means the media folder of a workspace that uses it can be looked up: the store's own workspace, or for
 *  an instance store the first workspace not archived (none: the store is only built). A folder not made yet is
 *  fine; a request that fails is not. */
export async function checkStores(env: Env, deps: StepDeps): Promise<{ checked: string[]; broken: string[] }> {
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
    // out of calls for this run: the rest are still due next run
    if (!canAfford(deps, STORES_UNIT_CALLS)) break;
    let error: string | null = null;
    try {
      const creds = r.credentials ? await decryptSecret(env.ENCRYPTION_KEY, r.credentials) : null;
      const store = buildStore(env, deps.fetch, r.kind, r.settings, creds, r.id);
      const ws = r.workspaceId ?? firstActive?.id;
      if (ws) await store.resolve(mediaPath((await workspaceSettings(env.DB, ws)).mediaFolder));
    } catch (e) {
      // the run's calls, not the store, ran out: it isn't marked, and the problems found so far are still told
      if (e instanceof BudgetSpent) break;
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
  if (instance.length) await notifyInstanceAdmins(env, noteFetch(deps), mediaStoreProblem(instance.join("\n")), nowS);
  const notify = notifier(env, noteFetch(deps), nowS);
  for (const [workspaceId, lines] of byWorkspace)
    await notify.send(mediaStoreProblem(lines.join("\n"), true), workspaceId);
  return out;
}
