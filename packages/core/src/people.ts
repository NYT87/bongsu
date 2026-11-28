// People and workspaces (docs/superpowers/specs/2026-11-04-phase13-people-roles-design.md): making users, workspaces
// and memberships. Who may do what is roles.ts; which workspace a request works in is workspaces.ts.
import type { Db } from "./db";
import { isTimeZone } from "./formats/time";
import { checkFolderName, FolderError, folderTaken } from "./media/folders";
import type { Role } from "./roles";

const hex = (bytes: number) =>
  [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");

/** A new user's id, `u_<16 hex>`: made before the user when a passkey's options must name it (the bootstrap). */
export const newUserId = () => `u_${hex(8)}`;

/** A user, by their (lowercased) email. `id` is for a user whose id was handed out already (newUserId). */
export async function createUser(
  db: Db,
  o: { email: string; name: string | null; instanceAdmin?: boolean; id?: string },
  nowS: number,
): Promise<string> {
  const id = o.id ?? newUserId();
  await db
    .prepare("INSERT INTO users (id, email, name, created_at, instance_admin) VALUES (?1, ?2, ?3, ?4, ?5)")
    // a flag kept as 0/1 (SMALLINT on Postgres)
    .bind(id, o.email.trim().toLowerCase(), o.name, nowS, o.instanceAdmin ? 1 : 0)
    .run();
  return id;
}

/** A workspace, `w_<16 hex>`, with its settings: the zone given, the digest at 8, English, a media folder (its id unless given). Nobody's a member yet
 *  (addMember). `createdBy` is who asked; the caller's audit row records it, the workspace has no column for it. */
export async function createWorkspace(
  db: Db,
  o: { name: string; timezone: string; createdBy: string; mediaFolder?: string },
  nowS: number,
): Promise<string> {
  if (!isTimeZone(o.timezone)) throw new Error(`unknown time zone ${o.timezone}`);
  const id = `w_${hex(8)}`;
  // a folder given is checked and must be free; else the workspace's id, which a rename never changes
  const folder = o.mediaFolder === undefined ? id : checkFolderName(o.mediaFolder);
  if (o.mediaFolder !== undefined && (await folderTaken(db, folder)))
    throw new FolderError(`another workspace uses ${folder}`);
  // together: a workspace without settings would fall back to UTC unnoticed
  await db.batch([
    db.prepare("INSERT INTO workspaces (id, name, created_at) VALUES (?1, ?2, ?3)").bind(id, o.name, nowS),
    db
      .prepare(
        "INSERT INTO workspace_settings (workspace_id, timezone, digest_hour, locale, media_folder, updated_at) VALUES (?1, ?2, 8, 'en', ?3, ?4)",
      )
      .bind(id, o.timezone, folder, nowS),
  ]);
  return id;
}

/** Makes the user a member of the workspace with this role (or changes their role there). */
export async function addMember(db: Db, workspaceId: string, userId: string, role: Role, nowS: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = excluded.role`,
    )
    .bind(workspaceId, userId, role, nowS)
    .run();
}

/** The longest a workspace's name may be. */
export const NAME_MAX = 80;

/** A workspace's name from a request, trimmed: null when it's empty or longer than NAME_MAX. */
export function workspaceName(v: unknown): string | null {
  const name = String(v ?? "").trim();
  return name && name.length <= NAME_MAX ? name : null;
}

/** Renames a workspace (archived or not); false when there's none with that id. */
export async function renameWorkspace(db: Db, workspaceId: string, name: string): Promise<boolean> {
  return !!(await db
    .prepare("UPDATE workspaces SET name = ?2 WHERE id = ?1 RETURNING id")
    .bind(workspaceId, name)
    .first());
}

/** Archives a workspace: the tick skips it (data.ts heldWorkspaces), its members can't open it (sessionWorkspace),
 *  its agent keys and CLI tokens stop working (agent/auth.ts); its data stays. False when it's missing or archived. */
export async function archiveWorkspace(db: Db, workspaceId: string, nowS: number): Promise<boolean> {
  return !!(await db
    .prepare("UPDATE workspaces SET archived_at = ?2 WHERE id = ?1 AND archived_at IS NULL RETURNING id")
    .bind(workspaceId, nowS)
    .first());
}

/** Brings an archived workspace back as it was. False when it's missing or not archived. */
export async function restoreWorkspace(db: Db, workspaceId: string): Promise<boolean> {
  return !!(await db
    .prepare("UPDATE workspaces SET archived_at = NULL WHERE id = ?1 AND archived_at IS NOT NULL RETURNING id")
    .bind(workspaceId)
    .first());
}

export class InstanceAdminError extends Error {
  constructor(
    public status: 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

/** Makes a user an instance admin, or not. The last one stays: the condition is in the statement itself, so two
 *  instance admins unmaking each other at once can't both pass a check made before. */
export async function setInstanceAdmin(db: Db, userId: string, on: boolean): Promise<void> {
  // the instance admins' rows locked first, in one transaction: on Postgres two admins demoting each other at once
  // would otherwise each still see the other and leave none
  const [, r] = await db.batch([
    db.prepare("UPDATE users SET instance_admin = instance_admin WHERE instance_admin = 1"),
    db
      .prepare(
        `UPDATE users SET instance_admin = ?2 WHERE id = ?1
         AND (?2 = 1 OR EXISTS (SELECT 1 FROM users o WHERE o.instance_admin = 1 AND o.id <> ?1)) RETURNING id`,
      )
      // a flag kept as 0/1 (SMALLINT on Postgres)
      .bind(userId, on ? 1 : 0),
  ]);
  if (r.results.length) return;
  const known = await db.prepare("SELECT 1 FROM users WHERE id = ?1").bind(userId).first();
  if (!known) throw new InstanceAdminError(404, "no such user");
  throw new InstanceAdminError(409, "the instance keeps one instance admin: make someone else one first");
}

/** How a deleted account is named wherever its old rows show (the audit log, approvals, drafts). */
export const DELETED_USER = "deleted user";

export class AccountError extends Error {
  constructor(
    public status: 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

/** Deletes a person's account (#143), once they're in no workspace (an archived one's membership doesn't count: they
 *  can't open it to leave it). The users row stays as a tombstone, so every row that names it still resolves: its
 *  email, name and settings are cleared and deleted_at stamped. Their passkeys, sessions (signed out everywhere),
 *  recovery codes, devices, notification settings, device codes, OAuth states and their memberships of archived
 *  workspaces go; their CLI tokens and the pending invites they sent are revoked. The email can sign up again, as
 *  someone new. One transaction: the instance admins' rows are locked first, so the last one can't go (nor two at once). */
export async function deleteAccount(db: Db, userId: string, nowS: number): Promise<void> {
  // every step after the tombstone runs only when this call made it (deleted_at = nowS): a refusal changes nothing
  const mine = "EXISTS (SELECT 1 FROM users d WHERE d.id = ?1 AND d.deleted_at = ?2)";
  const step = (sql: string) => db.prepare(`${sql} AND ${mine}`).bind(userId, nowS);
  const [, done] = await db.batch([
    db.prepare("UPDATE users SET instance_admin = instance_admin WHERE instance_admin = 1"),
    db
      .prepare(
        `UPDATE users SET email = NULL, name = NULL, timezone = NULL, theme = NULL, instance_admin = 0, deleted_at = ?2
         WHERE id = ?1 AND deleted_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM memberships m JOIN workspaces w ON w.id = m.workspace_id
             WHERE m.user_id = ?1 AND w.archived_at IS NULL)
           AND (instance_admin = 0 OR EXISTS (SELECT 1 FROM users o WHERE o.instance_admin = 1 AND o.id <> ?1))
         RETURNING id`,
      )
      .bind(userId, nowS),
    step("DELETE FROM passkeys WHERE user_id = ?1"),
    step("DELETE FROM sessions WHERE user_id = ?1"),
    step("DELETE FROM recovery_codes WHERE user_id = ?1"),
    step("DELETE FROM push_subs WHERE user_id = ?1"),
    step("DELETE FROM notify_prefs WHERE user_id = ?1"),
    step("DELETE FROM setup_codes WHERE user_id = ?1"),
    step("DELETE FROM oauth_states WHERE user_id = ?1"),
    step("UPDATE api_keys SET revoked_at = ?2 WHERE user_id = ?1 AND revoked_at IS NULL"),
    step("UPDATE invites SET revoked_at = ?2 WHERE invited_by = ?1 AND used_at IS NULL AND revoked_at IS NULL"),
    // an archived workspace's (they couldn't leave it): restored, it mustn't count a deleted account as its admin
    step("DELETE FROM memberships WHERE user_id = ?1"),
  ]);
  if (done.results.length) return;
  const u = await db
    .prepare(
      `SELECT u.deleted_at, u.instance_admin, EXISTS (SELECT 1 FROM memberships m JOIN workspaces w
         ON w.id = m.workspace_id WHERE m.user_id = u.id AND w.archived_at IS NULL) AS member
       FROM users u WHERE u.id = ?1`,
    )
    .bind(userId)
    .first<{ deleted_at: number | null; instance_admin: number; member: number | boolean }>();
  if (!u || u.deleted_at !== null) throw new AccountError(404, "no such account");
  if (Number(u.member)) throw new AccountError(409, "leave your workspaces first: an account in one can't be deleted");
  throw new AccountError(409, "the instance keeps one instance admin: make someone else one first");
}
