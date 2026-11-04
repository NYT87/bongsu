// Media cleanup, in the inbox's cron run: a day after an item is posted its media moves from UPLOADS/<project>/... to
// UPLOADS/_posted/ in the media store. Move only: nothing is trashed or deleted here; the owner empties _posted/ by hand.
// The ids don't change, so approvals and links stay valid. If the store refuses a move, that's recorded once, notified,
// never retried.
import { contentPaths, getItem, latestApprovals } from "./data";
import type { Env } from "./env";
import { inStore, mediaStore } from "./media/index";
import { MediaRefused } from "./media/store";
import { notifier } from "./notify";
import { cleanupRefused } from "./texts/notifications";

export const MOVE_AFTER_S = 86400;
/** Moves per run (each file costs a few subrequests; the free plan allows 50 per invocation). */
const FILES_PER_RUN = 8;
const POSTED = "UPLOADS/_posted";

export async function cleanMedia(
  env: Env,
  deps: { fetch: typeof fetch; now: Date },
): Promise<{ moved: number; refused: string[] }> {
  const nowS = Math.floor(deps.now.getTime() / 1000);
  const store = mediaStore(env, deps.fetch);
  const out = { moved: 0, refused: [] as string[] };
  /** The refusals per workspace: each workspace's devices hear of their own. */
  const refusedIn = new Map<string, string[]>();
  let budget = FILES_PER_RUN;

  // Posted over a day ago and not handled yet: the files from its approval (or, without one, its media path).
  const due = await env.DB.prepare(
    `SELECT p.item_key, p.workspace_id FROM posted p WHERE COALESCE(p.published_at, p.at) <= ?1
       AND NOT EXISTS (SELECT 1 FROM media_cleanup d WHERE d.item_key = p.item_key) ORDER BY COALESCE(p.published_at, p.at) LIMIT 4`,
  )
    .bind(nowS - MOVE_AFTER_S)
    .all<{ item_key: string; workspace_id: string }>();
  if (due.results.length) {
    const approvals = await latestApprovals(
      env.DB,
      due.results.map((r) => r.item_key),
    );
    let target: string | null = null;
    const mark = (id: string, item: string, movedAt: number | null, refused: string | null) =>
      env.DB.prepare(
        "INSERT INTO media_cleanup (store, media_id, item_key, moved_at, refused) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT DO NOTHING",
      )
        .bind(store.id, id, item, movedAt, refused)
        .run();
    for (const { item_key, workspace_id } of due.results) {
      let ids = (approvals.get(item_key)?.media ?? []).filter((m) => inStore(store, m)).map((m) => m.id);
      if (!ids.length) {
        const i = await getItem(env.DB, item_key);
        const node = i && contentPaths(i).single ? await store.resolve(contentPaths(i).media) : null;
        ids = node ? [node.id] : [];
      }
      if (item_key.startsWith("post:") && ids.length) {
        // a post moves as its folder (posts/<post>/), names and all
        const parent = (await store.stat(ids[0]))?.parent;
        if (parent) ids = [parent];
      }
      if (!ids.length) {
        // nothing in the store for it: mark it handled
        await mark(`none:${item_key}`, item_key, null, "not in the media store");
        continue;
      }
      if (budget < ids.length) break; // an item's files move in the same run (a handled item isn't picked again)
      budget -= ids.length;
      for (const id of ids) {
        const e = await store.stat(id);
        let moved: number | null = null,
          refused: string | null = null;
        if (!e) refused = "gone from the media store";
        else {
          target ??= await store.ensureFolder(POSTED);
          if (e.parent === target) moved = nowS;
          else
            try {
              await store.move(id, POSTED);
              moved = nowS;
              out.moved++;
            } catch (err) {
              if (!(err instanceof MediaRefused)) throw err;
              refused = err.message;
              out.refused.push(`${item_key}: ${refused}`);
              refusedIn.set(workspace_id, [...(refusedIn.get(workspace_id) ?? []), `${item_key}: ${refused}`]);
            }
        }
        await mark(id, item_key, moved, refused);
      }
    }
  }

  const note = notifier(env, deps.fetch, nowS);
  for (const [ws, refused] of refusedIn) await note.send(cleanupRefused(refused), ws);
  return out;
}
