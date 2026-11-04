// Accounts and connections, from the database (migrations/0002_accounts.sql): which profiles and channels Bongsu
// publishes to, and how it reaches each platform. An account's id is the key the plan data uses (plan_items.account,
// shorts_comments.channel, ...).

import { decryptSecret } from "./crypto";
import type { Db } from "./db";
import type { LintRules } from "./formats/caption-lint";
import type { Platform } from "./platforms/types";

/** A registered platform's id (platforms/index.ts): "instagram", "youtube"… */
export type PlatformId = string;
/** The workspace instances made before Phase 13 keep their data in (a fresh one has none): what reads that data, the
 *  tests, name it. Nothing falls back to it. */
export const DEFAULT_WORKSPACE = "default";

export interface Connection {
  id: string;
  workspaceId: string;
  /** Which provider factory handles it (providers/index.ts): composio (a Composio connected account), instagram (the
   *  Instagram API with Instagram Login, a token), youtube, or one a deployment registers. */
  provider: string;
  kind: "composio" | "oauth" | "service";
  label: string | null;
  /** Composio's connected-account id. */
  externalRef: string | null;
  /** Encrypted credentials (core/crypto.ts), or null when they come from `secretName`. */
  credentials: string | null;
  /** The environment variable holding the credentials, for deployments that keep them as secrets. */
  secretName: string | null;
  status: "ok" | "expiring" | "broken";
}

export interface Account {
  id: string;
  workspaceId: string;
  platform: PlatformId;
  /** The Instagram username / the YouTube channel handle. */
  handle: string;
  displayName: string | null;
  /** The Instagram user id / the YouTube channel id. */
  externalId: string | null;
  connection: Connection | null;
  /** What the platform allows here, e.g. { trialReels: true }. */
  capabilities: Record<string, unknown>;
  /** The owner's choices, e.g. { trialReels: false } (the Trial Reels default). */
  settings: Record<string, unknown>;
  status: "active" | "disabled";
}

interface Row {
  id: string;
  workspace_id: string;
  platform: PlatformId;
  handle: string;
  display_name: string | null;
  external_id: string | null;
  capabilities: string;
  settings: string;
  status: "active" | "disabled";
  c_id: string | null;
  c_provider: Connection["provider"] | null;
  c_kind: Connection["kind"] | null;
  c_label: string | null;
  c_external_ref: string | null;
  c_credentials: string | null;
  c_secret_name: string | null;
  c_status: Connection["status"] | null;
}

const SELECT = `SELECT a.id, a.workspace_id, a.platform, a.handle, a.display_name, a.external_id, a.capabilities,
  a.settings, a.status, c.id AS c_id, c.provider AS c_provider, c.kind AS c_kind, c.label AS c_label,
  c.external_ref AS c_external_ref, c.credentials AS c_credentials, c.secret_name AS c_secret_name,
  c.status AS c_status
  FROM accounts a LEFT JOIN connections c ON c.id = a.connection_id`;

