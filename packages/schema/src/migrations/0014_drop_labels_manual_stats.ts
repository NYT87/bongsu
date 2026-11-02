// The old stats tables nothing reads or writes: the series (post_metrics, account_metrics) took their place, and
// uploads go through ingest_metrics. An instance that imported data from an earlier deployment loses what they held
// (export it first).
import type { Step } from "../migrate";

const drop = "DROP TABLE IF EXISTS labels;\nDROP TABLE IF EXISTS manual_stats;";

export const steps: Step[] = [
  {
    sql: { sqlite: drop, postgres: drop },
    apply: (t) => {
      delete t.labels;
      delete t.manual_stats;
    },
  },
];
