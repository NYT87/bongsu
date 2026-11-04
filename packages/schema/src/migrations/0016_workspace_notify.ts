// Each workspace's ntfy topic, set in the dashboard: its notifications are also posted there. It replaces the
// instance-wide NOTIFY_URL, which got every workspace's. Encrypted (core/crypto.ts): knowing a topic's URL is enough to
// read it.
import type { Step } from "../migrate";

export const steps: Step[] = [
  {
    addColumn: {
      table: "workspace_settings",
      name: "notify_url",
      column: { type: "text", description: "the workspace's ntfy topic URL, encrypted; NULL: none" },
    },
  },
];
