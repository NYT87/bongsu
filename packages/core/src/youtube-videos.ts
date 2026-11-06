// A YouTube video Bongsu uploaded belongs to its plan item (D6): stats, the calendar, the video page and the sampler
// count it once, under the item, not again as a video uploaded elsewhere.
import type { Db } from "./db";

/** Where a job keeps its video: `media_id` once published, else the id of its upload step (in flight, or kept for a
 *  revision after a refusal or failure). Parsed here, not in SQL, to stay portable. */
function videoIdOf(mediaId: string | null, payload: string): string | null {
  if (mediaId) return mediaId;
  try {
    const id = (JSON.parse(payload) as { step?: { data?: { videoId?: unknown } } }).step?.data?.videoId;
    return typeof id === "string" && id ? id : null;
  } catch {
    return null;
  }
}

function accountOf(payload: string): string | null {
  try {
    const u = (JSON.parse(payload) as { username?: unknown }).username;
    return typeof u === "string" ? u : null;
  } catch {
    return null;
  }
}

/** Video id → item key, for the video jobs of the workspace on those channel accounts. (A job's `account` is its
 *  connection; the channel account is `payload.username`.) */
export async function bongsuVideos(db: Db, accountIds: string[], workspaceId: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!accountIds.length) return out;
  const rows = await db
    .prepare("SELECT item_key, media_id, payload FROM jobs WHERE kind = 'video' AND workspace_id = ?1 ORDER BY id")
    .bind(workspaceId)
    .all<{ item_key: string; media_id: string | null; payload: string }>();
  for (const r of rows.results) {
    const id = videoIdOf(r.media_id, r.payload);
    const account = accountOf(r.payload);
    if (id && account !== null && accountIds.includes(account)) out.set(id, r.item_key);
  }
  return out;
}
