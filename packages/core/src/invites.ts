// Members and invites (docs/superpowers/specs/2026-11-04-phase13-people-roles-design.md, section 3). An invite is a
// one-time link for an email and a role, valid INVITE_S; only its token's sha256 is kept. Accepting it (api's
// invite routes) makes the person a member; admins change roles and remove members, and a workspace always keeps one
// admin unless an instance admin says otherwise.
import type { Db } from "./db";
import type { Env } from "./env";
import { sha256Hex } from "./formats/approved";
import { mailer } from "./mail";
import type { Role } from "./roles";
import { inviteMail } from "./texts/invites";

/** How long an invite link works. */
export const INVITE_S = 7 * 86400;

/** An invite that can't be used: unknown, used, revoked, expired, or its workspace archived. One kind on purpose:
 *  the answer never says which. */
export class InviteError extends Error {}
/** A change to the members that's refused: `status` 404 (not a member here) or 409 (the last admin). */
export class MemberError extends Error {
  constructor(
    public status: 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

const token = () =>
  btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

/** A new invite: its link (the dashboard for admins and editors, the app for creators), emailed when a Mailer is set.
 *  A mail that fails doesn't undo the invite: the link is shown to copy either way (`mailed` says which). */
export async function createInvite(
  env: Env,
  fetcher: typeof fetch,
  o: { workspaceId: string; email: string; role: Role; invitedBy: string },
  nowS: number,
): Promise<{ url: string; mailed: boolean }> {
  const t = token();
  const email = o.email.trim().toLowerCase();
  await env.DB.prepare(
    `INSERT INTO invites (token_hash, workspace_id, email, role, invited_by, created_at, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  )
    .bind(await sha256Hex(t), o.workspaceId, email, o.role, o.invitedBy, nowS, nowS + INVITE_S)
    .run();
  const base = env.PUBLIC_URL.replace(/\/$/, "");
  const url = o.role === "creator" ? `${base}/#/invite/${t}` : `${base}/dashboard/invite/${t}`;
  let mailed = false;
  try {
    const m = mailer(env, fetcher);
    if (m.id !== "none") {
      const ws = await env.DB.prepare("SELECT name FROM workspaces WHERE id = ?1")
        .bind(o.workspaceId)
        .first<{ name: string }>();
      const by = await env.DB.prepare("SELECT name, email FROM users WHERE id = ?1")
        .bind(o.invitedBy)
        .first<{ name: string | null; email: string | null }>();
      await m.send(
        inviteMail({
          to: email,
          workspace: ws?.name ?? o.workspaceId,
          role: o.role,
          by: by?.name ?? by?.email ?? "An admin",
          url,
          days: INVITE_S / 86400,
        }),
      );
      mailed = true;
    }
  } catch (e) {
    console.warn(`invite mail: ${(e as Error).message}`);
  }
  return { url, mailed };
}

const USABLE = "i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > ?2 AND w.archived_at IS NULL";

/** What an invite link is for, while it can be used; null otherwise (whatever the reason). */
export async function inviteFor(
  db: Db,
  t: string,
  nowS: number,
): Promise<{ workspaceName: string; role: Role; email: string } | null> {
  const r = await db
    .prepare(
      `SELECT w.name, i.role, i.email FROM invites i JOIN workspaces w ON w.id = i.workspace_id
       WHERE i.token_hash = ?1 AND ${USABLE}`,
    )
    .bind(await sha256Hex(t), nowS)
    .first<{ name: string; role: Role; email: string }>();
  return r ? { workspaceName: r.name, role: r.role, email: r.email } : null;
}

/** Uses the invite up (once, even if two tabs race) and makes `userId` a member with its role. Someone already a
 *  member keeps the role they have: an invite never demotes (an admin's last-admin rule stays with setRole). */
export async function acceptInvite(
  db: Db,
  t: string,
  userId: string,
  nowS: number,
): Promise<{ workspaceId: string; role: Role }> {
  const used = await db
    .prepare(
      `UPDATE invites SET used_at = ?2, used_by = ?3 WHERE token_hash = ?1 AND used_at IS NULL AND revoked_at IS NULL
         AND expires_at > ?2 AND workspace_id IN (SELECT id FROM workspaces WHERE archived_at IS NULL)
       RETURNING workspace_id, role`,
    )
    .bind(await sha256Hex(t), nowS, userId)
    .first<{ workspace_id: string; role: Role }>();
  if (!used) throw new InviteError("this invite can't be used");
  const role = await db
    .prepare(
      `INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = memberships.role RETURNING role`,
    )
    .bind(used.workspace_id, userId, used.role, nowS)
    .first<{ role: Role }>();
  return { workspaceId: used.workspace_id, role: role?.role ?? used.role };
}

/** Whether `userId` is the workspace's last admin. */
async function lastAdmin(db: Db, workspaceId: string, userId: string): Promise<boolean> {
  const r = await db
    .prepare(
      `SELECT m.role, (SELECT COUNT(*) FROM memberships a WHERE a.workspace_id = ?1 AND a.role = 'admin') AS admins
       FROM memberships m WHERE m.workspace_id = ?1 AND m.user_id = ?2`,
    )
    .bind(workspaceId, userId)
    .first<{ role: string; admins: number }>();
  if (!r) throw new MemberError(404, "not a member of this workspace");
  return r.role === "admin" && Number(r.admins) <= 1;
}

const LAST_ADMIN = "a workspace keeps one admin: make someone else admin first";

/** Changes a member's role. The last admin stays one, unless an instance admin changes it. */
export async function setRole(
  db: Db,
  workspaceId: string,
  userId: string,
  role: Role,
  by: { instanceAdmin: boolean },
): Promise<void> {
  if (role !== "admin" && (await lastAdmin(db, workspaceId, userId)) && !by.instanceAdmin)
    throw new MemberError(409, LAST_ADMIN);
  await db
    .prepare("UPDATE memberships SET role = ?3 WHERE workspace_id = ?1 AND user_id = ?2")
    .bind(workspaceId, userId, role)
    .run();
}

/** Removes a member, cut off at once from this workspace: their sessions working in it, their CLI tokens for it and
 *  their push devices there go with the membership (a session in no particular workspace stays, but no longer finds
 *  this one). The last admin stays, unless an instance admin removes them. */
export async function removeMember(
  db: Db,
  workspaceId: string,
  userId: string,
  by: { instanceAdmin: boolean },
): Promise<void> {
  if ((await lastAdmin(db, workspaceId, userId)) && !by.instanceAdmin) throw new MemberError(409, LAST_ADMIN);
  await db.batch([
    db.prepare("DELETE FROM memberships WHERE workspace_id = ?1 AND user_id = ?2").bind(workspaceId, userId),
    db.prepare("DELETE FROM sessions WHERE workspace_id = ?1 AND user_id = ?2").bind(workspaceId, userId),
    db.prepare("DELETE FROM api_keys WHERE workspace_id = ?1 AND user_id = ?2").bind(workspaceId, userId),
    db.prepare("DELETE FROM push_subs WHERE workspace_id = ?1 AND user_id = ?2").bind(workspaceId, userId),
  ]);
}
