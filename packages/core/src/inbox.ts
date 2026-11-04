// The inbox, its own cron run: whatever is dropped in UPLOADS/inbox/<project>/ in any of the media stores becomes a
// draft (+ a notification), for the workspace to review; the draft records the store its files are in. Nothing here
// publishes or approves. A project goes to the workspace whose plan has it; a project no plan has yet to the workspace
// the store's inbox feeds (media_store.inbox_workspace, the dashboard's Media page); without one it waits.
//
//   inbox/<project>/<name>.mp4              a Reel draft    (+ <name>.txt caption, <name>.comment.txt, <name>.comment2.txt)
//   inbox/<project>/<name>.jpg              a photo draft   (same optional texts)
//   inbox/<project>/<post>/*.jpg|*.mp4      a carousel draft, or a photo with one image (+ caption.txt,
//                                           comment.txt, comment2.txt, alt.txt), like a project's posts/<post>/
//
// The repo's naming, so a draft maps onto the queue later. Folders starting with "_" are skipped (_posted/). An item
// waits until the store has its checksum and nothing in it changed for SETTLE_S, so a caption uploaded a minute after the
// video still makes it in. Each item makes one draft only (inbox_seen), even if the draft is refused.

import { instagramAccounts } from "./accounts";
import type { Db } from "./db";
import type { Env } from "./env";
import { mediaStores } from "./media/index";
import { isMedia, isVideo, type MediaEntry, type MediaStore } from "./media/store";
import { notifier } from "./notify";
import { jsonList } from "./sql";
import { newDrafts } from "./texts/notifications";

/** Wait this long after the last change in an item before drafting it. */
export const SETTLE_S = 10 * 60;
/** Items drafted per run (each costs a few subrequests; the free plan allows 50 per invocation). */
const ITEMS_PER_RUN = 6;

interface Item {
  store: MediaStore;
  key: string;
  project: string;
  name: string;
  media: MediaEntry[];
  texts: Record<"caption" | "comment" | "comment2" | "alt", MediaEntry | undefined>;
}

const unix = (t?: string) => (t ? Math.floor(Date.parse(t) / 1000) : 0);
const stem = (n: string) => n.replace(/\.[^.]+$/, "");

/** The workspace a project's drafts go to: the one whose plan has it (the most items, if several do), else the one
 *  the store's inbox feeds; null when neither: the draft waits. Nothing goes to an archived workspace (nobody works
 *  in it): its projects, and a store feeding it, wait. */
export async function inboxWorkspace(db: Db, store: string, project: string): Promise<string | null> {
  const planned = await db
    .prepare(
      `SELECT p.workspace_id, MAX(w.archived_at) AS archived, COUNT(*) AS n FROM plan_items p
         JOIN workspaces w ON w.id = p.workspace_id
       WHERE p.folder LIKE '%/' || ?1
       GROUP BY p.workspace_id
       ORDER BY CASE WHEN MAX(w.archived_at) IS NULL THEN 0 ELSE 1 END, n DESC, p.workspace_id LIMIT 1`,
    )
    .bind(project)
    .first<{ workspace_id: string; archived: number | null }>();
  // a project only an archived workspace plans is that workspace's: it waits rather than go to another
  if (planned) return planned.archived === null ? planned.workspace_id : null;
  const r = await db
    .prepare(
      `SELECT s.inbox_workspace FROM media_store s
         JOIN workspaces w ON w.id = s.inbox_workspace AND w.archived_at IS NULL
       WHERE s.kind = ?1`,
    )
    .bind(store)
    .first<{ inbox_workspace: string | null }>();
  return r?.inbox_workspace ?? null;
}

/** The project's Instagram account in the workspace, from its planned items; null when the project has none yet. */
async function accountOf(db: Db, project: string, workspaceId: string): Promise<string | null> {
  const r = await db
    .prepare(
      `SELECT account, COUNT(*) AS n FROM plan_items WHERE folder LIKE '%/' || ?1 AND workspace_id = ?2
       GROUP BY account ORDER BY n DESC LIMIT 1`,
    )
    .bind(project, workspaceId)
    .first<{ account: string }>();
  return r?.account ?? null;
}

/** inbox/ folder id, cached in settings per store (it saves a walk of the path each run). */
async function inboxId(env: Env, store: MediaStore): Promise<string | null> {
  const key = `inbox_folder:${store.id}`;
  const hit = await env.DB.prepare("SELECT value FROM settings WHERE key = ?1").bind(key).first<{ value: string }>();
  if (hit) return hit.value;
  const node = await store.resolve("UPLOADS/inbox");
  if (!node) return null;
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = ?2")
    .bind(key, node.id)
    .run();
  return node.id;
}

/** What's waiting in one store's inbox: a Reel or photo per media file, a post per folder. */
async function inboxItems(store: MediaStore, root: string): Promise<Item[]> {
  const items: Item[] = [];
  for (const proj of (await store.list(root)).filter((f) => f.folder && !f.name.startsWith("_"))) {
    const kids = await store.list(proj.id);
    for (const f of kids.filter((k) => isMedia(k))) {
      const s = stem(f.name);
      const t = (n: string) => kids.find((k) => k.name === n);
      items.push({
        store,
        key: f.id,
        project: proj.name,
        name: s,
        media: [f],
        texts: {
          caption: t(`${s}.txt`),
          comment: t(`${s}.comment.txt`),
          comment2: t(`${s}.comment2.txt`),
          alt: undefined,
        },
      });
    }
    for (const dir of kids.filter((k) => k.folder && !k.name.startsWith("_"))) {
      const inner = await store.list(dir.id);
      const t = (n: string) => inner.find((k) => k.name === n);
      items.push({
        store,
        key: dir.id,
        project: proj.name,
        name: dir.name,
        media: inner.filter((k) => isMedia(k)).sort((a, b) => a.name.localeCompare(b.name)),
        texts: { caption: t("caption.txt"), comment: t("comment.txt"), comment2: t("comment2.txt"), alt: t("alt.txt") },
      });
    }
  }
  return items;
}

