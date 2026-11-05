-- Generated from packages/schema (pnpm --filter @bongsu/schema generate): don't edit by hand.

CREATE TABLE media_store_new (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('drive', 's3', 'local')),
  workspace_id TEXT,
  is_default INTEGER NOT NULL DEFAULT 0,
  settings TEXT NOT NULL DEFAULT '{}',
  credentials TEXT,
  status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'broken')),
  last_error TEXT,
  last_checked_at INTEGER,
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);
INSERT INTO media_store_new (id, kind, workspace_id, is_default, settings, credentials, status, last_error, last_checked_at, updated_at, updated_by)
  SELECT kind, kind, NULL, is_default, settings, credentials, status, last_error, last_checked_at, updated_at, updated_by FROM media_store;
DROP TABLE media_store;
ALTER TABLE media_store_new RENAME TO media_store;
ALTER TABLE workspace_settings ADD COLUMN media_folder TEXT;
UPDATE workspace_settings SET media_folder = CASE WHEN workspace_id = 'default' THEN 'UPLOADS' ELSE workspace_id END;
CREATE UNIQUE INDEX workspace_settings_media_folder ON workspace_settings (media_folder);
-- A workspace's own OAuth apps (Google, Meta), used instead of the instance's for its connections.
CREATE TABLE workspace_oauth_apps (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  client_secret TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT,
  PRIMARY KEY (workspace_id, id)
);
ALTER TABLE oauth_states ADD COLUMN app_scope TEXT CHECK (app_scope IN ('workspace', 'instance'));
