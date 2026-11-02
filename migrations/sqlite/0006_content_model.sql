-- Platform-neutral content (docs/PLAN.md 2.10). A planned item is a post to one account:
--   format   one of its platform's formats (video, image, carousel, story, text), or NULL: decided by the media at
--            approval (one image → image, several → carousel, one video → video). Reels become 'video', Stories
--            'story', other posts NULL.
--   options  the platform's choices on the post, as JSON: Instagram's location, coverMs and trial move here.
-- kind, cover_ms, trial and location go. Item keys don't change: they're opaque ids now (nothing parses them).
-- accounts.platform and connections.provider lose their CHECKs: the platform and provider registries validate them.
-- Approvals fingerprint texts, media and time, so they stay valid.

CREATE TABLE plan_items_new (
  item_key    TEXT    PRIMARY KEY,
  account     TEXT    NOT NULL,
  folder      TEXT    NOT NULL,
  name        TEXT    NOT NULL,
  format      TEXT,
  options     TEXT    NOT NULL DEFAULT '{}',
  due_at      INTEGER,
  hold        INTEGER NOT NULL DEFAULT 0,
  note        TEXT,
  sort        INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  updated_by  TEXT,
  content     TEXT    NOT NULL DEFAULT 'repo' CHECK (content IN ('repo', 'db')),
  caption     TEXT,
  comment     TEXT,
  comment2    TEXT,
  alt         TEXT,
  media       TEXT,
  draft_id    TEXT,
  title       TEXT,
  texts_at    INTEGER,
  texts_by    TEXT,
  workspace_id TEXT   NOT NULL DEFAULT 'default'
);
INSERT INTO plan_items_new (item_key, account, folder, name, format, options, due_at, hold, note, sort, created_at,
    updated_at, updated_by, content, caption, comment, comment2, alt, media, draft_id, title, texts_at, texts_by,
    workspace_id)
  SELECT item_key, account, folder, name,
    CASE WHEN kind = 'reel' THEN 'video' WHEN format = 'story' THEN 'story' END,
    '{}', due_at, hold, note, sort, created_at, updated_at, updated_by, content, caption, comment, comment2, alt,
    media, draft_id, title, texts_at, texts_by, workspace_id
  FROM plan_items;
UPDATE plan_items_new SET options = json_set(options, '$.location',
    (SELECT o.location FROM plan_items o WHERE o.item_key = plan_items_new.item_key))
  WHERE item_key IN (SELECT item_key FROM plan_items WHERE location IS NOT NULL AND location != '');
UPDATE plan_items_new SET options = json_set(options, '$.coverMs',
    (SELECT o.cover_ms FROM plan_items o WHERE o.item_key = plan_items_new.item_key))
  WHERE item_key IN (SELECT item_key FROM plan_items WHERE cover_ms IS NOT NULL);
UPDATE plan_items_new SET options = json_set(options, '$.trial',
    json(CASE (SELECT o.trial FROM plan_items o WHERE o.item_key = plan_items_new.item_key) WHEN 1 THEN 'true' ELSE 'false' END))
  WHERE item_key IN (SELECT item_key FROM plan_items WHERE trial IS NOT NULL);
DROP TABLE plan_items;
ALTER TABLE plan_items_new RENAME TO plan_items;
CREATE INDEX plan_items_account_due ON plan_items (account, due_at);
CREATE INDEX plan_items_workspace_due ON plan_items (workspace_id, due_at);

-- accounts: any registered platform
CREATE TABLE accounts_new (
  id             TEXT    PRIMARY KEY,
  workspace_id   TEXT    NOT NULL REFERENCES workspaces (id),
  platform       TEXT    NOT NULL,
  handle         TEXT    NOT NULL,
  display_name   TEXT,
  external_id    TEXT,
  connection_id  TEXT    REFERENCES connections (id),
  capabilities   TEXT    NOT NULL DEFAULT '{}',
  settings       TEXT    NOT NULL DEFAULT '{}',
  status         TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  sort           INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  UNIQUE (workspace_id, platform, handle)
);
INSERT INTO accounts_new SELECT id, workspace_id, platform, handle, display_name, external_id, connection_id,
  capabilities, settings, status, sort, created_at, updated_at FROM accounts;
DROP TABLE accounts;
ALTER TABLE accounts_new RENAME TO accounts;
CREATE INDEX accounts_workspace ON accounts (workspace_id, platform);

-- connections: any registered provider (the accounts let go of their connection during the rebuild, as in 0005)
CREATE TABLE account_connection_keep AS SELECT id, connection_id FROM accounts WHERE connection_id IS NOT NULL;
UPDATE accounts SET connection_id = NULL;
CREATE TABLE connections_new (
  id               TEXT    PRIMARY KEY,
  workspace_id     TEXT    NOT NULL REFERENCES workspaces (id),
  provider         TEXT    NOT NULL,
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

-- jobs: kind is the post's format (video, image, carousel, story, text) or 'comment' (a comment on a post published
-- elsewhere: the Shorts comments), instead of Instagram's reel / photo / carousel / shorts_comment.
CREATE TABLE jobs_new (
  id            INTEGER PRIMARY KEY,
  item_key      TEXT    NOT NULL UNIQUE,
  kind          TEXT    NOT NULL,
  account       TEXT    NOT NULL,
  due_at        INTEGER NOT NULL,
  state         TEXT    NOT NULL DEFAULT 'pending'
                CHECK (state IN ('pending', 'container_created', 'published', 'done', 'refused', 'failed', 'held')),
  container_id  TEXT,
  children      TEXT,
  media_id      TEXT,
  permalink     TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  dry_run       INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  payload       TEXT    NOT NULL DEFAULT '{}',
  notified_at   INTEGER,
  workspace_id  TEXT    NOT NULL DEFAULT 'default'
);
INSERT INTO jobs_new (id, item_key, kind, account, due_at, state, container_id, children, media_id, permalink, attempts,
    last_error, dry_run, created_at, updated_at, payload, notified_at, workspace_id)
  SELECT id, item_key,
    CASE
      WHEN kind = 'shorts_comment' THEN 'comment'
      WHEN json_extract(payload, '$.story') = 1 THEN 'story'
      WHEN kind = 'reel' THEN 'video'
      WHEN kind = 'photo' THEN 'image'
      ELSE kind
    END,
    account, due_at, state, container_id, children, media_id, permalink, attempts, last_error, dry_run, created_at,
    updated_at, payload, notified_at, workspace_id
  FROM jobs;
DROP TABLE jobs;
ALTER TABLE jobs_new RENAME TO jobs;
CREATE INDEX jobs_state_due ON jobs (state, due_at);
CREATE INDEX jobs_workspace ON jobs (workspace_id, state);
