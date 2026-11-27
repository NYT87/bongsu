// Whether a person gets the alert emails (a connection or a media store that broke): their own switch, in the
// dashboard, for every workspace and the instance alike. On by default; the push and the dashboard notice go out anyway.
import type { Step } from "../migrate";

export const steps: Step[] = [
  {
    addColumn: {
      table: "users",
      name: "alert_mail",
      column: { type: "bool", notNull: true, default: 1, description: "gets the alert emails (0: turned them off)" },
    },
  },
];
