// Approvals: what the owner approved, in the exact form approved. Only an approved item is published, and only while
// every fingerprint still matches (texts by sha256, media by store, id and checksum). Stored in the approvals table;
// made by a passkey approval in the app, never with an API key.
import type { MediaRef } from "../media/store";

export type { MediaRef };

export interface Approval {
  line: number;
  key: string;
  /** The account (its id) the approval was given for; null on one older than migration 0010 whose item was gone by
   *  then (never valid: approve again). */
  account: string | null;
  /** Unix seconds, or null when the approval was revoked. A Shorts comment's is 0: it has no time of its own, it goes
   *  out once the video is public. */
  dueAt: number | null;
  captionSha256: string;
  commentSha256: string | null;
  /** The second comment's sha256 (D1 approvals only, migration 0011); null/absent = no second comment. */
  comment2Sha256?: string | null;
  altSha256: string | null;
  media: MediaRef[];
  approvedAt: string;
  /** The channel it was given through ("owner@app", "owner@cli"). */
  approvedBy: string;
  /** The person who approved (approvals.user_id); null on an approval that recorded none. */
  approvedByUser?: string | null;
  /** sha256 of the approved texts (a YouTube video's title, tags, translations) in canonical JSON; null/absent = none. */
  textsSha256?: string | null;
}

/** sha256 hex of a text, as approval fingerprints use (UTF-8, exactly as stored). */
export async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** JSON with keys sorted at every level and no whitespace, so the same texts always hash the same. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    // undefined values drop out, as JSON.stringify drops them, so texts hash the same after a round trip through the column.
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/** The fingerprint a YouTube approval keeps in texts_sha: the texts and the role each media file plays (`video:<id>`,
 *  `subtitle:<lang>:<id>`, `thumbnail:<id>`). Roles come from file names, which the media key (id and checksum) doesn't
 *  cover, so renaming es.srt to fr.srt must change this. null when there are neither (an Instagram item). */
export async function youtubeSha(texts: object | null, roles: string[] | null): Promise<string | null> {
  if (texts === null && roles === null) return null;
  return sha256Hex(canonicalJson({ texts, roles: roles ? [...roles].sort() : null }));
}
