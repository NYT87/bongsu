-- Bongsu schema (SQLite / Cloudflare D1). One migration for a fresh database; later changes get their own files.

CREATE TABLE jobs (
  id            INTEGER PRIMARY KEY,
  item_key      TEXT    NOT NULL UNIQUE,        -- e.g. reel:demo/short2_bridge
  kind          TEXT    NOT NULL CHECK (kind IN ('reel', 'photo', 'carousel', 'shorts_comment')),
  account       TEXT    NOT NULL,               -- Composio account id, or the YouTube channel (main / vlogs)
  due_at        INTEGER NOT NULL,
  state         TEXT    NOT NULL DEFAULT 'pending' CHECK (state IN (
                  'pending',             -- due; fingerprints not checked yet
                  'container_created',   -- Instagram is processing; poll on the next tick
                  'published',           -- live; the self-comment still to do
                  'done',                -- everything finished
                  'refused',             -- fingerprint changed / media missing / lint failed: needs a new approval
                  'failed',              -- gave up after retries
                  'held')),              -- paused by hand
  container_id  TEXT,
  children      TEXT,                           -- JSON array of carousel child container ids
  media_id      TEXT,
  permalink     TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  dry_run       INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at    INTEGER NOT NULL DEFAULT (unixepoch())
, payload TEXT NOT NULL DEFAULT '{}', notified_at INTEGER);

CREATE INDEX jobs_state_due ON jobs (state, due_at);

CREATE TABLE locks (
  name        TEXT    PRIMARY KEY,
  holder      TEXT    NOT NULL,
  expires_at  INTEGER NOT NULL
);

CREATE TABLE drafts (
  id            TEXT    PRIMARY KEY,            -- random id
  kind          TEXT    NOT NULL CHECK (kind IN ('reel', 'photo', 'carousel', 'shorts_comment')),
  account       TEXT    NOT NULL,
  payload       TEXT    NOT NULL,               -- JSON: caption, comment, time, location, media refs (Drive ids)
  fingerprints  TEXT,                           -- JSON: caption sha256, Drive md5 per media file
  checks        TEXT,                           -- JSON: caption lint and dry-run results
  source        TEXT    NOT NULL CHECK (source IN ('api', 'pwa', 'drive', 'pc')),
  created_by    TEXT    NOT NULL,               -- api key id, or 'owner'
  status        TEXT    NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'refused', 'withdrawn')),
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at    INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX drafts_status_created ON drafts (status, created_at);

CREATE TABLE api_keys (
  id            TEXT    PRIMARY KEY,
  name          TEXT    NOT NULL,
  key_hash      TEXT    NOT NULL UNIQUE,
  scopes        TEXT    NOT NULL,               -- JSON array
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  last_used_at  INTEGER,
  revoked_at    INTEGER
);

CREATE TABLE push_subs (
  id          INTEGER PRIMARY KEY,
  endpoint    TEXT    NOT NULL UNIQUE,
  p256dh      TEXT    NOT NULL,
  auth        TEXT    NOT NULL,
  device      TEXT,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  last_ok_at  INTEGER
);

CREATE TABLE audit (
  id      INTEGER PRIMARY KEY,
  at      INTEGER NOT NULL DEFAULT (unixepoch()),
  actor   TEXT    NOT NULL,                     -- 'cron', 'owner', or an api key id
  action  TEXT    NOT NULL,
  target  TEXT,
  detail  TEXT                                  -- JSON
);

CREATE INDEX audit_at ON audit (at);

CREATE TABLE rate_limits (
  key_id  TEXT    NOT NULL,
  window  INTEGER NOT NULL,              -- unix minute
  n       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key_id, window)
);

CREATE INDEX audit_actor_at ON audit (actor, at);

CREATE TABLE owner_passkeys (
  id            TEXT    PRIMARY KEY,           -- credential id (base64url)
  public_key    TEXT    NOT NULL,              -- COSE public key (base64url)
  counter       INTEGER NOT NULL DEFAULT 0,
  transports    TEXT,                          -- JSON array
  name          TEXT,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  last_used_at  INTEGER
);

