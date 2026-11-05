-- Generated from packages/schema (pnpm --filter @bongsu/schema generate): don't edit by hand.

-- A workspace's icon: a PNG (base64), its SHA-256 and when it was set; no row, no icon.
CREATE TABLE workspace_icons (
  workspace_id TEXT NOT NULL,
  png TEXT NOT NULL,
  hash TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id)
);
CREATE INDEX workspace_icons_hash ON workspace_icons (hash);
ALTER TABLE memberships ADD COLUMN display_name TEXT;
ALTER TABLE drafts ADD COLUMN user_id TEXT;
