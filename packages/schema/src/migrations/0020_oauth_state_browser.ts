// The browser a connect flow was started in: the start sets a random cookie in it and keeps its sha256 here; the
// callback only finishes the flow in that browser, so a provider link sent to someone else can't connect their account
// into the sender's workspace. NULL: a flow started before this migration, which the callback refuses.
// Also corrects audit.actor's description, which still named the single owner: the baseline is released, so it stays
// as it was and this step changes only the description (a SQL comment, nothing in the database).
import type { Step } from "../migrate";

const ACTOR = "-- audit.actor is 'cron', 'user:<id>' or 'key:<id>' (a description only)";

export const steps: Step[] = [
  {
    addColumn: {
      table: "oauth_states",
      name: "browser_hash",
      column: { type: "text", description: "sha256 of the cookie set in the browser that started the flow" },
    },
  },
  {
    sql: { sqlite: ACTOR, postgres: ACTOR },
    apply: (t) => {
      t.audit.columns.actor.description = "'cron', 'user:<id>' (a person) or 'key:<id>' (an agent key)";
    },
  },
];
