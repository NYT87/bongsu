-- The dashboard's connect flows (Phase 4b): the owner's own OAuth apps (one Meta app for Instagram, one Google app for
-- YouTube), their secrets encrypted with ENCRYPTION_KEY, and the OAuth `state` of each flow in progress.

CREATE TABLE oauth_apps (
  id             TEXT    PRIMARY KEY,           -- "meta", "google" (ConnectSpec.app)
  client_id      TEXT    NOT NULL,
  client_secret  TEXT    NOT NULL,              -- encrypted (core/crypto.ts)
  updated_at     INTEGER NOT NULL,
  updated_by     TEXT
);

-- One row per flow: the state's hash, the PKCE verifier, who started it and the connection it renews (reconnect).
-- Single use, 15 minutes.
CREATE TABLE oauth_states (
  state_hash     TEXT    PRIMARY KEY,
  provider       TEXT    NOT NULL,
  user_id        TEXT    NOT NULL,
  verifier       TEXT,
  connection_id  TEXT,
  created_at     INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL,
  used_at        INTEGER
);
