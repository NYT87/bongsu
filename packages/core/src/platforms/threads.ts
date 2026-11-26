// Threads: text, image, video and carousel posts, with the first and second comment as replies to the post, alt texts
// on images, the post's replies read and answered, and its results. 500 characters, counted as readers see them (the
// write paths count graphemes too); an image over Threads' 8 MB is refused at approval.
import { graphemeCount } from "../formats/graphemes";
import { NO_FEATURES, NO_LINT, type Platform } from "./types";

const POST_MAX = 500;
const post = { name: "Post", plural: "Posts" };

export const threads: Platform = {
  id: "threads",
  name: "Threads",
  formats: ["text", "image", "video", "carousel"],
  labels: { post, text: post, image: post, video: post, carousel: { name: "Carousel", plural: "Carousels" } },
  accountNoun: "profile",
  limits: {
    mediaMax: 20,
    videoSecondsMax: 5 * 60,
    captionMax: POST_MAX,
    altMax: 1000,
    imageBytesMax: 8_000_000, // Threads says 8 MB; decimal, so never over it
  },
  features: {
    ...NO_FEATURES,
    firstComment: true,
    secondComment: true,
    altText: true,
    comments: true,
    insights: true,
  },
  options: [],
  lint: (caption) => {
    const n = graphemeCount(caption);
    return [{ check: "LENGTH", status: n > POST_MAX ? "FAIL" : "PASS", detail: `${n}/${POST_MAX}` }];
  },
  lintDefaults: NO_LINT,
};
