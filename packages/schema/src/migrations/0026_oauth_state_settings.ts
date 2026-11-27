// What a connect flow saves with its grant, as typed when it started: Connect Google Drive's root folder (the folder
// the workspaces' folders live in), resolved with the new grant when Google sends the browser back. NULL: nothing.
import type { Step } from "../migrate";

export const steps: Step[] = [
  {
    addColumn: {
      table: "oauth_states",
      name: "flow_settings",
      column: { type: "text", description: "JSON the flow saves with its grant (Drive: the root folder as typed)" },
    },
  },
];
