-- Generated from packages/schema (pnpm --filter @bongsu/schema generate): don't edit by hand.

-- A person's notification settings in a workspace: only the groups they changed from their role's default.
CREATE TABLE "notify_prefs" (
  "workspace_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "grp" TEXT NOT NULL CHECK ("grp" IN ('needs_you', 'problems', 'published', 'inbox', 'digest')),
  "enabled" INTEGER NOT NULL,
  "updated_at" BIGINT NOT NULL,
  PRIMARY KEY ("workspace_id", "user_id", "grp")
);
ALTER TABLE push_subs DROP COLUMN workspace_id;
