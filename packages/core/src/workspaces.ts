// A workspace's settings (workspace_settings): its time zone (the default for showing and entering times; the database
// keeps UTC), the daily digest's hour and the locale. A user may pick their own zone (users.timezone).

import type { Db } from "./db";
import { isTimeZone } from "./formats/time";
import { checkFolderName, FolderError, folderTaken } from "./media/folders";
import { isInstanceAdmin, isRole, type Role } from "./roles";
import { jsonList } from "./sql";

export interface WorkspaceSettings {
  workspaceId: string;
  timezone: string;
  digestHour: number;
  locale: string;
  /** The workspace's top folder in the media store (media/folders.ts); its id for one saved without. */
  mediaFolder: string;
}

/** The zone of a workspace without settings, and of someone in no workspace. */
export const FALLBACK_ZONE = "UTC";
const FALLBACK = { timezone: FALLBACK_ZONE, digestHour: 8, locale: "en" };

export async function workspaceSettings(db: Db, workspaceId: string): Promise<WorkspaceSettings> {
  const r = await db
    .prepare("SELECT timezone, digest_hour, locale, media_folder FROM workspace_settings WHERE workspace_id = ?1")
    .bind(workspaceId)
    .first<{ timezone: string; digest_hour: number; locale: string; media_folder: string | null }>();
  if (!r) return { workspaceId, ...FALLBACK, mediaFolder: workspaceId };
  return {
    workspaceId,
    timezone: isTimeZone(r.timezone) ? r.timezone : FALLBACK.timezone,
    digestHour: r.digest_hour,
    locale: r.locale,
    mediaFolder: r.media_folder ?? workspaceId,
  };
}

/** The user's first workspace that isn't archived (the oldest membership), with their role there. Null when they
 *  belong to none. `notCreator`: one where they're an admin or editor first (the dashboard, which creators don't use),
 *  so a creator somewhere who's an editor elsewhere lands where they can work. */
async function firstMembership(db: Db, userId: string, notCreator = false) {
  return db
    .prepare(
      `SELECT m.workspace_id, m.role FROM memberships m JOIN workspaces w ON w.id = m.workspace_id
       WHERE m.user_id = ?1 AND w.archived_at IS NULL
       ORDER BY ${notCreator ? "CASE WHEN m.role = 'creator' THEN 1 ELSE 0 END, " : ""}m.created_at, m.workspace_id
       LIMIT 1`,
    )
    .bind(userId)
    .first<{ workspace_id: string; role: string }>();
}

/** The workspace a request works in: the one its session names (sessions.workspace_id) when the user is a member
 *  there, or an instance admin, and it isn't archived; else the user's first. `role` is the membership's; an instance
 *  admin's is "admin" in every workspace, whatever their membership there (an instance admin acts anywhere with an
 *  admin's rights: this is the one place that decides it). Null when there's none: the request works nowhere.
 *  `notCreator`: the dashboard's first pick (firstMembership). */
export async function sessionWorkspace(
  db: Db,
  s: { userId: string; workspaceId: string | null },
  opts: { notCreator?: boolean } = {},
): Promise<{ workspaceId: string; role: Role | null; instanceAdmin: boolean } | null> {
  const instanceAdmin = await isInstanceAdmin(db, s.userId);
  const roleOf = (role: string | null | undefined): Role | null =>
    instanceAdmin ? "admin" : isRole(role) ? role : null;
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
  const m = await firstMembership(db, s.userId, opts.notCreator);
  return m ? { workspaceId: m.workspace_id, role: roleOf(m.role), instanceAdmin } : null;
}

/** A workspace someone can open, with their role there (an instance admin's is "admin", as in sessionWorkspace). */
export type OpenableWorkspace = { id: string; name: string; role: Role };

/** Who may open which workspace, the one query workspacesOf and mayOpen share so the list and the switch can't drift
 *  apart: it isn't archived, and the user is a member there or an instance admin. `notCreator` (the dashboard, which
 *  creators don't use) leaves out the memberships where they're a creator, except an instance admin's, who's an admin
 *  everywhere. ?1 the user, ?2 1 for an instance admin, ?3 (`one`) the workspace. */
const OPENABLE = (o: { notCreator?: boolean; one?: boolean }) =>
  `SELECT w.id, w.name, m.role FROM workspaces w
   LEFT JOIN memberships m ON m.workspace_id = w.id AND m.user_id = ?1
   WHERE w.archived_at IS NULL AND (m.role IS NOT NULL OR ?2 = 1)
   ${o.notCreator ? "AND (?2 = 1 OR m.role <> 'creator')" : ""} ${o.one ? "AND w.id = ?3" : ""}
   ORDER BY w.name, w.id`;

async function openable(db: Db, userId: string, opts: { notCreator?: boolean }, workspaceId?: string) {
  const instanceAdmin = await isInstanceAdmin(db, userId);
  const one = workspaceId !== undefined;
  const r = await db
    .prepare(OPENABLE({ notCreator: opts.notCreator, one }))
    .bind(...[userId, instanceAdmin ? 1 : 0, ...(one ? [workspaceId] : [])])
    .all<{ id: string; name: string; role: string | null }>();
  return r.results.flatMap((w): OpenableWorkspace[] => {
    const role = instanceAdmin ? "admin" : isRole(w.role) ? w.role : null;
    return role ? [{ id: w.id, name: w.name, role }] : [];
  });
}