CREATE TABLE sessions (
  token_hash  TEXT    PRIMARY KEY,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at  INTEGER NOT NULL
);

CREATE INDEX sessions_expires ON sessions (expires_at);

CREATE TABLE challenges (
  id          TEXT    PRIMARY KEY,
  challenge   TEXT    NOT NULL,
  purpose     TEXT    NOT NULL CHECK (purpose IN ('setup', 'login', 'approve')),
  data        TEXT,
  expires_at  INTEGER NOT NULL
);

CREATE TABLE setup_codes (
  code_hash   TEXT    PRIMARY KEY,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER
);

CREATE TABLE plan_items (
  item_key    TEXT    PRIMARY KEY,              -- "reel:<project>/<base>" or "post:<project>/<post dir>"
  kind        TEXT    NOT NULL CHECK (kind IN ('reel', 'post')),
  account     TEXT    NOT NULL,                 -- Instagram username (demo_travel, demo_running)
  folder      TEXT    NOT NULL,                 -- under channels/, e.g. vlogs/CONTENT/20260823_LISBON
  name        TEXT    NOT NULL,                 -- the Reel's base, or the post dir (e.g. posts/carousel2_bridges)
  date        TEXT,                             -- YYYY-MM-DD, local; NULL = not scheduled ('-')
  time        TEXT,                             -- HH:MM, local; NULL = the default (Reels 18:00, posts 19:00)
  location    TEXT,                             -- facebook_places_id
  hold        INTEGER NOT NULL DEFAULT 0,
  note        TEXT,
  sort        INTEGER NOT NULL DEFAULT 0,       -- order within a queue (as the file's lines were)
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_by  TEXT
, content TEXT NOT NULL DEFAULT 'repo' CHECK (content IN ('repo', 'db')), caption TEXT, comment TEXT, alt TEXT, media TEXT, draft_id TEXT, title TEXT, comment2 TEXT, format TEXT CHECK (format IS NULL OR format IN ('feed', 'story')), cover_ms INTEGER, trial INTEGER CHECK (trial IN (0, 1)), texts_at INTEGER, texts_by TEXT);

CREATE INDEX plan_items_account_date ON plan_items (account, date);

CREATE TABLE approvals (
  id           INTEGER PRIMARY KEY,
  item_key     TEXT    NOT NULL,
  due          TEXT,                            -- "YYYY-MM-DD HH:MM", local
  caption_sha  TEXT,
  comment_sha  TEXT,
  alt_sha      TEXT,
  media        TEXT    NOT NULL DEFAULT '[]',   -- JSON [{"driveId","md5"}], slide order
  approved_at  TEXT    NOT NULL,                -- UTC ISO 8601
  approved_by  TEXT    NOT NULL
, comment2_sha TEXT);

CREATE INDEX approvals_key ON approvals (item_key, id);

CREATE TABLE posted (
  item_key    TEXT    PRIMARY KEY,
  account     TEXT    NOT NULL,
  date        TEXT    NOT NULL,                 -- YYYY-MM-DD, local
  media_id    TEXT,
  permalink   TEXT,
  source      TEXT    NOT NULL DEFAULT 'scheduler' CHECK (source IN ('scheduler', 'manual', 'import')),
  at          INTEGER NOT NULL DEFAULT (unixepoch())
, published_at INTEGER);

CREATE INDEX posted_account_date ON posted (account, date);

CREATE TABLE shorts_comments (
  video_id    TEXT    PRIMARY KEY,
  channel     TEXT    NOT NULL CHECK (channel IN ('main', 'vlogs')),
  file        TEXT    NOT NULL,                 -- the comment text file, from the repo root
  label       TEXT,
  sort        INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
, text TEXT);

CREATE TABLE shorts_commented (
  video_id    TEXT    PRIMARY KEY,
  channel     TEXT    NOT NULL,
  date_pt     TEXT    NOT NULL,                 -- the day in Pacific time, as yt.py logged it
  thread_id   TEXT,
  label       TEXT,
  source      TEXT    NOT NULL DEFAULT 'scheduler' CHECK (source IN ('scheduler', 'manual', 'import')),
  at          INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE settings (
  key         TEXT    PRIMARY KEY,
  value       TEXT    NOT NULL,
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE inbox_seen (
  drive_id  TEXT    PRIMARY KEY,
  draft_id  TEXT    NOT NULL,
  at        INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE drive_cleanup (
  drive_id  TEXT    PRIMARY KEY,
  item_key  TEXT    NOT NULL,
  moved_at  INTEGER,
  refused   TEXT
);

CREATE INDEX drive_cleanup_item ON drive_cleanup (item_key);

CREATE TABLE post_results (
  item_key      TEXT    PRIMARY KEY,
  account       TEXT    NOT NULL,                 -- Instagram username
  media_id      TEXT    NOT NULL,
  views         INTEGER, reach INTEGER, likes INTEGER, comments INTEGER, saves INTEGER, shares INTEGER,
  median_views  REAL,                             -- the account's median views over earlier results (NULL: none yet)
  fetched_at    INTEGER NOT NULL
);

CREATE TABLE comments (
  id          TEXT    PRIMARY KEY,                -- "ig:<comment id>" / "yt:<comment id>"
  platform    TEXT    NOT NULL CHECK (platform IN ('ig', 'yt')),
  account     TEXT    NOT NULL,                   -- Instagram username, or main / vlogs
  media_id    TEXT    NOT NULL,                   -- Instagram media id, or YouTube video id
  item_key    TEXT,                               -- the plan item (Instagram), or comment:<video id> (YouTube)
  author      TEXT    NOT NULL,
  text        TEXT    NOT NULL,
  at          INTEGER NOT NULL,                   -- unix seconds, when it was written
  own         INTEGER NOT NULL DEFAULT 0,         -- ours (the self-comment, our replies): never notified
  seen        INTEGER NOT NULL DEFAULT 0,
  reply_text  TEXT,
  replied_at  INTEGER
);

CREATE INDEX comments_unseen ON comments (seen, own, at);

CREATE TABLE comment_polls (
  media_id    TEXT    PRIMARY KEY,
  platform    TEXT    NOT NULL,
  account     TEXT    NOT NULL,
  item_key    TEXT,
  since       INTEGER NOT NULL,                   -- when it went out (polled for 14 days)
  checked_at  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE trial_posts (
  item_key     TEXT    PRIMARY KEY,                -- the regular Reel's plan key
  account      TEXT    NOT NULL,                   -- Instagram username
  media_id     TEXT,
  permalink    TEXT,
  published_at INTEGER,
  at           INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE account_settings (
  account     TEXT    PRIMARY KEY,                 -- Instagram username
  trial_reels INTEGER NOT NULL CHECK (trial_reels IN (0, 1)),
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE snapshots (
  day      TEXT    PRIMARY KEY,                    -- YYYY-MM-DD, the day the snapshot is for
  taken    TEXT    NOT NULL,                       -- the snapshot's own "taken" time
  source   TEXT    NOT NULL,                       -- 'ci' (the nightly collect), 'pc', 'backfill'
  data     TEXT    NOT NULL,                       -- the snapshot JSON as collect.py wrote it
  saved_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE reports (
  name     TEXT    PRIMARY KEY,                    -- the file's name without .md, e.g. 2026-10-21 or 2026-10-10_vlogs-shorts
  markdown TEXT    NOT NULL,
  saved_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE labels (
  id         TEXT    PRIMARY KEY,                  -- the content id (YouTube video id, Instagram media id)
  data       TEXT    NOT NULL,                     -- the JSON object as in labels.json
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_by TEXT    NOT NULL DEFAULT 'pc'
);

CREATE TABLE manual_stats (
  id         TEXT    PRIMARY KEY,                  -- the item's id (as in manual.csv)
  data       TEXT    NOT NULL,                     -- the CSV row as a JSON object (MANUAL_COLUMNS in server/tools/db.py)
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_by TEXT    NOT NULL DEFAULT 'pc'
);
