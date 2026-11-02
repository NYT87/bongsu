// An approval is bound to the account it was given for: an item removed and planned again for another account with
// the same key, texts and media must not go out there on the old approval. Existing approvals take their item's
// account; one whose item is no longer planned stays without and is refused (approve again). Shorts comments
// (item_key 'comment:<video id>') are approved the same way, with their channel as the account.
import type { Step } from "../migrate";

const backfill =
  "UPDATE approvals SET account = (SELECT p.account FROM plan_items p WHERE p.item_key = approvals.item_key);";

export const steps: Step[] = [
  {
    addColumn: {
      table: "approvals",
      name: "account",
      column: {
        type: "text",
        description:
          "The account (its id) the approval is for; a Shorts comment's channel. NULL only on one older than this column whose item was gone: never valid.",
      },
    },
  },
  { sql: { sqlite: backfill, postgres: backfill } },
];
