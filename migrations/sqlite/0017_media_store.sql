-- Generated from packages/schema (pnpm --filter @bongsu/schema generate): don't edit by hand.

-- The instance's media stores, one per kind: settings, encrypted credentials, last check, the default.
CREATE TABLE media_store (
  kind TEXT PRIMARY KEY CHECK (kind IN ('drive', 's3', 'local')),
  is_default INTEGER NOT NULL DEFAULT 0,
  settings TEXT NOT NULL DEFAULT '{}',
  credentials TEXT,
  status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'broken')),
  last_error TEXT,
  last_checked_at INTEGER,
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);
