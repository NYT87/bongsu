// People and workspaces (docs/superpowers/specs/2026-11-04-phase13-people-roles-design.md): making users, workspaces
// and memberships. Who may do what is roles.ts; which workspace a request works in is workspaces.ts.
import type { Db } from "./db";
import { isTimeZone } from "./formats/time";
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

/** A workspace, `w_<16 hex>`, with its settings: the zone given, the digest at 8, English. Nobody's a member yet
 *  (addMember). `createdBy` is who asked; the caller's audit row records it, the workspace has no column for it. */
export async function createWorkspace(
  db: Db,
  o: { name: string; timezone: string; createdBy: string },
  nowS: number,
): Promise<string> {
  if (!isTimeZone(o.timezone)) throw new Error(`unknown time zone ${o.timezone}`);
  const id = `w_${hex(8)}`;
  // together: a workspace without settings would fall back to UTC unnoticed
  await db.batch([
    db.prepare("INSERT INTO workspaces (id, name, created_at) VALUES (?1, ?2, ?3)").bind(id, o.name, nowS),
    db
      .prepare(
        "INSERT INTO workspace_settings (workspace_id, timezone, digest_hour, locale, updated_at) VALUES (?1, ?2, 8, 'en', ?3)",
      )
      .bind(id, o.timezone, nowS),
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
