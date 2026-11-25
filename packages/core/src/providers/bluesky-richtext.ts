// Bluesky's rich text: a post is plain text plus facets, which point at byte ranges (UTF-8) of links and hashtags.
// Without facets a link is not clickable, so the provider sends them with every post and reply.

const graphemes = new Intl.Segmenter();

/** Bluesky's 300 limit counts what a reader sees as one character, not UTF-16 units. */
export const graphemeCount = (s: string): number => [...graphemes.segment(s)].length;

export type Facet = {
  index: { byteStart: number; byteEnd: number };
  features: (
    | { $type: "app.bsky.richtext.facet#link"; uri: string }
    | { $type: "app.bsky.richtext.facet#tag"; tag: string }
  )[];
};

const LINK = /https?:\/\/[^\s]+/gu;
const TAG = /(?<![\p{L}\p{N}_#])#([\p{L}\p{N}_]+)/gu;
const TRAILING = /[.,;:!?)]+$/;
const enc = new TextEncoder();

const bytes = (s: string) => enc.encode(s).length;

/** Links and hashtags of the text as facets, in text order, with UTF-8 byte offsets. */
export function facetsOf(text: string): Facet[] {
  const links: [number, number][] = [];
  const found: { at: number; facet: Facet }[] = [];
  const span = (at: number, len: number) => {
    const byteStart = bytes(text.slice(0, at));
    return { byteStart, byteEnd: byteStart + bytes(text.slice(at, at + len)) };
  };
  for (const m of text.matchAll(LINK)) {
    const uri = m[0].replace(TRAILING, "");
    const at = m.index ?? 0;
    links.push([at, at + uri.length]);
    found.push({
      at,
      facet: { index: span(at, uri.length), features: [{ $type: "app.bsky.richtext.facet#link", uri }] },
    });
  }
  const inLink = (at: number) => links.some(([from, to]) => at >= from && at < to);
  for (const m of text.matchAll(TAG)) {
    const at = m.index ?? 0;
    if (inLink(at)) continue;
    found.push({
      at,
      facet: { index: span(at, m[0].length), features: [{ $type: "app.bsky.richtext.facet#tag", tag: m[1] }] },
    });
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.facet);
}
