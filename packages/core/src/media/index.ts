// The instance's media stores (docs/media-stores.md): one per kind, set up in the dashboard and kept in media_store
// (settings, credentials encrypted with ENCRYPTION_KEY), one of them the default. Every reference to a file names its
// store ({store, id, checksum}), so each file is read from its own; a reference to a store that isn't set up counts as
// missing. Code that needs media asks for them here and only uses the MediaStore interface.
import { decryptSecret } from "../crypto";
import type { Db } from "../db";
import type { Env } from "../env";
import { DriveStore } from "./drive";
import { type S3Credentials, type S3Settings, S3Store } from "./s3";
import type { MediaRef, MediaStore } from "./store";

export const STORE_KINDS = ["drive", "s3", "local"] as const;
export type StoreKind = (typeof STORE_KINDS)[number];

/** A media_store row, as read (credentials still encrypted). */
export interface StoreRow {
  kind: StoreKind;
  isDefault: boolean;
  settings: Record<string, unknown>;
  credentials: string | null;
  status: "ok" | "broken";
  lastError: string | null;
  lastCheckedAt: number | null;
  updatedAt: number;
  /** The workspace its inbox's new projects (ones no plan has) are drafted in; null: they wait (core/inbox.ts). */
  inboxWorkspace: string | null;
}

export async function storeRows(db: Db): Promise<StoreRow[]> {
  const r = await db
    .prepare(
      `SELECT kind, is_default, settings, credentials, status, last_error, last_checked_at, updated_at, inbox_workspace
       FROM media_store ORDER BY kind`,
    )
    .all<{
      kind: StoreKind;
      is_default: number;
      settings: string;
      credentials: string | null;
      status: "ok" | "broken";
      last_error: string | null;
      last_checked_at: number | null;
      updated_at: number;
      inbox_workspace: string | null;
    }>();
  return r.results.map((x) => ({
    kind: x.kind,
    isDefault: !!x.is_default,
    settings: JSON.parse(x.settings || "{}") as Record<string, unknown>,
    credentials: x.credentials,
    status: x.status,
    lastError: x.last_error,
    lastCheckedAt: x.last_checked_at,
    updatedAt: x.updated_at,
    inboxWorkspace: x.inbox_workspace,
  }));
}

/** The default store's kind without building any store (null when none is set up): where agents' file ids are. */
export async function defaultKind(db: Db): Promise<StoreKind | null> {
  const r = await db
    .prepare("SELECT kind FROM media_store ORDER BY is_default DESC, kind LIMIT 1")
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
): MediaStore {
  if (kind === "drive") {
    if (!credentials) throw new Error("Google Drive isn't connected");
    return new DriveStore({ oauth: credentials, fetch: fetcher, db: env.DB });
  }
  if (kind === "s3") {
    if (!credentials) throw new Error("the bucket's keys are missing");
    return new S3Store(settings as unknown as S3Settings, JSON.parse(credentials) as S3Credentials, fetcher);
  }
  const make = registered.get(kind);
  if (!make) throw new Error(`this server doesn't offer the ${kind} store`);
  return make(env, fetcher);
}

export class MediaStores {
  constructor(
    private readonly byKind: Map<string, MediaStore>,
    private readonly defaultKind: string | null,
    /** Stores set up but not usable (credentials that don't decrypt, a kind the runtime doesn't offer): kind → why. */
    readonly errors: Map<string, string> = new Map(),
  ) {}

  get all(): MediaStore[] {
    return [...this.byKind.values()];
  }
  get(kind: string): MediaStore | null {
    return this.byKind.get(kind) ?? null;
  }
  /** The store a reference names, or null when it isn't set up (the file counts as missing). */
  for(ref: Pick<MediaRef, "store">): MediaStore | null {
    return this.get(ref.store);
  }
  /** Where nothing names a store: plan items given by path, drafts from the agent API, the upload page's choice. */
  get default(): MediaStore | null {
    return (this.defaultKind && this.get(this.defaultKind)) || this.all[0] || null;
  }
  /** The stores the app can upload to. */
  get uploadable(): MediaStore[] {
    return this.all.filter((s) => s.createUpload);
  }
}

/** Every store set up on the instance, built once per request or cron run. */
export async function mediaStores(env: Env, fetcher: typeof fetch): Promise<MediaStores> {
  const rows = await storeRows(env.DB);
  const built = new Map<string, MediaStore>();
  const errors = new Map<string, string>();
  for (const r of rows) {
    try {
      const creds = r.credentials ? await decryptSecret(env.ENCRYPTION_KEY, r.credentials) : null;
      built.set(r.kind, buildStore(env, fetcher, r.kind, r.settings, creds));
    } catch (e) {
      errors.set(r.kind, (e as Error).message);
    }
  }
  return new MediaStores(built, rows.find((r) => r.isDefault)?.kind ?? null, errors);
}
