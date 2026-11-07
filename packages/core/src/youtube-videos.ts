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
 *  connection, as `discover` writes it: the connection's external ref, else its id; the channel account is
 *  `payload.username`.) Only the channels' connections' jobs are read: this runs on every calendar, stats and video
 *  request and in the sampler, and the workspace's Reels (also `kind = 'video'`) would grow it without bound. */
export async function bongsuVideos(db: Db, accountIds: string[], workspaceId: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!accountIds.length) return out;
  const ids = accountIds.map((_, i) => `?${i + 2}`).join(", ");
  const rows = await db
    .prepare(
      `SELECT item_key, media_id, payload FROM jobs WHERE kind = 'video' AND workspace_id = ?1
       AND account IN (SELECT COALESCE(c.external_ref, c.id) FROM accounts a JOIN connections c ON c.id = a.connection_id
         WHERE a.id IN (${ids}))
       ORDER BY id`,
    )
    .bind(workspaceId, ...accountIds)
    .all<{ item_key: string; media_id: string | null; payload: string }>();
  for (const r of rows.results) {
    const id = videoIdOf(r.media_id, r.payload);
    const account = accountOf(r.payload);
    if (id && account !== null && accountIds.includes(account)) out.set(id, r.item_key);
  }
  return out;
}
