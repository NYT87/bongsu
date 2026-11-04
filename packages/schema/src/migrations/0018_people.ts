// People and workspaces (Phase 13 part 1, docs/superpowers/specs/2026-11-04-phase13-people-roles-design.md): instance
// admins, three roles (admin, editor, creator), invites, archived workspaces, a pause per workspace, the workspace a
// session works in, the workspace a store's inbox feeds. A fresh instance loses the baseline's empty `default`
// workspace and `owner` user: its first user creates the first workspace.
import type { Step } from "../migrate";

const ROLES = ["admin", "editor", "creator"];
const roleCheck = `CHECK (role IN (${ROLES.map((r) => `'${r}'`).join(", ")}))`;
// the old roles, each to the new one that can do what it did (an approver approved and proposed: a creator)
const newRole =
  "CASE role WHEN 'owner' THEN 'admin' WHEN 'approver' THEN 'creator' WHEN 'viewer' THEN 'editor' ELSE role END";

const owners =
  "UPDATE users SET instance_admin = 1 WHERE id IN (SELECT user_id FROM memberships WHERE role = 'owner');";

// SQLite can't change a CHECK in place: rebuild the table (create, copy, drop, rename)
const rolesSqlite = [
  `CREATE TABLE memberships_new (
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  user_id TEXT NOT NULL REFERENCES users (id),
  role TEXT NOT NULL ${roleCheck},
  created_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);`,
  `INSERT INTO memberships_new (workspace_id, user_id, role, created_at)
  SELECT workspace_id, user_id, ${newRole}, created_at FROM memberships;`,
  "DROP TABLE memberships;",
  "ALTER TABLE memberships_new RENAME TO memberships;",
].join("\n");

// Postgres names an inline column check <table>_<column>_check; the old one has to go before 'creator' is allowed
const rolesPostgres = [
  "ALTER TABLE memberships DROP CONSTRAINT memberships_role_check;",
  `UPDATE memberships SET role = ${newRole};`,
  `ALTER TABLE memberships ADD CONSTRAINT memberships_role_check ${roleCheck};`,
].join("\n");

// The instance-wide pause becomes the default workspace's (the only one an instance had before workspaces).
const pause = `UPDATE workspace_settings SET paused = (SELECT value FROM settings WHERE key = 'paused') WHERE workspace_id = 'default';
DELETE FROM settings WHERE key = 'paused';`;

// The seed is empty when `default` holds no accounts, plan, drafts or connections, no member but `owner`, and `owner`
// was never claimed (no email, no passkey) nor joined another workspace. Every clause stays true as the rows go, so the
// four deletes (referencing rows first) see the same answer.
const seedEmpty = [
  "NOT EXISTS (SELECT 1 FROM accounts WHERE workspace_id = 'default')",
  "NOT EXISTS (SELECT 1 FROM plan_items WHERE workspace_id = 'default')",
  "NOT EXISTS (SELECT 1 FROM drafts WHERE workspace_id = 'default')",
  "NOT EXISTS (SELECT 1 FROM connections WHERE workspace_id = 'default')",
  "NOT EXISTS (SELECT 1 FROM memberships WHERE workspace_id = 'default' AND user_id <> 'owner')",
  "NOT EXISTS (SELECT 1 FROM memberships WHERE user_id = 'owner' AND workspace_id <> 'default')",
  "NOT EXISTS (SELECT 1 FROM users WHERE id = 'owner' AND email IS NOT NULL)",
  "NOT EXISTS (SELECT 1 FROM passkeys WHERE user_id = 'owner')",
].join("\n  AND ");
const seed = [
  `DELETE FROM memberships WHERE workspace_id = 'default'\n  AND ${seedEmpty};`,
  `DELETE FROM workspace_settings WHERE workspace_id = 'default'\n  AND ${seedEmpty};`,
  `DELETE FROM workspaces WHERE id = 'default'\n  AND ${seedEmpty};`,
  `DELETE FROM users WHERE id = 'owner'\n  AND ${seedEmpty};`,
].join("\n");

export const steps: Step[] = [
  {
    addColumn: {
      table: "users",
      name: "instance_admin",
      column: {
        type: "bool",
        notNull: true,
        default: 0,
        description: "runs the instance: workspaces, media stores, OAuth apps",
      },
    },
  },
  {
    addColumn: {
      table: "workspaces",
      name: "archived_at",
      column: { type: "timestamp", description: "archived: nothing publishes, no one signs in to it; NULL: active" },
    },
  },
  {
    addColumn: {
      table: "workspace_settings",
      name: "paused",
      column: {
        type: "json",
        description: "{reason, by, at} while the workspace's publishing is paused; NULL: running",
      },
    },
  },
  {
    addColumn: {
      table: "sessions",
      name: "workspace_id",
      column: { type: "text", description: "the workspace the session works in; NULL: the user's first" },
    },
  },
  {
    addColumn: {
      table: "media_store",
      name: "inbox_workspace",
      column: { type: "text", description: "the workspace the inbox feeds for a project no plan has; NULL: none" },
    },
  },
  {
    createTable: "invites",
    table: {
      description: "Invitations to a workspace: the link's token (its sha256), for one email and role, single use.",
      columns: {
        token_hash: { type: "id", primaryKey: true },
        workspace_id: { type: "id", notNull: true, references: "workspaces.id" },
        email: { type: "text", notNull: true },
        role: { type: "text", notNull: true, values: ROLES },
        invited_by: { type: "text", notNull: true, description: "users.id" },
        created_at: { type: "timestamp", notNull: true },
        expires_at: { type: "timestamp", notNull: true },
        used_at: { type: "timestamp" },
        used_by: { type: "text", description: "users.id" },
        revoked_at: { type: "timestamp" },
      },
      indexes: [{ name: "invites_workspace", columns: ["workspace_id"] }],
    },
  },
  // whoever owned a workspace keeps running the instance (read before the roles change)
  { sql: { sqlite: owners, postgres: owners } },
  {
    sql: { sqlite: rolesSqlite, postgres: rolesPostgres },
    apply: (t) => {
      t.memberships.columns.role.values = ROLES;
    },
  },
  { sql: { sqlite: pause, postgres: pause } },
  { sql: { sqlite: seed, postgres: seed } },
];
