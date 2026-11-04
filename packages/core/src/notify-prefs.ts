// Who gets which notifications (Phase 13 part 2). Every note belongs to one of five groups; a person's role gives the
// default for each, and `notify_prefs` keeps only what they changed from it.
import type { Db } from "./db";
import { isRole, type Role } from "./roles";

export const NOTE_GROUPS = ["needs_you", "problems", "published", "inbox", "digest"] as const;
export type NoteGroup = (typeof NOTE_GROUPS)[number];

export const isNoteGroup = (v: unknown): v is NoteGroup => (NOTE_GROUPS as readonly unknown[]).includes(v);

/** Editors can't approve, so what waits for an approval isn't theirs; everyone else gets everything. */
export const roleDefault = (role: Role, grp: NoteGroup): boolean => !(role === "editor" && grp === "needs_you");

export async function effectivePrefs(
  db: Db,
  workspaceId: string,
  userId: string,
  role: Role,
): Promise<{ grp: NoteGroup; enabled: boolean; isDefault: boolean }[]> {
  const { results } = await db
    .prepare("SELECT grp, enabled FROM notify_prefs WHERE workspace_id = ?1 AND user_id = ?2")
    .bind(workspaceId, userId)
    .all<{ grp: string; enabled: number }>();
  const stored = new Map(results.map((r) => [r.grp, !!r.enabled]));
  return NOTE_GROUPS.map((grp) => {
    const own = stored.get(grp);
    return { grp, enabled: own ?? roleDefault(role, grp), isDefault: own === undefined };
  });
}

/** A setting equal to the role's default is no setting: the row goes, so a role change still moves the person. */
export async function setPref(
  db: Db,
  workspaceId: string,
  userId: string,
  role: Role,
  grp: NoteGroup,
  enabled: boolean,
  nowS: number,
): Promise<void> {
  if (enabled === roleDefault(role, grp)) {
    await db
      .prepare("DELETE FROM notify_prefs WHERE workspace_id = ?1 AND user_id = ?2 AND grp = ?3")
      .bind(workspaceId, userId, grp)
      .run();
    return;
  }
  await db
    .prepare(
      `INSERT INTO notify_prefs (workspace_id, user_id, grp, enabled, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT (workspace_id, user_id, grp) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`,
    )
    .bind(workspaceId, userId, grp, enabled ? 1 : 0, nowS)
    .run();
}

/** The workspace's members whose setting for `grp` is on. Members only: an instance admin who isn't one is left out. */
export async function receivers(db: Db, workspaceId: string, grp: NoteGroup): Promise<string[]> {
  const members = await db
    .prepare("SELECT user_id, role FROM memberships WHERE workspace_id = ?1")
    .bind(workspaceId)
    .all<{ user_id: string; role: string }>();
  const rows = await db
    .prepare("SELECT user_id, enabled FROM notify_prefs WHERE workspace_id = ?1 AND grp = ?2")
    .bind(workspaceId, grp)
    .all<{ user_id: string; enabled: number }>();
  const stored = new Map(rows.results.map((r) => [r.user_id, !!r.enabled]));
  return members.results
    .filter((m) => isRole(m.role))
    .filter((m) => stored.get(m.user_id) ?? roleDefault(m.role as Role, grp))
    .map((m) => m.user_id);
}
