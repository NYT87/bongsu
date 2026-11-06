// A YouTube video's texts (title, languages, tags, translations) as one JSON column on the item and on the draft, and
// the fingerprint of the approved ones on the approval.
import type { Step } from "../migrate";

const texts = "a YouTube video's title, languages, tags and translations (JSON); NULL: none";

export const steps: Step[] = [
  { addColumn: { table: "plan_items", name: "texts", column: { type: "json", description: texts } } },
  { addColumn: { table: "drafts", name: "texts", column: { type: "json", description: texts } } },
  {
    addColumn: {
      table: "approvals",
      name: "texts_sha",
      column: { type: "text", description: "sha256 of the approved texts in canonical JSON; NULL: none" },
    },
  },
];
