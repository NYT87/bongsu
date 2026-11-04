-- Generated from packages/schema (pnpm --filter @bongsu/schema generate): don't edit by hand.

ALTER TABLE users ADD COLUMN instance_admin INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workspaces ADD COLUMN archived_at INTEGER;
ALTER TABLE workspace_settings ADD COLUMN paused TEXT;
ALTER TABLE sessions ADD COLUMN workspace_id TEXT;
ALTER TABLE media_store ADD COLUMN inbox_workspace TEXT;
-- Invitations to a workspace: the link's token (its sha256), for one email and role, single use.
CREATE TABLE invites (
  token_hash TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'editor', 'creator')),
  invited_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  used_by TEXT,
  revoked_at INTEGER
);
CREATE INDEX invites_workspace ON invites (workspace_id);
CREATE TABLE memberships_new (
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  user_id TEXT NOT NULL REFERENCES users (id),
  role TEXT NOT NULL CHECK (role IN ('admin', 'editor', 'creator')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);
INSERT INTO memberships_new (workspace_id, user_id, role, created_at)
  SELECT workspace_id, user_id, CASE role WHEN 'owner' THEN 'admin' WHEN 'approver' THEN 'creator' WHEN 'viewer' THEN 'editor' ELSE role END, created_at FROM memberships;
DROP TABLE memberships;
ALTER TABLE memberships_new RENAME TO memberships;
UPDATE workspace_settings SET paused = (SELECT value FROM settings WHERE key = 'paused') WHERE workspace_id = 'default';
DELETE FROM settings WHERE key = 'paused';
DELETE FROM memberships WHERE workspace_id = 'default'
  AND NOT EXISTS (SELECT 1 FROM accounts WHERE workspace_id = 'default')
  AND NOT EXISTS (SELECT 1 FROM plan_items WHERE workspace_id = 'default')
  AND NOT EXISTS (SELECT 1 FROM drafts WHERE workspace_id = 'default')
  AND NOT EXISTS (SELECT 1 FROM connections WHERE workspace_id = 'default')
  AND NOT EXISTS (SELECT 1 FROM memberships WHERE workspace_id = 'default' AND user_id <> 'owner')
  AND NOT EXISTS (SELECT 1 FROM memberships WHERE user_id = 'owner' AND workspace_id <> 'default')
  AND NOT EXISTS (SELECT 1 FROM users WHERE id = 'owner' AND email IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM passkeys WHERE user_id = 'owner');
DELETE FROM workspace_settings WHERE workspace_id = 'default'
  AND NOT EXISTS (SELECT 1 FROM accounts WHERE workspace_id = 'default')
  AND NOT EXISTS (SELECT 1 FROM plan_items WHERE workspace_id = 'default')
  AND NOT EXISTS (SELECT 1 FROM drafts WHERE workspace_id = 'default')
  AND NOT EXISTS (SELECT 1 FROM connections WHERE workspace_id = 'default')
  AND NOT EXISTS (SELECT 1 FROM memberships WHERE workspace_id = 'default' AND user_id <> 'owner')
  AND NOT EXISTS (SELECT 1 FROM memberships WHERE user_id = 'owner' AND workspace_id <> 'default')
  AND NOT EXISTS (SELECT 1 FROM users WHERE id = 'owner' AND email IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM passkeys WHERE user_id = 'owner');
DELETE FROM workspaces WHERE id = 'default'
  AND NOT EXISTS (SELECT 1 FROM accounts WHERE workspace_id = 'default')
  AND NOT EXISTS (SELECT 1 FROM plan_items WHERE workspace_id = 'default')
  AND NOT EXISTS (SELECT 1 FROM drafts WHERE workspace_id = 'default')
  AND NOT EXISTS (SELECT 1 FROM connections WHERE workspace_id = 'default')
  AND NOT EXISTS (SELECT 1 FROM memberships WHERE workspace_id = 'default' AND user_id <> 'owner')
  AND NOT EXISTS (SELECT 1 FROM memberships WHERE user_id = 'owner' AND workspace_id <> 'default')
  AND NOT EXISTS (SELECT 1 FROM users WHERE id = 'owner' AND email IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM passkeys WHERE user_id = 'owner');
DELETE FROM users WHERE id = 'owner'
  AND NOT EXISTS (SELECT 1 FROM accounts WHERE workspace_id = 'default')
  AND NOT EXISTS (SELECT 1 FROM plan_items WHERE workspace_id = 'default')
  AND NOT EXISTS (SELECT 1 FROM drafts WHERE workspace_id = 'default')
  AND NOT EXISTS (SELECT 1 FROM connections WHERE workspace_id = 'default')
  AND NOT EXISTS (SELECT 1 FROM memberships WHERE workspace_id = 'default' AND user_id <> 'owner')
  AND NOT EXISTS (SELECT 1 FROM memberships WHERE user_id = 'owner' AND workspace_id <> 'default')
  AND NOT EXISTS (SELECT 1 FROM users WHERE id = 'owner' AND email IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM passkeys WHERE user_id = 'owner');
