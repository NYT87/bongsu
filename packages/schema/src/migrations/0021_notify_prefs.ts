// Per-person notification settings (Phase 13 part 2): one row per workspace, person and notification group, only where
// the person's choice differs from their role's default (core/notify-prefs.ts), so a role change moves everyone who
// never touched a setting and a missing row always means "the default".
//
// It also drops `push_subs.workspace_id`: a push now goes to the members of the note's workspace by their settings
// (core/push.ts), so a subscription is one device of one person, whatever workspace they subscribed in. Existing
// subscriptions are kept and from now on get every workspace their person is a member of.
import type { Step } from "../migrate";

const dropPushWorkspace = "ALTER TABLE push_subs DROP COLUMN workspace_id;";
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
  {
    sql: { sqlite: dropPushWorkspace, postgres: dropPushWorkspace },
    apply: (t) => {
      delete t.push_subs.columns.workspace_id;
    },
  },
];
