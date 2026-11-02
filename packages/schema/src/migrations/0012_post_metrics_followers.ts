// The followers a post or video brought, as two more lifetime counts on the series: Instagram's `follows` and
// `profile_visits` media insights, YouTube's subscribers gained since publishing (Analytics API) in `follows`.
// NULL where the platform or the media type gives none, and on every sample taken before this migration.
import type { Step } from "../migrate";

export const steps: Step[] = [
  {
    addColumn: {
      table: "post_metrics",
      name: "follows",
      column: {
        type: "int",
        description: "accounts that followed or subscribed because of this post, lifetime (NULL: not reported)",
      },
    },
  },
  {
    addColumn: {
      table: "post_metrics",
      name: "profile_visits",
      column: { type: "int", description: "profile visits from this post, lifetime (Instagram; NULL: not reported)" },
    },
  },
];
