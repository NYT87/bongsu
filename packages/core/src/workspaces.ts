// A workspace's settings (workspace_settings): its time zone (the default for showing and entering times; the database
// keeps UTC), the daily digest's hour and the locale. A user may pick their own zone (users.timezone).

import type { Db } from "./db";
import { isTimeZone } from "./formats/time";
import { isInstanceAdmin, isRole, type Role } from "./roles";

export interface WorkspaceSettings {
  workspaceId: string;
  timezone: string;
  digestHour: number;
  locale: string;
}

/** The zone of a workspace without settings, and of someone in no workspace. */
export const FALLBACK_ZONE = "UTC";
const FALLBACK = { timezone: FALLBACK_ZONE, digestHour: 8, locale: "en" };

export async function workspaceSettings(db: Db, workspaceId: string): Promise<WorkspaceSettings> {
  const r = await db
    .prepare("SELECT timezone, digest_hour, locale FROM workspace_settings WHERE workspace_id = ?1")
    .bind(workspaceId)
    .first<{ timezone: string; digest_hour: number; locale: string }>();
  if (!r) return { workspaceId, ...FALLBACK };
  return {
    workspaceId,
    timezone: isTimeZone(r.timezone) ? r.timezone : FALLBACK.timezone,
    digestHour: r.digest_hour,
    locale: r.locale,
  };
}

/** The user's first workspace that isn't archived (the oldest membership), with their role there. Null when they
 *  belong to none. */
async function firstMembership(db: Db, userId: string) {
  return db
    .prepare(
      `SELECT m.workspace_id, m.role FROM memberships m JOIN workspaces w ON w.id = m.workspace_id
       WHERE m.user_id = ?1 AND w.archived_at IS NULL
       ORDER BY m.created_at, m.workspace_id LIMIT 1`,
    )
    .bind(userId)
    .first<{ workspace_id: string; role: string }>();
}

/** The workspace a request works in: the one its session names (sessions.workspace_id) when the user is a member
 *  there, or an instance admin, and it isn't archived; else the user's first. `role` is the membership's, "admin" for
 *  an instance admin without one. Null when there's none: the request works nowhere. */
export async function sessionWorkspace(
  db: Db,
  s: { userId: string; workspaceId: string | null },
): Promise<{ workspaceId: string; role: Role | null; instanceAdmin: boolean } | null> {
  const instanceAdmin = await isInstanceAdmin(db, s.userId);
  const roleOf = (role: string | null | undefined): Role | null =>
    isRole(role) ? role : instanceAdmin ? "admin" : null;
  if (s.workspaceId) {
    const r = await db
      .prepare(
        `SELECT w.id, m.role FROM workspaces w LEFT JOIN memberships m ON m.workspace_id = w.id AND m.user_id = ?2
         WHERE w.id = ?1 AND w.archived_at IS NULL`,
      )
      .bind(s.workspaceId, s.userId)
      .first<{ id: string; role: string | null }>();
    if (r && (r.role || instanceAdmin)) return { workspaceId: r.id, role: roleOf(r.role), instanceAdmin };
  }
  const m = await firstMembership(db, s.userId);
  return m ? { workspaceId: m.workspace_id, role: roleOf(m.role), instanceAdmin } : null;
}

/** The workspace's time zone. */
export const workspaceZone = async (db: Db, workspaceId: string) => (await workspaceSettings(db, workspaceId)).timezone;

export async function setWorkspaceSettings(
  db: Db,
  workspaceId: string,
  s: Partial<Omit<WorkspaceSettings, "workspaceId">>,
  nowS: number,
) {
  if (s.timezone !== undefined && !isTimeZone(s.timezone)) throw new Error(`unknown time zone ${s.timezone}`);
  const cur = await workspaceSettings(db, workspaceId);
  await db
    .prepare(
      `INSERT INTO workspace_settings (workspace_id, timezone, digest_hour, locale, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT (workspace_id) DO UPDATE SET timezone = excluded.timezone, digest_hour = excluded.digest_hour,
         locale = excluded.locale, updated_at = excluded.updated_at`,
    )
    .bind(workspaceId, s.timezone ?? cur.timezone, s.digestHour ?? cur.digestHour, s.locale ?? cur.locale, nowS)
    .run();
}

/** The zone a person sees and enters times in: their own (users.timezone), else their workspace's; UTC for someone in
 *  no workspace (signed in before they have one). */
export async function callerZone(db: Db, workspaceId: string | null, userId?: string | null): Promise<string> {
  if (userId) {
    const r = await db
      .prepare("SELECT timezone FROM users WHERE id = ?1")
      .bind(userId)
      .first<{ timezone: string | null }>();
    if (r?.timezone && isTimeZone(r.timezone)) return r.timezone;
  }
  return workspaceId ? workspaceZone(db, workspaceId) : FALLBACK.timezone;
}

/** A user's own zone; null goes back to the workspace's. */
export async function setUserZone(db: Db, userId: string, timezone: string | null) {
  if (timezone !== null && !isTimeZone(timezone)) throw new Error(`unknown time zone ${timezone}`);
  await db.prepare("UPDATE users SET timezone = ?1 WHERE id = ?2").bind(timezone, userId).run();
}
