-- Times are stored in UTC (unix seconds); time zones only apply at the edges, when a person or an agent gives or reads a
-- time. The workspace's zone is the default for input and display; each user may pick their own (users.timezone).
--
-- plan_items.date/time (wall time in the workspace's zone) become due_at, approvals.due becomes due_at, and posted.date
-- goes: the day something went out comes from published_at. Existing rows are converted as if their zone were UTC, the
-- default of every workspace so far (0002). Data entered in another zone is shifted by its offset right after this
-- migration, once (docs/PLAN.md, Phase 11, for an instance adopting older data).

ALTER TABLE users ADD COLUMN timezone TEXT; -- IANA name; NULL = the workspace's

-- plan_items: NULL due_at = not scheduled. The default times (Reels 18:00, posts 19:00) are resolved when the item is
-- scheduled, so due_at is always the real instant.
ALTER TABLE plan_items ADD COLUMN due_at INTEGER;
UPDATE plan_items SET due_at = unixepoch(date || ' ' || COALESCE(time, CASE kind WHEN 'reel' THEN '18:00' ELSE '19:00' END))
  WHERE date IS NOT NULL;
DROP INDEX plan_items_account_date;
DROP INDEX plan_items_workspace;
ALTER TABLE plan_items DROP COLUMN date;
ALTER TABLE plan_items DROP COLUMN time;
CREATE INDEX plan_items_account_due ON plan_items (account, due_at);
CREATE INDEX plan_items_workspace_due ON plan_items (workspace_id, due_at);

-- approvals: the instant that was approved.
ALTER TABLE approvals ADD COLUMN due_at INTEGER;
UPDATE approvals SET due_at = unixepoch(substr(due, 1, 16)) WHERE due IS NOT NULL AND due != '';
ALTER TABLE approvals DROP COLUMN due;

-- posted: published_at is always set (when it went live; for a hand-recorded post without a time, the time it was
-- recorded or planned).
UPDATE posted SET published_at = COALESCE(published_at, unixepoch(date || ' 12:00'), at) WHERE published_at IS NULL;
DROP INDEX posted_account_date;
ALTER TABLE posted DROP COLUMN date;
CREATE INDEX posted_account_published ON posted (account, published_at);
