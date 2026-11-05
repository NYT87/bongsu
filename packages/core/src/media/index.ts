// The media stores (docs/media-stores.md): the instance's (one per kind) and each workspace's own, set up in the
// dashboard and the app and kept in media_store (settings, credentials encrypted with ENCRYPTION_KEY), one of them the
// default. Every reference to a file names its store ({store, id, checksum}), so each file is read from its own; a
// reference to a store that isn't set up counts as missing. Code that needs media asks for them here and only uses
// the MediaStore interface.
import { decryptSecret } from "../crypto";
import type { Db } from "../db";
import type { Env } from "../env";
import { DriveStore } from "./drive";
import { type S3Credentials, type S3Settings, S3Store } from "./s3";
import type { MediaRef, MediaStore } from "./store";

export const STORE_KINDS = ["drive", "s3", "local"] as const;
export type StoreKind = (typeof STORE_KINDS)[number];

/** Whose stores: `{workspaceId: null}` is the instance's, a workspace id is that workspace's own. */
export type StoreScope = { workspaceId: string | null };

/** A store's id: the kind for the instance's (`drive`, `s3`, `local`), `<kind>-<workspace>` for a workspace's own. */
export const storeId = (kind: StoreKind, workspaceId: string | null): string =>
  workspaceId === null ? kind : `${kind}-${workspaceId}`;

/** A media_store row, as read (credentials still encrypted). */
export interface StoreRow {
  id: string;
  kind: StoreKind;
  /** The workspace it belongs to; null: the instance's. */
  workspaceId: string | null;
  isDefault: boolean;
  settings: Record<string, unknown>;
  credentials: string | null;
  status: "ok" | "broken";
  lastError: string | null;
  lastCheckedAt: number | null;
  updatedAt: number;
}

/** The rows of a scope: none given, every row; `{workspaceId: null}`, the instance's; a workspace, the instance's
 *  plus its own (what it can use). */
export async function storeRows(db: Db, scope?: StoreScope): Promise<StoreRow[]> {
  // "" would read as the instance's scope below (it isn't bound): a caller's bug, not a scope
  if (scope?.workspaceId === "") throw new Error("storeRows: an empty workspace id");
  const where =
    scope === undefined
      ? ""
      : scope.workspaceId === null
        ? "WHERE workspace_id IS NULL"
        : "WHERE workspace_id IS NULL OR workspace_id = ?1";
  const stmt = db.prepare(
    `SELECT id, kind, workspace_id, is_default, settings, credentials, status, last_error, last_checked_at, updated_at
     FROM media_store ${where} ORDER BY id`,
  );
  const r = await (scope?.workspaceId ? stmt.bind(scope.workspaceId) : stmt).all<{
    id: string;
    kind: StoreKind;
    workspace_id: string | null;
    is_default: number;
    settings: string;
    credentials: string | null;
    status: "ok" | "broken";
    last_error: string | null;
    last_checked_at: number | null;
    updated_at: number;
  }>();
  return r.results.map((x) => ({
    id: x.id,
    kind: x.kind,
    workspaceId: x.workspace_id,
    isDefault: !!x.is_default,
    settings: JSON.parse(x.settings || "{}") as Record<string, unknown>,
    credentials: x.credentials,
    status: x.status,
    lastError: x.last_error,
    lastCheckedAt: x.last_checked_at,
    updatedAt: x.updated_at,
  }));
}

/** The instance's default store's kind without building any store (null when none is set up): where agents' file ids
 *  are. */
export async function defaultKind(db: Db): Promise<StoreKind | null> {
  const r = await db
    .prepare("SELECT kind FROM media_store WHERE workspace_id IS NULL ORDER BY is_default DESC, id LIMIT 1")
    .first<{ kind: StoreKind }>();
  return r?.kind ?? null;
}

/** Stores a runtime offers (the Node app registers "local", a directory on the server, MEDIA_DIR): they live outside
 *  core so the Workers bundle never imports Node-only code, and the dashboard only lets you pick one that's offered. */
const registered = new Map<string, (env: Env, fetcher: typeof fetch) => MediaStore>();
export function registerStore(kind: string, make: (env: Env, fetcher: typeof fetch) => MediaStore) {
  registered.set(kind, make);
}
/** The kinds this runtime can run: drive and s3 everywhere, plus what it registered. */
export const offeredKinds = (): StoreKind[] => STORE_KINDS.filter((k) => k !== "local" || registered.has(k));

