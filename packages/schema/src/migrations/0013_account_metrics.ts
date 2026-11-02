// The account series: one row per daily sample of an account's follower (subscriber) count, so the channel page can
// chart followers over time; daily values are differences on read, as with post_metrics. The nightly snapshots
// backfill it once (the sampler does, from the app: the snapshot JSON isn't portable SQL).
import type { Step } from "../migrate";

export const steps: Step[] = [
  {
    createTable: "account_metrics",
    table: {
      description: "The account series: one row per sample of an account's follower count (NULL when hidden).",
      columns: {
        id: { type: "serial", primaryKey: true },
        account: { type: "text", notNull: true, description: "accounts.id" },
        platform: { type: "text", notNull: true },
        taken_at: { type: "timestamp", notNull: true },
        followers: { type: "int", description: "followers (Instagram) or subscribers (YouTube, rounded by YouTube)" },
        workspace_id: { type: "text", notNull: true, default: "default" },
      },
      indexes: [
        { name: "account_metrics_account", columns: ["account", "taken_at"] },
        { name: "account_metrics_ws", columns: ["workspace_id", "taken_at"] },
      ],
    },
  },
];
