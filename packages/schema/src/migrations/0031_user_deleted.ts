// A deleted account (#143) stays as a tombstone: the row keeps its id, so the audit log, approvals and drafts that name
// it still resolve ("deleted user"), with its email, name and settings cleared.
import type { Step } from "../migrate";

export const steps: Step[] = [
  {
    addColumn: {
      table: "users",
      name: "deleted_at",
      column: { type: "timestamp", description: "when the person deleted their account; their personal data is gone" },
    },
  },
];
