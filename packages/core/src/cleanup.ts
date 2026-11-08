// Media cleanup, in the inbox's cron run: a day after an item is posted its media moves from <folder>/<project>/... to
// <folder>/_posted/ (the folder of the item's workspace) in the store it's in. Move only: nothing is trashed or deleted here; the owner empties _posted/ by
// hand. Some stores give a moved file a new id (S3), which is fine: nothing reads an id after this. If a store refuses
// a move, that's recorded once, notified, never retried.
import { BudgetSpent, canAfford, type StepDeps } from "./budget";
import { contentPaths, getItem, latestApprovals } from "./data";
import type { Env } from "./env";
import { mediaPath } from "./media/folders";
import { type MediaStores, mediaStores } from "./media/index";
import type { MediaStore } from "./media/store";
import { MediaRefused } from "./media/store";
import { notifier } from "./notify";
import { cleanupRefused } from "./texts/notifications";
import { workspaceSettings } from "./workspaces";

export const MOVE_AFTER_S = 86400;
/** Moves per run (each file costs a few subrequests; the free plan allows 50 per invocation). */
const FILES_PER_RUN = 8;
/** The most calls one move makes (Drive): the file's stat, then the move's read of it, its look up of _posted/ (a
 *  Drive path is never served whole from the folder cache) and the change of parent, and a token when none is
 *  cached. */
export const CLEANUP_UNIT_CALLS = 5;
/** What finding (or making) a store's _posted/ costs the first move to it in a run: the look up of _posted/ (two
 *  levels), and when it's missing the workspace folder's and the folder's creation. */
export const CLEANUP_TARGET_CALLS = 4;

export async function cleanMedia(env: Env, deps: StepDeps): Promise<{ moved: number; refused: string[] }> {
  const nowS = Math.floor(deps.now.getTime() / 1000);
  /** The stores and folder of each workspace, read once per run. */
  const scopes = new Map<string, { stores: MediaStores; folder: string }>();
  const scopeOf = async (ws: string) => {
    let s = scopes.get(ws);
    if (!s) {
      s = {
        stores: await mediaStores(env, deps.fetch, ws),
        folder: (await workspaceSettings(env.DB, ws)).mediaFolder,
      };
      scopes.set(ws, s);
    }
    return s;
  };
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
    try {
      await moveAll(due.results);
    } catch (e) {
      // the run's calls ran out (past what the checks foresaw): the refusals so far are still told below
      if (!(e instanceof BudgetSpent)) throw e;
    }
  }

  const note = notifier(env, deps.fetch, nowS);
  for (const [ws, refused] of refusedIn) await note.send(cleanupRefused(refused), ws);
  return out;

  async function moveAll(items: { item_key: string; workspace_id: string }[]) {
    /** _posted/ of each workspace's folder in each store, created once per run. */
    const targets = new Map<string, string>();
    const approvals = await latestApprovals(
      env.DB,
      items.map((r) => r.item_key),
    );
    const mark = (store: string, id: string, item: string, movedAt: number | null, refused: string | null) =>
      env.DB.prepare(
        "INSERT INTO media_cleanup (store, media_id, item_key, moved_at, refused) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT DO NOTHING",
      )
        .bind(store, id, item, movedAt, refused)
        .run();
    for (const { item_key, workspace_id } of items) {
      // out of calls for this run: the items after it are still due next run
      if (!canAfford(deps, CLEANUP_UNIT_CALLS + CLEANUP_TARGET_CALLS)) break;
      const { stores, folder } = await scopeOf(workspace_id);
      const posted = mediaPath(folder, "_posted");
      // the approved files, in their store (an item's files are all in one: a draft's or an upload's)
      const refs = approvals.get(item_key)?.media ?? [];
      let store: MediaStore | null = null;
      let ids: string[] = [];
      if (refs.length) {
        store = stores.for(refs[0]);
        const kind = refs[0].store;
        ids = store ? refs.filter((m) => m.store === kind).map((m) => m.id) : [];
      } else {
        // no approval: the item's media path, in the default store
        store = stores.default;
        const i = await getItem(env.DB, item_key, workspace_id);
        const paths = i ? contentPaths(i, folder) : null;
        const node = store && paths?.single && paths.media ? await store.resolve(paths.media) : null;
        ids = node ? [node.id] : [];
      }
      if (!store || !ids.length) {
        // nothing in a store for it: mark it handled
        await mark(store?.id ?? "none", `none:${item_key}`, item_key, null, "not in a media store");
        continue;
      }
      if (item_key.startsWith("post:")) {
        // a post moves as its folder (posts/<post>/), names and all
        const parent = (await store.stat(ids[0]))?.parent;
        if (parent) ids = [parent];
      }
      // an item's files move in the same run (a handled item isn't picked again): it starts only when all of them
      // fit, the first move to this store's _posted/ finding it too
      const tkey = `${store.id}/${posted}`;
      const cost = ids.length * CLEANUP_UNIT_CALLS + (targets.has(tkey) ? 0 : CLEANUP_TARGET_CALLS);
      if (budget < ids.length || !canAfford(deps, cost)) break;
      budget -= ids.length;
      for (const id of ids) {
        const e = await store.stat(id);
        let moved: number | null = null,
          refused: string | null = null;
        if (!e) refused = "gone from the media store";
        else {
          let target = targets.get(tkey);
          if (!target) {
            target = await store.ensureFolder(posted);
            targets.set(tkey, target);
          }
          if (e.parent === target) moved = nowS;
          else
            try {
              await store.move(id, posted);
              moved = nowS;
              out.moved++;
            } catch (err) {
              if (!(err instanceof MediaRefused)) throw err;
              refused = err.message;
              out.refused.push(`${item_key}: ${refused}`);
              refusedIn.set(workspace_id, [...(refusedIn.get(workspace_id) ?? []), `${item_key}: ${refused}`]);
            }
        }
        await mark(store.id, id, item_key, moved, refused);
      }
    }
  }
}
