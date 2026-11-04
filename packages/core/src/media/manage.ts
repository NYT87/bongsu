// Setting up the media stores (the dashboard's Media page; docs/media-stores.md): save one (its settings, its
// credentials encrypted), test it before saving, make it the default, remove it (with how many waiting approvals that
// voids), connect Google Drive with the owner's Google app, and check every store weekly in the inbox's cron run.
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
import { notifyInstanceAdmins } from "../notify";
import { mediaStoreProblem } from "../texts/notifications";
import { DRIVE_SCOPE } from "./drive";
import { buildStore, offeredKinds, type StoreKind, storeRows } from "./index";
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

/** What Test does with settings before they're saved: find (or make) UPLOADS/inbox, so reading and writing both work. */
export async function testStore(
  env: Env,
  fetcher: typeof fetch,
  kind: StoreKind,
  settings: Record<string, unknown>,
  credentials: string | null,
): Promise<{ ok: boolean; error: string | null }> {
  try {
    const store = buildStore(env, fetcher, kind, settings, credentials);
    if (!(await store.resolve("UPLOADS/inbox"))) await store.ensureFolder("UPLOADS/inbox");
    if (!(await store.resolve("UPLOADS/inbox")))
      return { ok: false, error: "UPLOADS/inbox can't be found after making it" };
    return { ok: true, error: null };
  } catch (e) {
    return { ok: false, error: (e as Error).message.slice(0, 300) };
  }
}

/** The saved credentials of a store, decrypted (null when it has none). */
export async function savedCredentials(env: Env, kind: StoreKind): Promise<string | null> {
  const row = (await storeRows(env.DB)).find((r) => r.kind === kind);
  return row?.credentials ? decryptSecret(env.ENCRYPTION_KEY, row.credentials) : null;
}

/** Saves a store (tested first: a store that doesn't answer isn't saved). The first store becomes the default. */
export async function saveStore(
  env: Env,
  fetcher: typeof fetch,
  kind: StoreKind,
  settings: Record<string, unknown>,
  credentials: string | null,
  userId: string,
  nowS: number,
): Promise<{ ok: true }> {
  if (!offeredKinds().includes(kind)) throw new StoreError(`this server doesn't offer the ${kind} store`);
  const t = await testStore(env, fetcher, kind, settings, credentials);
  if (!t.ok) throw new StoreError(`the store didn't answer as it should: ${t.error}`);
  const first = !(await storeRows(env.DB)).length;
  await env.DB.prepare(
    `INSERT INTO media_store (kind, is_default, settings, credentials, status, last_error, last_checked_at, updated_at, updated_by)
     VALUES (?1, ?2, ?3, ?4, 'ok', NULL, ?5, ?5, ?6)
     ON CONFLICT (kind) DO UPDATE SET settings = excluded.settings, credentials = excluded.credentials, status = 'ok',
       last_error = NULL, last_checked_at = excluded.last_checked_at, updated_at = excluded.updated_at,
       updated_by = excluded.updated_by`,
  )
    .bind(
      kind,
      first ? 1 : 0,
      JSON.stringify(settings),
      credentials ? await encryptSecret(env.ENCRYPTION_KEY, credentials) : null,
      nowS,
      userId,
    )
    .run();
  return { ok: true };
}

export async function setDefaultStore(env: Env, kind: StoreKind, nowS: number) {
  if (!(await storeRows(env.DB)).some((r) => r.kind === kind)) throw new StoreError(`no ${kind} store is set up`);
  await env.DB.batch([
    env.DB.prepare("UPDATE media_store SET is_default = 0, updated_at = ?1 WHERE is_default = 1 AND kind != ?2").bind(
      nowS,
      kind,
    ),
    env.DB.prepare("UPDATE media_store SET is_default = 1, updated_at = ?1 WHERE kind = ?2").bind(nowS, kind),
  ]);
}

/** The workspace a store's inbox feeds with projects no plan has yet (core/inbox.ts inboxWorkspace); null: none, they
 *  wait. An archived or unknown workspace is refused. */
