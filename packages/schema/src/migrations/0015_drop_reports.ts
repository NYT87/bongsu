// The performance reviews, Markdown imported from an earlier collector: nothing writes them and, with the app's review
// pages gone, nothing reads them. An instance that imported them loses what they held (export it first).
import type { Step } from "../migrate";

const drop = "DROP TABLE IF EXISTS reports;";

export const steps: Step[] = [
  {
    sql: { sqlite: drop, postgres: drop },
    apply: (t) => {
      delete t.reports;
    },
  },
];
