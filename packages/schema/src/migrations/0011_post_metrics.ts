// The metrics series: one post_metrics row per sample of a published post's lifetime counts (Instagram media, a Trial
// Reel's copy, a YouTube upload); daily values are differences between samples, computed on read. post_results keeps
// what only it can say (the 24 h notification went out; the account's median at that time), so its six count columns
// go: each earlier result is copied into the series first, as that post's first sample (taken when it was fetched).
// SQLite rebuilds the table (create, copy, drop, rename); Postgres drops the columns.
import type { Step } from "../migrate";

const COUNTS = ["views", "reach", "likes", "comments", "saves", "shares"];

// every earlier 24 h result was an Instagram post's (a Trial Reel's copy was never stored there)
const carry = `INSERT INTO post_metrics (item_key, account, platform, media_id, taken_at, views, reach, likes, comments, saves, shares, workspace_id)
  SELECT item_key, account, 'instagram', media_id, fetched_at, views, reach, likes, comments, saves, shares, workspace_id FROM post_results;`;

const sqlite = [
  carry,
  `CREATE TABLE post_results_new (
  item_key TEXT PRIMARY KEY,
  account TEXT NOT NULL,
  media_id TEXT NOT NULL,
  median_views REAL,
  fetched_at INTEGER NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT 'default'
);`,
  `INSERT INTO post_results_new (item_key, account, media_id, median_views, fetched_at, workspace_id)
  SELECT item_key, account, media_id, median_views, fetched_at, workspace_id FROM post_results;`,
  "DROP TABLE post_results;",
  "ALTER TABLE post_results_new RENAME TO post_results;",
].join("\n");

const postgres = `${carry}\nALTER TABLE post_results ${COUNTS.map((c) => `DROP COLUMN ${c}`).join(", ")};`;

export const steps: Step[] = [
  {
    createTable: "post_metrics",
    table: {
      description:
        "The metrics series: one row per sample of a published post's lifetime counts (NULL when the platform gives none).",
      columns: {
        id: { type: "serial", primaryKey: true },
        item_key: {
          type: "text",
          notNull: true,
          description: "The plan key; 'trial:<key>' for a Trial Reel copy, 'video:<id>' for a YouTube upload",
        },
        account: { type: "text", notNull: true },
        platform: { type: "text", notNull: true },
        media_id: { type: "text", notNull: true },
        taken_at: { type: "timestamp", notNull: true },
        views: { type: "int" },
        reach: { type: "int" },
        likes: { type: "int" },
        comments: { type: "int" },
        saves: { type: "int" },
        shares: { type: "int" },
        workspace_id: { type: "text", notNull: true, default: "default" },
      },
      indexes: [
        { name: "post_metrics_item", columns: ["item_key", "taken_at"] },
        { name: "post_metrics_ws", columns: ["workspace_id", "taken_at"] },
      ],
    },
  },
  {
    sql: { sqlite, postgres },
    apply: (t) => {
      for (const c of COUNTS) delete t.post_results.columns[c];
      t.post_results.description =
        "The 24 hours result of each published post: the marker that its notification went out, and the account's median views at that time.";
    },
  },
];
