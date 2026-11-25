// Bluesky: text and image posts (up to four images with alt text), with the first and second comment as replies.
// The 300 limit counts graphemes, and an image is a blob of at most about 1 MB, so Bongsu refuses a bigger one at
// approval instead of resizing it (docs/superpowers/specs/2026-11-25-bluesky-design.md).
import { graphemeCount } from "../providers/bluesky-richtext";
import { NO_FEATURES, NO_LINT, type Platform } from "./types";

const POST_MAX = 300;
const post = { name: "Post", plural: "Posts" };

export const bluesky: Platform = {
  id: "bluesky",
  name: "Bluesky",
  formats: ["text", "image"],
  labels: { post, text: post, image: post },
  accountNoun: "account",
  limits: { mediaMax: 4, videoSecondsMax: 0, captionMax: POST_MAX, altMax: 2000, imageBytesMax: 1_000_000 },
  features: { ...NO_FEATURES, firstComment: true, secondComment: true, altText: true },
  options: [],
  lint: (caption) => {
    const n = graphemeCount(caption);
    return [{ check: "LENGTH", status: n > POST_MAX ? "FAIL" : "PASS", detail: `${n}/${POST_MAX}` }];
  },
  lintDefaults: NO_LINT,
};