const json = (s: string): Record<string, unknown> => {
  try {
    const v = JSON.parse(s) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

function toAccount(r: Row): Account {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    platform: r.platform,
    handle: r.handle,
    displayName: r.display_name,
    externalId: r.external_id,
    capabilities: json(r.capabilities),
    settings: json(r.settings),
    status: r.status,
    connection: r.c_id
      ? {
          id: r.c_id,
          workspaceId: r.workspace_id,
          provider: r.c_provider!,
          kind: r.c_kind!,
          label: r.c_label,
          externalRef: r.c_external_ref,
          credentials: r.c_credentials,
          secretName: r.c_secret_name,
          status: r.c_status ?? "ok",
        }
      : null,
  };
}

export interface AccountFilter {
  /** Only this workspace's accounts; all workspaces when absent (the scheduler's runs). */
  workspaceId?: string;
  platform?: PlatformId;
  /** Disabled accounts too (default: active only). */
  all?: boolean;
  /** Only accounts of workspaces that aren't archived: what the scheduler's own runs (comments, metrics) still reach
   *  out for. An archived workspace stops completely; a paused one only stops publishing. */
  working?: boolean;
}

/** The ids of the archived workspaces, as a subquery. */
export const ARCHIVED = "SELECT id FROM workspaces WHERE archived_at IS NOT NULL";

export async function listAccounts(db: Db, f: AccountFilter = {}): Promise<Account[]> {
  const where: string[] = [];
  const vals: unknown[] = [];
  const add = (sql: string, v: unknown) => {
    vals.push(v);
    where.push(sql.replace("?", `?${vals.length}`));
  };
  if (f.workspaceId) add("a.workspace_id = ?", f.workspaceId);
  if (f.platform) add("a.platform = ?", f.platform);
  if (!f.all) where.push("a.status = 'active'");
  if (f.working) where.push(`a.workspace_id NOT IN (${ARCHIVED})`);
  const sql = `${SELECT}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY a.platform, a.sort, a.id`;
  const r = await db
    .prepare(sql)
    .bind(...vals)
    .all<Row>();
  return r.results.map(toAccount);
}

/** An account by id, or by handle within the workspace (and platform). */
export async function findAccount(
  db: Db,
  idOrHandle: string,
  workspaceId: string,
  platform?: PlatformId,
): Promise<Account | null> {
  const all = await listAccounts(db, { workspaceId, platform, all: true });
  return all.find((a) => a.id === idOrHandle) ?? all.find((a) => a.handle === idOrHandle) ?? null;
}

export const instagramAccounts = (db: Db, workspaceId?: string) =>
  listAccounts(db, { workspaceId, platform: "instagram" });
export const youtubeAccounts = (db: Db, workspaceId?: string) => listAccounts(db, { workspaceId, platform: "youtube" });
/** Every workspace's active accounts on a platform, but the archived workspaces': the scheduler's sampling runs. */
export const workingAccounts = (db: Db, platform: PlatformId) => listAccounts(db, { platform, working: true });

/** Trial Reels are possible here (Instagram requires a follower minimum). */
export const trialCapable = (a: Account) => a.capabilities.trialReels === true;
/** The account's Trial Reels default: on until the owner turns it off, where possible at all. */
export const trialDefaultOn = (a: Account) => trialCapable(a) && a.settings.trialReels !== false;

/** The Composio connected-account id that posts for this account. */
export const composioRef = (a: Account) => (a.connection?.provider === "composio" ? a.connection.externalRef : null);

/** A connection's credentials: decrypted from the database, or read from the environment variable it names. */
export async function connectionSecret(env: object, c: Connection | null): Promise<string | null> {
  if (!c) return null;
  const vars = env as Record<string, unknown>;
  if (c.credentials) return decryptSecret(vars.ENCRYPTION_KEY as string | undefined, c.credentials);
  const v = c.secretName ? vars[c.secretName] : undefined;
  return typeof v === "string" && v ? v : null;
}

/** The caption rules for an account: the platform's defaults, each field overridden by a well-typed value in
 *  settings.captionRules (anything else there is ignored, so a stray value can't switch a check off by accident). */
export function captionRules(p: Platform, a: Pick<Account, "settings">): LintRules {
  const raw = a.settings.captionRules;
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const num = (k: keyof LintRules, d: number) =>
    typeof o[k] === "number" && Number.isFinite(o[k]) ? (o[k] as number) : d;
  return {
    hashtagMax: num("hashtagMax", p.lintDefaults.hashtagMax),
    foldChars: num("foldChars", p.lintDefaults.foldChars),
    languageChecks: typeof o.languageChecks === "boolean" ? o.languageChecks : p.lintDefaults.languageChecks,
  };
}

export async function setAccountSettings(db: Db, id: string, patch: Record<string, unknown>, nowS: number) {
  const r = await db.prepare("SELECT settings FROM accounts WHERE id = ?1").bind(id).first<{ settings: string }>();
  if (!r) return false;
  const settings = { ...json(r.settings), ...patch };
  await db
    .prepare("UPDATE accounts SET settings = ?1, updated_at = ?2 WHERE id = ?3")
    .bind(JSON.stringify(settings), nowS, id)
    .run();
  return true;
}

export interface NewConnection {
  id: string;
  workspaceId: string;
  provider: Connection["provider"];
  kind: Connection["kind"];
  label?: string | null;
  externalRef?: string | null;
  credentials?: string | null;
  secretName?: string | null;
}

/** Creates or replaces a connection (the dashboard's Connect flows, Phase 4b; tests and setup scripts until then). */
export async function upsertConnection(db: Db, c: NewConnection, nowS: number) {
  await db
    .prepare(
      `INSERT INTO connections (id, workspace_id, provider, kind, label, external_ref, credentials, secret_name,
         created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
       ON CONFLICT (id) DO UPDATE SET provider = excluded.provider, kind = excluded.kind, label = excluded.label,
         external_ref = excluded.external_ref, credentials = excluded.credentials, secret_name = excluded.secret_name,
         updated_at = excluded.updated_at`,
    )
    .bind(
      c.id,
      c.workspaceId,
      c.provider,
      c.kind,
      c.label ?? null,
      c.externalRef ?? null,
      c.credentials ?? null,
      c.secretName ?? null,
      nowS,
    )
    .run();
}

export interface NewAccount {
  id: string;
  workspaceId: string;
  platform: PlatformId;
  handle: string;
  displayName?: string | null;
  externalId?: string | null;
  connectionId?: string | null;
  capabilities?: Record<string, unknown>;
  settings?: Record<string, unknown>;
  sort?: number;
}

/** Creates or updates an account (keeps its settings when they aren't given). */
export async function upsertAccount(db: Db, a: NewAccount, nowS: number) {
  await db
    .prepare(
      `INSERT INTO accounts (id, workspace_id, platform, handle, display_name, external_id, connection_id,
         capabilities, settings, sort, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)
       ON CONFLICT (id) DO UPDATE SET handle = excluded.handle, display_name = excluded.display_name,
         external_id = excluded.external_id, connection_id = excluded.connection_id,
         capabilities = excluded.capabilities, sort = excluded.sort, updated_at = excluded.updated_at`,
    )
    .bind(
      a.id,
      a.workspaceId,
      a.platform,
      a.handle,
      a.displayName ?? null,
      a.externalId ?? null,
      a.connectionId ?? null,
      JSON.stringify(a.capabilities ?? {}),
      JSON.stringify(a.settings ?? {}),
      a.sort ?? 0,
      nowS,
    )
    .run();
}
