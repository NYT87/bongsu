// A workspace's settings (workspace_settings): its time zone (the default for showing and entering times; the database
// keeps UTC), the daily digest's hour and the locale. A user may pick their own zone (users.timezone).

import { DEFAULT_WORKSPACE } from "./accounts";
import type { Db } from "./db";
import { isTimeZone } from "./formats/time";

export interface WorkspaceSettings {
  workspaceId: string;
  timezone: string;
  digestHour: number;
  locale: string;
}

const FALLBACK = { timezone: "UTC", digestHour: 8, locale: "en" };

export async function workspaceSettings(db: Db, workspaceId = DEFAULT_WORKSPACE): Promise<WorkspaceSettings> {
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

/** The workspace a signed-in user works in: their membership (the default workspace first, while there's no picker;
 *  Phase 13 adds one). Null when they belong to none. */
export async function userWorkspace(db: Db, userId: string): Promise<string | null> {
  const r = await db
    .prepare(
      "SELECT workspace_id FROM memberships WHERE user_id = ?1 ORDER BY workspace_id = ?2 DESC, created_at LIMIT 1",
    )
    .bind(userId, DEFAULT_WORKSPACE)
    .first<{ workspace_id: string }>();
  return r?.workspace_id ?? null;
}

/** The user's role in the workspace (memberships), or null when they're not a member. */
export async function userRole(db: Db, userId: string, workspaceId: string): Promise<string | null> {
  const r = await db
    .prepare("SELECT role FROM memberships WHERE user_id = ?1 AND workspace_id = ?2")
    .bind(userId, workspaceId)
    .first<{ role: string }>();
  return r?.role ?? null;
}

/** The workspace's time zone. */
export const workspaceZone = async (db: Db, workspaceId = DEFAULT_WORKSPACE) =>
  (await workspaceSettings(db, workspaceId)).timezone;

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

/** The zone a person sees and enters times in: their own (users.timezone), else their workspace's. */
export async function callerZone(db: Db, workspaceId: string, userId?: string | null): Promise<string> {
  if (userId) {
    const r = await db
      .prepare("SELECT timezone FROM users WHERE id = ?1")
      .bind(userId)
      .first<{ timezone: string | null }>();
    if (r?.timezone && isTimeZone(r.timezone)) return r.timezone;
  }
  return workspaceZone(db, workspaceId);
}

/** A user's own zone; null goes back to the workspace's. */
export async function setUserZone(db: Db, userId: string, timezone: string | null) {
  if (timezone !== null && !isTimeZone(timezone)) throw new Error(`unknown time zone ${timezone}`);
  await db.prepare("UPDATE users SET timezone = ?1 WHERE id = ?2").bind(timezone, userId).run();
}
