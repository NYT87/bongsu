// Per-person notification settings (Phase 13 part 2): one row per workspace, person and notification group, only where
// the person's choice differs from their role's default (core/notify-prefs.ts), so a role change moves everyone who
// never touched a setting and a missing row always means "the default".
import type { Step } from "../migrate";

const GROUPS = ["needs_you", "problems", "published", "inbox", "digest"];

export const steps: Step[] = [
  {
    createTable: "notify_prefs",
    table: {
      description:
        "A person's notification settings in a workspace: only the groups they changed from their role's default.",
      columns: {
        workspace_id: { type: "text", notNull: true },
        user_id: { type: "text", notNull: true },
        grp: { type: "text", notNull: true, values: GROUPS },
        enabled: { type: "int", notNull: true, description: "1 or 0" },
        updated_at: { type: "timestamp", notNull: true },
      },
      primaryKey: ["workspace_id", "user_id", "grp"],
    },
  },
];
