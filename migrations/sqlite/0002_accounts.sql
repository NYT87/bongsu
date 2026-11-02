-- Accounts, connections, users and workspaces in the database (docs/PLAN.md, Phase 3).
--
-- An account's id is the key the plan data already uses: the Instagram username, or the YouTube channel key
-- (plan_items.account, posted.account, shorts_comments.channel, ...), so existing rows point at their account without
-- being rewritten. Everything belongs to a workspace; this migration creates the default one, its owner and its
-- settings. New columns get their values from the app (no time functions in defaults).

CREATE TABLE workspaces (
  id          TEXT    PRIMARY KEY,
  name        TEXT    NOT NULL,
  created_at  INTEGER NOT NULL
);
INSERT INTO workspaces (id, name, created_at) VALUES ('default', 'Default', 0);

CREATE TABLE workspace_settings (
  workspace_id  TEXT    PRIMARY KEY REFERENCES workspaces (id),
  timezone      TEXT    NOT NULL,                -- IANA name, e.g. Asia/Seoul; dates and times in the plan are in it
  digest_hour   INTEGER NOT NULL CHECK (digest_hour BETWEEN 0 AND 23),
  locale        TEXT    NOT NULL,
  updated_at    INTEGER NOT NULL
);
INSERT INTO workspace_settings (workspace_id, timezone, digest_hour, locale, updated_at) VALUES ('default', 'UTC', 8, 'en', 0);

-- People. The first user is the instance's owner; the dashboard (Phase 4b) gives them an email.
CREATE TABLE users (
  id          TEXT    PRIMARY KEY,
  email       TEXT    UNIQUE,
  name        TEXT,
  created_at  INTEGER NOT NULL
);
INSERT INTO users (id, email, name, created_at) VALUES ('owner', NULL, 'Owner', 0);

CREATE TABLE memberships (
  workspace_id  TEXT    NOT NULL REFERENCES workspaces (id),
  user_id       TEXT    NOT NULL REFERENCES users (id),
  role          TEXT    NOT NULL CHECK (role IN ('owner', 'admin', 'approver', 'editor', 'viewer')),
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);
INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES ('default', 'owner', 'owner', 0);

-- How Bongsu reaches a platform for one or more accounts. Credentials are either encrypted in `credentials`
-- (AES-GCM with the ENCRYPTION_KEY secret, see core/crypto.ts) or, for deployments that set them as secrets, read
-- from the environment variable named in `secret_name`. A Composio connection keeps its connected-account id in
-- `external_ref`.
CREATE TABLE connections (
  id               TEXT    PRIMARY KEY,
  workspace_id     TEXT    NOT NULL REFERENCES workspaces (id),
  provider         TEXT    NOT NULL CHECK (provider IN ('composio', 'youtube', 'google')),
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
CREATE INDEX connections_workspace ON connections (workspace_id);

-- The profiles and channels Bongsu publishes to. capabilities: what the platform allows here, e.g.
-- {"trialReels": true}; settings: the owner's choices, e.g. {"trialReels": false} (the Trial Reels default).
CREATE TABLE accounts (
  id             TEXT    PRIMARY KEY,
  workspace_id   TEXT    NOT NULL REFERENCES workspaces (id),
  platform       TEXT    NOT NULL CHECK (platform IN ('instagram', 'youtube')),
  handle         TEXT    NOT NULL,                -- the Instagram username / the YouTube channel handle
  display_name   TEXT,
  external_id    TEXT,                            -- the Instagram user id / the YouTube channel id
  connection_id  TEXT    REFERENCES connections (id),
  capabilities   TEXT    NOT NULL DEFAULT '{}',
  settings       TEXT    NOT NULL DEFAULT '{}',
  status         TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  sort           INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  UNIQUE (workspace_id, platform, handle)
);
CREATE INDEX accounts_workspace ON accounts (workspace_id, platform);

-- Passkeys belong to a user (were the instance owner's).
ALTER TABLE owner_passkeys RENAME TO passkeys;
ALTER TABLE passkeys ADD COLUMN user_id TEXT NOT NULL DEFAULT 'owner';
ALTER TABLE sessions ADD COLUMN user_id TEXT NOT NULL DEFAULT 'owner';
ALTER TABLE sessions ADD COLUMN app TEXT NOT NULL DEFAULT 'pwa' CHECK (app IN ('pwa', 'dashboard'));
ALTER TABLE setup_codes ADD COLUMN user_id TEXT NOT NULL DEFAULT 'owner';

-- Who acted: approvals and the audit log record the user (null for scripts and the scheduler itself).
ALTER TABLE approvals ADD COLUMN user_id TEXT;
ALTER TABLE audit ADD COLUMN user_id TEXT;

-- Every row of plan data belongs to a workspace.
ALTER TABLE plan_items ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE jobs ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE drafts ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE posted ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE shorts_commented ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE post_results ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE comments ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE comment_polls ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE trial_posts ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE api_keys ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE push_subs ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE push_subs ADD COLUMN user_id TEXT NOT NULL DEFAULT 'owner';
ALTER TABLE audit ADD COLUMN workspace_id TEXT;
ALTER TABLE snapshots ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE reports ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
CREATE INDEX plan_items_workspace ON plan_items (workspace_id, date);
CREATE INDEX jobs_workspace ON jobs (workspace_id, state);
CREATE INDEX drafts_workspace ON drafts (workspace_id, status);

-- The Shorts comment list: its channel is now any YouTube account id (was 'main' or 'vlogs' only). SQLite can't drop
-- a CHECK constraint, so the table is rebuilt.
CREATE TABLE shorts_comments_new (
  video_id      TEXT    PRIMARY KEY,
  channel       TEXT    NOT NULL,                 -- the YouTube account's id
  file          TEXT    NOT NULL,
  label         TEXT,
  sort          INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL DEFAULT 0,
  text          TEXT,
  workspace_id  TEXT    NOT NULL DEFAULT 'default'
);
INSERT INTO shorts_comments_new (video_id, channel, file, label, sort, created_at, text)
  SELECT video_id, channel, file, label, sort, created_at, text FROM shorts_comments;
DROP TABLE shorts_comments;
ALTER TABLE shorts_comments_new RENAME TO shorts_comments;
