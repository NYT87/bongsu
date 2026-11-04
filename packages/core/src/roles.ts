// Who may do what (docs/superpowers/specs/2026-11-04-phase13-people-roles-design.md, section 1). A workspace member
// has one of ROLES there (memberships.role); an instance admin (users.instance_admin, a flag, not a membership)
// changes what's instance-wide and acts in any workspace with an admin's rights.
import type { Db } from "./db";

export const ROLES = ["admin", "editor", "creator"] as const;
export type Role = (typeof ROLES)[number];

export const isRole = (s: string | null | undefined): s is Role => (ROLES as readonly string[]).includes(s ?? "");

export async function isInstanceAdmin(db: Db, userId: string): Promise<boolean> {
  const r = await db
    .prepare("SELECT instance_admin FROM users WHERE id = ?1")
    .bind(userId)
    .first<{ instance_admin: number | boolean | null }>();
  // SQLite keeps 0/1, Postgres a boolean
  return !!r?.instance_admin;
}
