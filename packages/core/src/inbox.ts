// The inbox, its own cron run: whatever is dropped in UPLOADS/inbox/<project>/ in the media store becomes a draft (+ a
// notification), for the owner to review. Nothing here publishes or approves.
//
//   inbox/<project>/<name>.mp4              a Reel draft    (+ <name>.txt caption, <name>.comment.txt, <name>.comment2.txt)
//   inbox/<project>/<name>.jpg              a photo draft   (same optional texts)
//   inbox/<project>/<post>/*.jpg|*.mp4      a carousel draft, or a photo with one image (+ caption.txt,
//                                           comment.txt, comment2.txt, alt.txt), like a project's posts/<post>/
//
// The repo's naming, so a draft maps onto the queue later. Folders starting with "_" are skipped (_posted/). An item
// waits until the store has its checksum and nothing in it changed for SETTLE_S, so a caption uploaded a minute after the
// video still makes it in. Each item makes one draft only (inbox_seen), even if the draft is refused.

import { DEFAULT_WORKSPACE, instagramAccounts } from "./accounts";
import type { Db } from "./db";
import type { Env } from "./env";
import { mediaStore } from "./media/index";
import { isMedia, isVideo, type MediaEntry, type MediaStore } from "./media/store";
import { notifier } from "./notify";
import { jsonList } from "./sql";
import { newDrafts } from "./texts/notifications";

/** Wait this long after the last change in an item before drafting it. */
export const SETTLE_S = 10 * 60;
/** Items drafted per run (each costs a few subrequests; the free plan allows 50 per invocation). */
const ITEMS_PER_RUN = 6;

interface Item {
  key: string;
  project: string;
  name: string;
  media: MediaEntry[];
  texts: Record<"caption" | "comment" | "comment2" | "alt", MediaEntry | undefined>;
}

const unix = (t?: string) => (t ? Math.floor(Date.parse(t) / 1000) : 0);
const stem = (n: string) => n.replace(/\.[^.]+$/, "");

/** The project's Instagram account, from its planned items; null when the project has none yet. */
async function accountOf(db: Db, project: string): Promise<string | null> {
  const r = await db
    .prepare(
      "SELECT account, COUNT(*) AS n FROM plan_items WHERE folder LIKE '%/' || ?1 GROUP BY account ORDER BY n DESC LIMIT 1",
    )
    .bind(project)
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

export async function scanInbox(
  env: Env,
  deps: { fetch: typeof fetch; now: Date },
): Promise<{ drafted: string[]; waiting: number; note?: string }> {
  const nowS = Math.floor(deps.now.getTime() / 1000);
  const store = mediaStore(env, deps.fetch);
  const root = await inboxId(env, store);
  if (!root) return { drafted: [], waiting: 0, note: "no UPLOADS/inbox folder" };
  const items: Item[] = [];
  for (const proj of (await store.list(root)).filter((f) => f.folder && !f.name.startsWith("_"))) {
    const kids = await store.list(proj.id);
    for (const f of kids.filter((k) => isMedia(k))) {
      const s = stem(f.name);
      const t = (n: string) => kids.find((k) => k.name === n);
      items.push({
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
        key: dir.id,
        project: proj.name,
        name: dir.name,
        media: inner.filter((k) => isMedia(k)).sort((a, b) => a.name.localeCompare(b.name)),
        texts: { caption: t("caption.txt"), comment: t("comment.txt"), comment2: t("comment2.txt"), alt: t("alt.txt") },
      });
    }
  }
  if (!items.length) return { drafted: [], waiting: 0 };
  const seen = await env.DB.prepare(
    `SELECT media_id FROM inbox_seen WHERE store = ?2 AND media_id IN ${jsonList(env.DB, 1)}`,
  )
    .bind(JSON.stringify(items.map((i) => i.key)), store.id)
    .all<{ media_id: string }>();
  const done = new Set(seen.results.map((r) => r.media_id));
  const fresh = items.filter((i) => !done.has(i.key) && i.media.length);
  const ready = fresh
    .filter((i) => {
      const files = [...i.media, ...Object.values(i.texts).filter((x): x is MediaEntry => !!x)];
      return i.media.every((m) => m.checksum) && Math.max(...files.map((f) => unix(f.modifiedAt))) <= nowS - SETTLE_S;
    })
    .slice(0, ITEMS_PER_RUN);
  const drafted: string[] = [];
  // The inbox feeds the default workspace; a project without planned items starts on its first Instagram account.
  const fallback = (await instagramAccounts(env.DB, DEFAULT_WORKSPACE))[0]?.id ?? "";
  for (const i of ready) {
    const account = await accountOf(env.DB, i.project);
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
        "INSERT INTO drafts (id, kind, account, payload, source, created_by, status, created_at, updated_at, workspace_id) VALUES (?1, ?2, ?3, ?4, 'drive', 'drive-inbox', 'draft', ?5, ?5, ?6)",
      ).bind(id, kind, account ?? fallback, JSON.stringify(payload), nowS, DEFAULT_WORKSPACE),
      env.DB.prepare(
        "INSERT INTO inbox_seen (store, media_id, draft_id, at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (store, media_id) DO NOTHING",
      ).bind(store.id, i.key, id, nowS),
    ]);
    drafted.push(`${i.project}/${i.name}`);
  }
  if (drafted.length) {
    const note = notifier(env.DB, deps.fetch, env.NOTIFY_URL, nowS, env);
    await note.send(newDrafts(drafted));
  }
  return { drafted, waiting: fresh.length - drafted.length };
}
