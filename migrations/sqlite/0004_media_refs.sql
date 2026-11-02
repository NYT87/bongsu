-- Media references name their store (docs/PLAN.md 2.4, Phase 4): {"store", "id", "checksum"} instead of Drive's
-- {"driveId", "md5"}. Existing rows map to store "drive" with the same id and md5, so approvals stay valid.

-- approvals.media: [{"driveId","md5"}] → [{"store","id","checksum"}], same order
UPDATE approvals SET media = (
  SELECT json_group_array(json_object('store', 'drive', 'id', json_extract(e.value, '$.driveId'),
                                      'checksum', json_extract(e.value, '$.md5')))
  FROM (SELECT value FROM json_each(approvals.media) ORDER BY key) e
) WHERE media LIKE '%"driveId"%';

-- jobs carry the approval they were queued with: same rewrite in payload.approval.media
UPDATE jobs SET payload = json_set(payload, '$.approval.media', json((
  SELECT json_group_array(json_object('store', 'drive', 'id', json_extract(e.value, '$.driveId'),
                                      'checksum', json_extract(e.value, '$.md5')))
  FROM (SELECT value FROM json_each(jobs.payload, '$.approval.media') ORDER BY key) e
))) WHERE json_extract(payload, '$.approval.media[0].driveId') IS NOT NULL;

-- plan_items.media (items from a draft): ["<drive id>", …] → [{"store","id"}]
UPDATE plan_items SET media = (
  SELECT json_group_array(json_object('store', 'drive', 'id', e.value))
  FROM (SELECT value FROM json_each(plan_items.media) ORDER BY key) e
) WHERE media LIKE '["%';

-- drafts: payload.media ["<id>", …] → [{"store","id"}]; payload.files [{"driveId","name","mimeType","md5"}] →
-- [{"store","id","name","mime","checksum"}]
UPDATE drafts SET payload = json_set(payload,
  '$.media', json((SELECT json_group_array(json_object('store', 'drive', 'id', e.value))
                   FROM (SELECT value FROM json_each(drafts.payload, '$.media') ORDER BY key) e)),
  '$.files', json((SELECT json_group_array(json_object('store', 'drive', 'id', json_extract(f.value, '$.driveId'),
                                                       'name', json_extract(f.value, '$.name'),
                                                       'mime', json_extract(f.value, '$.mimeType'),
                                                       'checksum', COALESCE(json_extract(f.value, '$.md5'), '')))
                   FROM (SELECT value FROM json_each(drafts.payload, '$.files') ORDER BY key) f))
) WHERE json_type(payload, '$.media[0]') = 'text';

-- inbox_seen and drive_cleanup are keyed by (store, id); drive_cleanup becomes media_cleanup.
CREATE TABLE inbox_seen_new (
  store     TEXT    NOT NULL,
  media_id  TEXT    NOT NULL,
  draft_id  TEXT    NOT NULL,
  at        INTEGER NOT NULL,
  PRIMARY KEY (store, media_id)
);
INSERT INTO inbox_seen_new (store, media_id, draft_id, at) SELECT 'drive', drive_id, draft_id, at FROM inbox_seen;
DROP TABLE inbox_seen;
ALTER TABLE inbox_seen_new RENAME TO inbox_seen;

CREATE TABLE media_cleanup (
  store     TEXT    NOT NULL,
  media_id  TEXT    NOT NULL,
  item_key  TEXT    NOT NULL,
  moved_at  INTEGER,
  refused   TEXT,
  PRIMARY KEY (store, media_id)
);
INSERT INTO media_cleanup (store, media_id, item_key, moved_at, refused)
  SELECT 'drive', drive_id, item_key, moved_at, refused FROM drive_cleanup;
DROP TABLE drive_cleanup;
CREATE INDEX media_cleanup_item ON media_cleanup (item_key);

-- the cleanup's cached _posted folder goes (the store resolves paths itself); the app's upload folder keeps its id
DELETE FROM settings WHERE key = 'posted_folder';
UPDATE settings SET key = 'drive_upload_folder:Bongsu app uploads' WHERE key = 'app_upload_folder';
UPDATE settings SET key = 'inbox_folder:drive' WHERE key = 'inbox_folder';