/** The workspaces the user can open (switch a session to), by name. */
export async function workspacesOf(
  db: Db,
  userId: string,
  opts: { notCreator?: boolean } = {},
): Promise<OpenableWorkspace[]> {
  return openable(db, userId, opts);
}

/** The workspace, when the user can open it; null when they can't (archived, unknown, not theirs). */
export async function mayOpen(
  db: Db,
  userId: string,
  workspaceId: string,
  opts: { notCreator?: boolean } = {},
): Promise<OpenableWorkspace | null> {
  return (await openable(db, userId, opts, workspaceId))[0] ?? null;
}

/** Whether the user is a member of the workspace: an instance admin may open one they aren't in. */
export async function isMember(db: Db, userId: string, workspaceId: string): Promise<boolean> {
  return !!(await db
    .prepare("SELECT 1 FROM memberships WHERE workspace_id = ?1 AND user_id = ?2")
    .bind(workspaceId, userId)
    .first());
}

/** A workspace's id and name, as the dashboard's state and the app's `me` answer it; null for an unknown one. */
export const workspaceRef = (db: Db, workspaceId: string) =>
  db.prepare("SELECT id, name FROM workspaces WHERE id = ?1").bind(workspaceId).first<{ id: string; name: string }>();

/** The workspace's time zone. */
export const workspaceZone = async (db: Db, workspaceId: string) => (await workspaceSettings(db, workspaceId)).timezone;

export async function setWorkspaceSettings(
  db: Db,
  workspaceId: string,
  s: Partial<Omit<WorkspaceSettings, "workspaceId" | "mediaFolder">>,
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

/** Gives the workspace another media folder: checked, and refused when another workspace has it. It only renames the
 *  setting: files already in the old folder stay there (the dashboard says so). Returns the saved name. */
export async function setMediaFolder(db: Db, workspaceId: string, name: string, nowS: number): Promise<string> {
  const folder = checkFolderName(name);
  if (await folderTaken(db, folder, workspaceId)) throw new FolderError(`another workspace uses ${folder}`);
  const cur = await workspaceSettings(db, workspaceId);
  await db
    .prepare(
      `INSERT INTO workspace_settings (workspace_id, timezone, digest_hour, locale, media_folder, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT (workspace_id) DO UPDATE SET media_folder = excluded.media_folder, updated_at = excluded.updated_at`,
    )
    .bind(workspaceId, cur.timezone, cur.digestHour, cur.locale, folder, nowS)
    .run();
  return folder;
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

/** The longest name a person may give (their own or the one shown in a workspace). */
export const NAME_MAX = 60;

export class NameError extends Error {}

/** A name from a request: trimmed, 1 to 60 characters; an empty one is null (back to the fallback). */
export function checkName(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") throw new NameError(`a name is 1 to ${NAME_MAX} characters`);
  const n = raw.trim();
  if (n === "") return null;
  if ([...n].length > NAME_MAX) throw new NameError(`a name is 1 to ${NAME_MAX} characters`);
  return n;
}

const localPart = (email: string | null) => (email ? email.split("@")[0] || null : null);

/** What a person is called in a workspace: their display name there, else their own name, else the email's local
 *  part; null for an unknown user (or one with none of these). Someone who isn't a member is named without the first. */
export async function memberName(db: Db, userId: string, workspaceId: string): Promise<string | null> {
  return (await memberNames(db, [userId], workspaceId)).get(userId) ?? null;
}

/** memberName for a list, in one query; users with no name at all are left out of the map. */
export async function memberNames(db: Db, userIds: string[], workspaceId: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (userIds.length === 0) return out;
  const r = await db
    .prepare(
      `SELECT u.id, u.name, u.email, m.display_name FROM users u
       LEFT JOIN memberships m ON m.user_id = u.id AND m.workspace_id = ?2
       WHERE u.id IN ${jsonList(db, 1)}`,
    )
    .bind(JSON.stringify([...new Set(userIds)]), workspaceId)
    .all<{ id: string; name: string | null; email: string | null; display_name: string | null }>();
  for (const u of r.results) {
    const n = u.display_name || u.name || localPart(u.email);
    if (n) out.set(u.id, n);
  }
  return out;
}

/** A person's own name, everywhere; null goes back to the email's local part. */
export async function setUserName(db: Db, userId: string, name: string | null) {
  await db.prepare("UPDATE users SET name = ?1 WHERE id = ?2").bind(name, userId).run();
}

/** The name shown in one workspace; false when the person isn't a member there. */
export async function setDisplayName(
  db: Db,
  workspaceId: string,
  userId: string,
  name: string | null,
): Promise<boolean> {
  const r = await db
    .prepare("UPDATE memberships SET display_name = ?1 WHERE workspace_id = ?2 AND user_id = ?3 RETURNING user_id")
    .bind(name, workspaceId, userId)
    .all();
  return r.results.length > 0;
}
