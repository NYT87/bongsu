-- Generated from packages/schema (pnpm --filter @bongsu/schema generate): don't edit by hand.

-- The metrics series: one row per sample of a published post's lifetime counts (NULL when the platform gives none).
CREATE TABLE post_metrics (
  id INTEGER PRIMARY KEY,
  item_key TEXT NOT NULL,
  account TEXT NOT NULL,
  platform TEXT NOT NULL,
  media_id TEXT NOT NULL,
  taken_at INTEGER NOT NULL,
  views INTEGER,
  reach INTEGER,
  likes INTEGER,
  comments INTEGER,
  saves INTEGER,
  shares INTEGER,
  workspace_id TEXT NOT NULL DEFAULT 'default'
);
CREATE INDEX post_metrics_item ON post_metrics (item_key, taken_at);
CREATE INDEX post_metrics_ws ON post_metrics (workspace_id, taken_at);
INSERT INTO post_metrics (item_key, account, platform, media_id, taken_at, views, reach, likes, comments, saves, shares, workspace_id)
  SELECT item_key, account, 'instagram', media_id, fetched_at, views, reach, likes, comments, saves, shares, workspace_id FROM post_results;
CREATE TABLE post_results_new (
  item_key TEXT PRIMARY KEY,
  account TEXT NOT NULL,
  media_id TEXT NOT NULL,
  median_views REAL,
  fetched_at INTEGER NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT 'default'
);
INSERT INTO post_results_new (item_key, account, media_id, median_views, fetched_at, workspace_id)
  SELECT item_key, account, media_id, median_views, fetched_at, workspace_id FROM post_results;
DROP TABLE post_results;
ALTER TABLE post_results_new RENAME TO post_results;
