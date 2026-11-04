-- Generated from packages/schema (pnpm --filter @bongsu/schema generate): don't edit by hand.

ALTER TABLE "users" ADD COLUMN "instance_admin" SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE "workspaces" ADD COLUMN "archived_at" BIGINT;
ALTER TABLE "workspace_settings" ADD COLUMN "paused" TEXT;
ALTER TABLE "sessions" ADD COLUMN "workspace_id" TEXT;
ALTER TABLE "media_store" ADD COLUMN "inbox_workspace" TEXT;
-- Invitations to a workspace: the link's token (its sha256), for one email and role, single use.
CREATE TABLE "invites" (
  "token_hash" TEXT PRIMARY KEY,
  "workspace_id" TEXT NOT NULL REFERENCES "workspaces" ("id"),
  "email" TEXT NOT NULL,
  "role" TEXT NOT NULL CHECK ("role" IN ('admin', 'editor', 'creator')),
  "invited_by" TEXT NOT NULL,
  "created_at" BIGINT NOT NULL,
  "expires_at" BIGINT NOT NULL,
  "used_at" BIGINT,
  "used_by" TEXT,
  "revoked_at" BIGINT
);
CREATE INDEX "invites_workspace" ON "invites" ("workspace_id");
UPDATE users SET instance_admin = 1 WHERE id IN (SELECT user_id FROM memberships WHERE role = 'owner');
ALTER TABLE memberships DROP CONSTRAINT memberships_role_check;
UPDATE memberships SET role = CASE role WHEN 'owner' THEN 'admin' WHEN 'approver' THEN 'creator' WHEN 'viewer' THEN 'editor' ELSE role END;
ALTER TABLE memberships ADD CONSTRAINT memberships_role_check CHECK (role IN ('admin', 'editor', 'creator'));
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