export async function scanInbox(
  env: Env,
  deps: { fetch: typeof fetch; now: Date },
): Promise<{ drafted: string[]; waiting: number; note?: string }> {
  const nowS = Math.floor(deps.now.getTime() / 1000);
  const stores = (await mediaStores(env, deps.fetch)).all;
  const items: Item[] = [];
  let inboxes = 0;
  const failed: string[] = [];
  for (const store of stores) {
    // one store failing (a revoked grant, a bucket key that stopped working) doesn't stop the others
    try {
      const root = await inboxId(env, store);
      if (!root) continue;
      inboxes++;
      items.push(...(await inboxItems(store, root)));
    } catch (e) {
      failed.push(`${store.id}: ${(e as Error).message.slice(0, 200)}`);
    }
  }
  if (failed.length) console.log(`inbox: ${failed.join("; ")}`);
  if (!inboxes) return { drafted: [], waiting: 0, note: "no UPLOADS/inbox folder in any media store" };

  if (!items.length) return { drafted: [], waiting: 0 };
  const done = new Set<string>();
  for (const store of stores) {
    const keys = items.filter((i) => i.store === store).map((i) => i.key);
    if (!keys.length) continue;
    const seen = await env.DB.prepare(
      `SELECT media_id FROM inbox_seen WHERE store = ?2 AND media_id IN ${jsonList(env.DB, 1)}`,
    )
      .bind(JSON.stringify(keys), store.id)
      .all<{ media_id: string }>();
    for (const r of seen.results) done.add(`${store.id}:${r.media_id}`);
  }
  const fresh = items.filter((i) => !done.has(`${i.store.id}:${i.key}`) && i.media.length);
  // each project's workspace, once per store; an item without one waits (unseen) until a plan or the store names one
  const where = new Map<string, Promise<string | null>>();
  const workspaceOf = (i: Item) => {
    const k = `${i.store.id}:${i.project}`;
    if (!where.has(k)) where.set(k, inboxWorkspace(env.DB, i.store.id, i.project));
    return where.get(k) as Promise<string | null>;
  };
  const ready: (Item & { workspaceId: string })[] = [];
  for (const i of fresh) {
    if (ready.length >= ITEMS_PER_RUN) break;
    const files = [...i.media, ...Object.values(i.texts).filter((x): x is MediaEntry => !!x)];
    const settled =
      i.media.every((m) => m.checksum) && Math.max(...files.map((f) => unix(f.modifiedAt))) <= nowS - SETTLE_S;
    const workspaceId = settled ? await workspaceOf(i) : null;
    if (workspaceId) ready.push({ ...i, workspaceId });
  }
  const drafted: { title: string; workspaceId: string }[] = [];
  // a project without planned items starts on its workspace's first Instagram account
  const firsts = new Map<string, string>();
  const firstAccount = async (ws: string) => {
    if (!firsts.has(ws)) firsts.set(ws, (await instagramAccounts(env.DB, ws))[0]?.id ?? "");
    return firsts.get(ws) as string;
  };
  for (const i of ready) {
    const store = i.store;
    const account = await accountOf(env.DB, i.project, i.workspaceId);
    const video = i.media.some((m) => isVideo(m));
    const kind = i.media.length > 1 ? "carousel" : video ? "reel" : "photo";
    const text = async (f?: MediaEntry) => (f ? (await store.readText(f.id)).trim() : undefined);
    const payload: Record<string, unknown> = {
      title: `${i.project}/${i.name}`,
      folder: i.project,
      name: i.name,
      caption: await text(i.texts.caption),
      comment: await text(i.texts.comment),
      comment2: await text(i.texts.comment2),
      alt: await text(i.texts.alt),
      media: i.media.map((m) => ({ store: store.id, id: m.id })),
      files: i.media.map((m) => ({ store: store.id, id: m.id, name: m.name, mime: m.mime, checksum: m.checksum })),
      ...(i.media.length > 10 ? { note: `${i.media.length} media files: a carousel takes 10 at most` } : {}),
      ...(account ? {} : { note: `no planned items in ${i.project} yet: pick the account when scheduling it` }),
    };
    const id = `d_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO drafts (id, kind, account, payload, source, created_by, status, created_at, updated_at, workspace_id) VALUES (?1, ?2, ?3, ?4, 'drive', ?7, 'draft', ?5, ?5, ?6)",
      ).bind(
        id,
        kind,
        account ?? (await firstAccount(i.workspaceId)),
        JSON.stringify(payload),
        nowS,
        i.workspaceId,
        `${store.id}-inbox`,
      ),
      env.DB.prepare(
        "INSERT INTO inbox_seen (store, media_id, draft_id, at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (store, media_id) DO NOTHING",
      ).bind(store.id, i.key, id, nowS),
    ]);
    drafted.push({ title: `${i.project}/${i.name}`, workspaceId: i.workspaceId });
  }
  // each workspace hears of its own drafts
  const note = notifier(env, deps.fetch, nowS);
  for (const ws of new Set(drafted.map((d) => d.workspaceId)))
    await note.send(newDrafts(drafted.filter((d) => d.workspaceId === ws).map((d) => d.title)), ws);
  return { drafted: drafted.map((d) => d.title), waiting: fresh.length - drafted.length };
}
