// The neutral migrations, in order. The first is the baseline (the schema SQLite's hand-written migrations 0001…0009
// built); each later one is a list of neutral steps (../migrate.ts), generated into migrations/sqlite/ and
// migrations/postgres/ by `pnpm --filter @bongsu/schema generate`. Add one per schema change; never edit a released one.
import type { Migration } from "../migrate";
import { baseline } from "./0009_baseline";
import { steps as approvalAccount } from "./0010_approval_account";
import { steps as postMetrics } from "./0011_post_metrics";
import { steps as postMetricsFollowers } from "./0012_post_metrics_followers";
import { steps as accountMetrics } from "./0013_account_metrics";
import { steps as dropOldStats } from "./0014_drop_labels_manual_stats";
import { steps as dropReports } from "./0015_drop_reports";
import { steps as workspaceNotify } from "./0016_workspace_notify";
import { steps as mediaStore } from "./0017_media_store";
import { steps as people } from "./0018_people";
import { steps as oauthStateWorkspace } from "./0019_oauth_state_workspace";
import { steps as oauthStateBrowser } from "./0020_oauth_state_browser";
import { steps as notifyPrefs } from "./0021_notify_prefs";

export const MIGRATIONS: Migration[] = [
  {
    name: "0009_baseline",
    baseline,
    // the rows SQLite's 0002_accounts inserts: the default workspace and its first user
    seed: [
      "INSERT INTO workspaces (id, name, created_at) VALUES ('default', 'Default', 0);",
      "INSERT INTO workspace_settings (workspace_id, timezone, digest_hour, locale, updated_at) VALUES ('default', 'UTC', 8, 'en', 0);",
      "INSERT INTO users (id, email, name, created_at) VALUES ('owner', NULL, 'Owner', 0);",
      "INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES ('default', 'owner', 'owner', 0);",
    ],
  },
  { name: "0010_approval_account", steps: approvalAccount },
  { name: "0011_post_metrics", steps: postMetrics },
  { name: "0012_post_metrics_followers", steps: postMetricsFollowers },
  { name: "0013_account_metrics", steps: accountMetrics },
  { name: "0014_drop_labels_manual_stats", steps: dropOldStats },
  { name: "0015_drop_reports", steps: dropReports },
  { name: "0016_workspace_notify", steps: workspaceNotify },
  { name: "0017_media_store", steps: mediaStore },
  { name: "0018_people", steps: people },
  { name: "0019_oauth_state_workspace", steps: oauthStateWorkspace },
  { name: "0020_oauth_state_browser", steps: oauthStateBrowser },
  { name: "0021_notify_prefs", steps: notifyPrefs },
];
