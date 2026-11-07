-- Generated from packages/schema (pnpm --filter @bongsu/schema generate): don't edit by hand.

ALTER TABLE plan_items ADD COLUMN texts TEXT;
ALTER TABLE drafts ADD COLUMN texts TEXT;
ALTER TABLE approvals ADD COLUMN texts_sha TEXT;