export async function setInboxWorkspace(env: Env, kind: StoreKind, workspaceId: string | null, nowS: number) {
  if (!(await storeRows(env.DB)).some((r) => r.kind === kind)) throw new StoreError(`no ${kind} store is set up`);
  if (
    workspaceId !== null &&
    !(await env.DB.prepare("SELECT 1 FROM workspaces WHERE id = ?1 AND archived_at IS NULL").bind(workspaceId).first())
  )
    throw new StoreError(`no workspace ${workspaceId}`);
  await env.DB.prepare("UPDATE media_store SET inbox_workspace = ?1, updated_at = ?2 WHERE kind = ?3")
    .bind(workspaceId, nowS, kind)
    .run();
}

/** Approvals of items not published yet whose media are in a store: what removing it voids. */
export async function waitingApprovalsIn(env: Env, kind: StoreKind): Promise<number> {
  const r = await env.DB.prepare(
    `SELECT COUNT(DISTINCT a.item_key) AS n FROM approvals a
     WHERE a.media LIKE ?1 AND NOT EXISTS (SELECT 1 FROM posted p WHERE p.item_key = a.item_key)
       AND a.id = (SELECT MAX(b.id) FROM approvals b WHERE b.item_key = a.item_key)`,
  )
    .bind(`%"store":"${kind}"%`)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

/** Removes a store (its files then count as missing); the default moves to another store if there is one. */
export async function removeStore(env: Env, kind: StoreKind, nowS: number) {
  const rows = await storeRows(env.DB);
  const row = rows.find((r) => r.kind === kind);
  if (!row) throw new StoreError(`no ${kind} store is set up`);
  await env.DB.prepare("DELETE FROM media_store WHERE kind = ?1").bind(kind).run();
  const next = rows.find((r) => r.kind !== kind);
  if (row.isDefault && next) await setDefaultStore(env, next.kind, nowS);
  // the folder ids remembered for it (its inbox, Drive's upload folder) belong to the old store
  await env.DB.prepare("DELETE FROM settings WHERE key = ?1 OR (?2 = 'drive' AND key LIKE 'drive_upload_folder:%')")
    .bind(`inbox_folder:${kind}`, kind)
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
  await saveStore(env, fetcher, "drive", {}, grant, st.userId, nowS);
  return { userId: st.userId };
}

// ---- the weekly check

/** Each store, weekly (in the inbox's cron run): it still answers, or it's marked broken and the instance admins are
 *  told once. */
export async function checkStores(
  env: Env,
  deps: { fetch: typeof fetch; now: Date },
): Promise<{ checked: string[]; broken: string[] }> {
  const nowS = Math.floor(deps.now.getTime() / 1000);
  const out = { checked: [] as string[], broken: [] as string[] };
  const problems: string[] = [];
  for (const r of await storeRows(env.DB)) {
    if (r.lastCheckedAt !== null && r.lastCheckedAt > nowS - CHECK_EVERY_S) continue;
    let error: string | null = null;
    try {
      const creds = r.credentials ? await decryptSecret(env.ENCRYPTION_KEY, r.credentials) : null;
      const store = buildStore(env, deps.fetch, r.kind, r.settings, creds);
      if (!(await store.resolve("UPLOADS"))) error = "UPLOADS can't be found";
    } catch (e) {
      error = (e as Error).message.slice(0, 300);
    }
    await env.DB.prepare("UPDATE media_store SET status = ?1, last_error = ?2, last_checked_at = ?3 WHERE kind = ?4")
      .bind(error ? "broken" : "ok", error, nowS, r.kind)
      .run();
    (error ? out.broken : out.checked).push(r.kind);
    if (error && r.status !== "broken") problems.push(`${r.kind}: ${error}`);
  }
  // the stores are the instance's: its admins hear of them, not any one workspace
  if (problems.length) await notifyInstanceAdmins(env, deps.fetch, mediaStoreProblem(problems.join("\n")), nowS);
  return out;
}
