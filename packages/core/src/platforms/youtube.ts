// YouTube: for now Bongsu only comments on videos published elsewhere (the Shorts comments, as each channel); uploads
// come later through the same provider interface (docs/PLAN.md, Phase 14).
import { NO_FEATURES, NO_LINT, type Platform } from "./types";

export const youtube: Platform = {
  id: "youtube",
  name: "YouTube",
  formats: [],
  labels: { video: { name: "Video", plural: "Videos" }, post: { name: "Video", plural: "Videos" } },
  accountNoun: "channel",
  limits: { mediaMax: 1, videoSecondsMax: 60 * 60 * 12, captionMax: 5000 },
  features: { ...NO_FEATURES, comments: true, commentOnExisting: true, firstComment: true },
  options: [],
  lint: () => [],
  lintDefaults: NO_LINT,
};
