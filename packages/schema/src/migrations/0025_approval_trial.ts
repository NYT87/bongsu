// Whether the approval covered a Trial Reel copy: turning the switch on afterwards must not add a post nobody approved.
import type { Step } from "../migrate";

export const steps: Step[] = [
  {
    addColumn: {
      table: "approvals",
      name: "trial",
      column: {
        type: "bool",
        description: "1: a trial copy was approved with the Reel; 0: it wasn't; NULL: approved before this was kept",
      },
    },
  },
];
