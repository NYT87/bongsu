// The texts as published, built the way ig.py builds them (read_caption, self_comment_text, question_of); approval
// fingerprints hash exactly these. Python twin: server/tools/formats.py (golden-tested).

export const captionText = (raw: string): string => raw.trim();

/** The caption's question line (house style: one question to the viewer), or null. */
export function questionOf(caption: string): string | null {
  for (const l of caption.split(/\r\n|\n|\r/)) if (l.trim().endsWith("?")) return l.trim();
  return null;
}

/** Our first comment: the comment file (trimmed), else the caption's question line, else none. */
export function commentText(caption: string, commentRaw: string | null): string | null {
  return (commentRaw ?? "").trim() || questionOf(caption);
}

/** The second comment: its file or field, trimmed; no fallback, so empty means none. */
export const comment2Text = (raw: string | null): string | null => (raw ?? "").trim() || null;

/** Alt texts as published, one per image slide, from a post's alt.txt: blank lines dropped, and a leading slide
 *  number ("01<TAB>text", the house format) removed. */
export function altLines(raw: string): string[] {
  return raw
    .split(/\r\n|\n|\r/)
    .map((l) => l.replace(/^\s*\d{1,2}\t/, "").trim())
    .filter(Boolean);
}
