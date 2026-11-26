// Counting and cutting text by what a reader sees as one character (an emoji, a family emoji, a flag), not by UTF-16
// units: networks like Bluesky limit posts that way.
const segmenter = new Intl.Segmenter();

export const graphemeCount = (s: string): number => [...segmenter.segment(s)].length;

/** The first `max` graphemes of the text (never cutting one in two). */
export function cutGraphemes(s: string, max: number): string {
  let out = "";
  let n = 0;
  for (const { segment } of segmenter.segment(s)) {
    if (++n > max) break;
    out += segment;
  }
  return out;
}
