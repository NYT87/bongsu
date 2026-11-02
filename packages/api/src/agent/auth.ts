// Agent API keys and CLI tokens: "bongsu_…" bearer tokens. D1 keeps only their sha256, a name and scopes.
// Agent keys can read, make drafts, edit the plan (scope "plan"), pause and, only if given the opt-in scope
// "reschedule", move a scheduled YouTube video's release date; they can never approve, resume or manage
// keys. A CLI token (api_keys.user_id set) acts as its person, with their role's rights in its workspace, read on
// every request: for an owner that includes approve and resume (docs/PLAN.md, principle 5).
import type { Db } from "@bongsu/core/db";
import { sha256Hex } from "@bongsu/core/formats/approved";

// "metrics" (uploading samples collected elsewhere) is opt-in on an agent key, like "reschedule"
export type Scope = "read" | "draft" | "pause" | "plan" | "reschedule" | "metrics" | "approve" | "resume";

/** What each membership role may do through a CLI token. */
export const ROLE_SCOPES: Record<string, Scope[]> = {
  owner: ["read", "draft", "plan", "pause", "reschedule", "metrics", "approve", "resume"],
  admin: ["read", "draft", "plan", "pause", "reschedule", "metrics", "approve", "resume"],
  approver: ["read", "approve"],
  editor: ["read", "draft", "plan"],
  viewer: ["read"],
};
export interface Caller {
  id: string;
  name: string;
  scopes: Scope[];
  /** The workspace the caller works in: an agent key's own, the signed-in user's for the app. */
  workspaceId: string;
  /** The signed-in user (the app); agent keys have none and use the workspace's time zone. */
  userId?: string;
}

export const RATE_PER_MIN = 60;

export async function authenticate(db: Db, header: string | null | undefined, nowS: number): Promise<Caller | null> {
  const m = /^Bearer\s+(bongsu_[A-Za-z0-9_-]{20,})$/.exec(header ?? "");
  if (!m) return null;
  const row = await db
    .prepare(
      `SELECT k.id, k.name, k.scopes, k.last_used_at, k.workspace_id, k.user_id, k.expires_at, m.role
       FROM api_keys k LEFT JOIN memberships m ON m.user_id = k.user_id AND m.workspace_id = k.workspace_id
       WHERE k.key_hash = ?1 AND k.revoked_at IS NULL`,
    )
    .bind(await sha256Hex(m[1]))
    .first<{
      id: string;
      name: string;
      scopes: string;
      last_used_at: number | null;
      workspace_id: string;
      user_id: string | null;
      expires_at: number | null;
      role: string | null;
    }>();
  if (!row) return null;
  if (row.expires_at !== null && row.expires_at <= nowS) return null;
  // a CLI token whose person left the workspace stops working
  if (row.user_id && !row.role) return null;
  if (!row.last_used_at || nowS - row.last_used_at > 300) {
    await db.prepare("UPDATE api_keys SET last_used_at = ?1 WHERE id = ?2").bind(nowS, row.id).run();
  }
  if (row.user_id)
    return {
      id: row.id,
      name: row.name,
      scopes: ROLE_SCOPES[row.role ?? ""] ?? [],
      workspaceId: row.workspace_id,
      userId: row.user_id,
    };
  return { id: row.id, name: row.name, scopes: JSON.parse(row.scopes) as Scope[], workspaceId: row.workspace_id };
}

/** Count this request; false once the key has made more than RATE_PER_MIN requests this minute. */
export async function withinRate(db: Db, keyId: string, nowS: number): Promise<boolean> {
  const window = Math.floor(nowS / 60);
  const r = await db
    .prepare(
      'INSERT INTO rate_limits (key_id, "window", n) VALUES (?1, ?2, 1) ON CONFLICT (key_id, "window") DO UPDATE SET n = rate_limits.n + 1 RETURNING n',
    )
    .bind(keyId, window)
    .first<{ n: number }>();
  if (window % 30 === 0)
    await db
      .prepare('DELETE FROM rate_limits WHERE "window" < ?1')
      .bind(window - 60)
      .run();
  return (r?.n ?? 0) <= RATE_PER_MIN;
}

/** Count one attempt at `id` (rows in rate_limits, by minute, like the keys' limit); false once there were more than
 *  `max` in the last `minutes` minutes, this one included. For guessable sign-ins, where a key's per-minute budget is
 *  far too generous. */
export async function withinAttempts(db: Db, id: string, nowS: number, max: number, minutes: number): Promise<boolean> {
  const window = Math.floor(nowS / 60);
  await db
    .prepare(
      'INSERT INTO rate_limits (key_id, "window", n) VALUES (?1, ?2, 1) ON CONFLICT (key_id, "window") DO UPDATE SET n = rate_limits.n + 1',
    )
    .bind(id, window)
    .run();
  const r = await db
    .prepare('SELECT SUM(n) AS n FROM rate_limits WHERE key_id = ?1 AND "window" > ?2')
    .bind(id, window - minutes)
    .first<{ n: number | null }>();
  return (r?.n ?? 0) <= max;
}
