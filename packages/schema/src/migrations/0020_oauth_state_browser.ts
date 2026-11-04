// The browser a connect flow was started in: the start sets a random cookie in it and keeps its sha256 here; the
// callback only finishes the flow in that browser, so a provider link sent to someone else can't connect their account
// into the sender's workspace. NULL: a flow started before this migration, which the callback refuses.
import type { Step } from "../migrate";

export const steps: Step[] = [
  {
    addColumn: {
      table: "oauth_states",
      name: "browser_hash",
      column: { type: "text", description: "sha256 of the cookie set in the browser that started the flow" },
    },
  },
];
