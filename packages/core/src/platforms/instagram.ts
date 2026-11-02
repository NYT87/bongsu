// Instagram: Reels (video), photos, carousels and Stories, with first and second comments, alt texts, a location,
// a cover frame and Trial Reels. Reached through instagram-graph or instagram-composio (providers/).
import { IG_RULES, lintCaption } from "../formats/caption-lint";
import type { Platform } from "./types";

export const instagram: Platform = {
  id: "instagram",
  name: "Instagram",
  formats: ["video", "image", "carousel", "story"],
  labels: {
    video: { name: "Reel", plural: "Reels" },
    image: { name: "Photo", plural: "Photos" },
    carousel: { name: "Carousel", plural: "Carousels" },
    story: { name: "Story", plural: "Stories" },
    post: { name: "Post", plural: "Posts" },
  },
  accountNoun: "account",
  limits: { mediaMax: 10, videoSecondsMax: 15 * 60, captionMax: 2200, hashtagsMax: 5, altMax: 100 },
  features: {
    firstComment: true,
    secondComment: true,
    altText: true,
    location: true,
    coverFrame: true,
    trial: true,
    comments: true,
    insights: true,
    commentOnExisting: false,
  },
  options: [
    {
      key: "location",
      type: "string",
      label: "Location (a Facebook place id)",
      pattern: /^\d{1,30}$/,
      formats: ["video", "image", "carousel"],
    },
    {
      key: "coverMs",
      type: "integer",
      label: "Cover frame (ms into the video)",
      min: 0,
      max: 15 * 60 * 1000,
      formats: ["video"],
    },
    { key: "trial", type: "boolean", label: "Trial Reel (non-followers first)", formats: ["video"] },
  ],
  lint: lintCaption,
  lintDefaults: IG_RULES,
};
