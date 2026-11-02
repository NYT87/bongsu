-- Connections can be 'instagram' (the Instagram API with Instagram Login, a long-lived token in `credentials` or in
-- the secret named by `secret_name`; providers/instagram-graph.ts). SQLite can't change a CHECK, so the table is
-- rebuilt with its rows. D1 enforces foreign keys and dropping a parent table counts its children as violations even
-- when deferred, so the accounts let go of their connection first and take it back after (same ids).

CREATE TABLE account_connection_keep AS SELECT id, connection_id FROM accounts WHERE connection_id IS NOT NULL;
UPDATE accounts SET connection_id = NULL;

CREATE TABLE connections_new (
  id               TEXT    PRIMARY KEY,
  workspace_id     TEXT    NOT NULL REFERENCES workspaces (id),
  provider         TEXT    NOT NULL CHECK (provider IN ('composio', 'instagram', 'youtube', 'google')),
  kind             TEXT    NOT NULL CHECK (kind IN ('composio', 'oauth', 'service')),
  label            TEXT,
  external_ref     TEXT,
  credentials      TEXT,
  secret_name      TEXT,
  status           TEXT    NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'expiring', 'broken')),
  expires_at       INTEGER,
  last_error       TEXT,
  last_checked_at  INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
INSERT INTO connections_new SELECT id, workspace_id, provider, kind, label, external_ref, credentials, secret_name,
  status, expires_at, last_error, last_checked_at, created_at, updated_at FROM connections;
DROP TABLE connections;
ALTER TABLE connections_new RENAME TO connections;
CREATE INDEX connections_workspace ON connections (workspace_id);

UPDATE accounts SET connection_id = (SELECT k.connection_id FROM account_connection_keep k WHERE k.id = accounts.id)
  WHERE id IN (SELECT id FROM account_connection_keep);
DROP TABLE account_connection_keep;
