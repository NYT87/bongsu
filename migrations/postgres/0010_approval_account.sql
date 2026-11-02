-- Generated from packages/schema (pnpm --filter @bongsu/schema generate): don't edit by hand.

ALTER TABLE "approvals" ADD COLUMN "account" TEXT;
UPDATE approvals SET account = (SELECT p.account FROM plan_items p WHERE p.item_key = approvals.item_key);
