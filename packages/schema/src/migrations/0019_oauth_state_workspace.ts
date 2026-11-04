// The workspace a connect flow was started from: the callback saves the connection there (not in the user's first
// workspace), for flows started in the dashboard and in the app alike. NULL for the media store's Drive flow, which
// is the instance's.
import type { Step } from "../migrate";

export const steps: Step[] = [
  {
    addColumn: {
      table: "oauth_states",
      name: "workspace_id",
      column: { type: "text", description: "the workspace the flow connects into; NULL: the instance's (Drive)" },
    },
  },
];