/** One store from its settings and decrypted credentials (also what the dashboard's Test builds, before saving). */
export function buildStore(
  env: Env,
  fetcher: typeof fetch,
  kind: StoreKind,
  settings: Record<string, unknown>,
  credentials: string | null,
  id: string = kind,
): MediaStore {
  if (kind === "drive") {
    if (!credentials) throw new Error("Google Drive isn't connected");
    return new DriveStore({ oauth: credentials, fetch: fetcher, db: env.DB, id });
  }
  if (kind === "s3") {
    if (!credentials) throw new Error("the bucket's keys are missing");
    return new S3Store(settings as unknown as S3Settings, JSON.parse(credentials) as S3Credentials, fetcher, id);
  }
  const make = registered.get(kind);
  if (!make) throw new Error(`this server doesn't offer the ${kind} store`);
  return make(env, fetcher);
}

export class MediaStores {
  constructor(
    private readonly byId: Map<string, MediaStore>,
    private readonly defaultId: string | null,
    /** Stores set up but not usable (credentials that don't decrypt, a kind the runtime doesn't offer): id → why. */
    readonly errors: Map<string, string> = new Map(),
    /** The instance's default, for when the workspace's own default can't be built. */
    private readonly fallbackId: string | null = null,
    /** The ids of the stores that belong to the workspace (not the instance's). */
    private readonly ownIds: ReadonlySet<string> = new Set(),
  ) {}

  /** Whether the store is the workspace's own: everything in it is the workspace's. */
  isOwn(id: string): boolean {
    return this.ownIds.has(id);
  }

  get all(): MediaStore[] {
    return [...this.byId.values()];
  }
  get(id: string): MediaStore | null {
    return this.byId.get(id) ?? null;
  }
  /** The store a reference names, or null when it isn't set up (the file counts as missing). */
  for(ref: Pick<MediaRef, "store">): MediaStore | null {
    return this.get(ref.store);
  }
  /** Where nothing names a store: plan items given by path, drafts from the agent API, the upload page's choice. */
  get default(): MediaStore | null {
    // none marked (or neither can be built): the first store by id
    return (this.defaultId && this.get(this.defaultId)) || this.get(this.fallbackId ?? "") || this.all[0] || null;
  }
  /** The stores the app can upload to. */
  get uploadable(): MediaStore[] {
    return this.all.filter((s) => s.createUpload);
  }
}

/** The stores set up for a workspace (the instance's and its own), or the instance's only when none is given; built
 *  once per request or cron run. The default is the workspace's own when it has one, else the instance's. */
export async function mediaStores(
  env: Env,
  fetcher: typeof fetch,
  workspaceId: string | null = null,
): Promise<MediaStores> {
  const rows = await storeRows(env.DB, { workspaceId });
  const built = new Map<string, MediaStore>();
  const errors = new Map<string, string>();
  for (const r of rows) {
    try {
      const creds = r.credentials ? await decryptSecret(env.ENCRYPTION_KEY, r.credentials) : null;
      built.set(r.id, buildStore(env, fetcher, r.kind, r.settings, creds, r.id));
    } catch (e) {
      errors.set(r.id, (e as Error).message);
    }
  }
  const defaults = defaultIds(rows, workspaceId);
  const own = new Set(rows.filter((r) => r.workspaceId !== null).map((r) => r.id));
  return new MediaStores(built, defaults.effective, errors, defaults.instance, own);
}

/** Which row is the default: the workspace's own when it has one, else the instance's (null: none marked). */
export function defaultIds(
  rows: StoreRow[],
  workspaceId: string | null,
): { effective: string | null; instance: string | null } {
  const own = rows.find((r) => r.isDefault && workspaceId !== null && r.workspaceId === workspaceId);
  const instance = rows.find((r) => r.isDefault && r.workspaceId === null)?.id ?? null;
  return { effective: own?.id ?? instance, instance };
}

/** One store by id among all rows of every scope (the /m links name a store by id; the signature vouches for the
 *  file). Null when it isn't set up or can't be built. */
export async function mediaStoreById(env: Env, fetcher: typeof fetch, id: string): Promise<MediaStore | null> {
  const r = (await storeRows(env.DB)).find((x) => x.id === id);
  if (!r) return null;
  try {
    const creds = r.credentials ? await decryptSecret(env.ENCRYPTION_KEY, r.credentials) : null;
    return buildStore(env, fetcher, r.kind, r.settings, creds, r.id);
  } catch {
    return null;
  }
}
