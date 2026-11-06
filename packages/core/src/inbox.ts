// The inbox, its own cron run: whatever is dropped in <media folder>/inbox/<project>/ in the media stores a workspace can
// use (the instance's and its own) becomes a draft (+ a notification) of that workspace, for it to review; the draft
// records the store its files are in. Nothing here publishes or approves. A run scans at most
// inboxWorkspacesPerRun(env) workspaces (the free plan allows 50 subrequests per invocation), the next one picks up
// after the last (settings.inbox_cursor), so every workspace is reached in a few runs.
//
//   inbox/<project>/<name>.mp4              a Reel draft    (+ <name>.txt caption, <name>.comment.txt, <name>.comment2.txt)
//   inbox/<project>/<name>.jpg              a photo draft   (same optional texts)
//   inbox/<project>/<post>/*.jpg|*.mp4      a carousel draft, or a photo with one image (+ caption.txt,
//                                           comment.txt, comment2.txt, alt.txt), like a project's posts/<post>/
//
// A YouTube video also takes title.txt (or <name>.title.txt beside a single file), caption.<lang>.txt + title.<lang>.txt
// pairs (translations) and, in a folder, <lang>.srt|.vtt subtitles and thumbnail.jpg|png: they stay with the video.
//
// The repo's naming, so a draft maps onto the queue later. Folders starting with "_" are skipped (_posted/, _uploads/). An item
// waits until the store has its checksum and nothing in it changed for SETTLE_S, so a caption uploaded a minute after the
// video still makes it in. Each item makes one draft only (inbox_seen), even if the draft is refused.

import { instagramAccounts } from "./accounts";
import { INBOX_WORKSPACES_PER_RUN, INBOX_WORKSPACES_PER_RUN_MAX } from "./constants";
import type { Db } from "./db";
import type { Env } from "./env";
import { checkTexts, LANG, type YouTubeTexts } from "./formats/youtube-texts";
import { mediaPath } from "./media/folders";
import { mediaStores } from "./media/index";
import { isMedia, isVideo, type MediaEntry, type MediaStore } from "./media/store";
import { notifier } from "./notify";
import { platform } from "./platforms/index";
import { isSubtitle, THUMBNAIL, videoWithExtras } from "./platforms/youtube";
import { jsonList } from "./sql";
import { newDrafts } from "./texts/notifications";
import { workspaceSettings } from "./workspaces";

/** Wait this long after the last change in an item before drafting it. */
export const SETTLE_S = 10 * 60;
/** Items drafted per run (each costs a few subrequests; the free plan allows 50 per invocation), shared among the
 *  workspaces reached. */
const ITEMS_PER_RUN = 6;

interface Item {
  workspaceId: string;
  store: MediaStore;
  key: string;
  project: string;
  name: string;
  media: MediaEntry[];
  texts: Record<"caption" | "comment" | "comment2" | "alt", MediaEntry | undefined>;
  /** The YouTube title and translation files (text, not media); `stem` is the video's name for a single file. */
  titles: MediaEntry[];
  stem: string | null;
  /** More translation languages were there than are read. */
  capped: boolean;
}

/** Languages whose translation files are read per item: each costs two store reads. */
const MAX_TRANSLATIONS = 5;
/** Store reads (lists and file reads) a run makes at most. The free plan allows 50 subrequests per invocation and the
 *  run's other calls (settings, the notification, the media-store token) need room, so this stays well under. */
export const INBOX_READ_BUDGET = 30;

const TEXT_FILE = /^(caption|title)\.([^.]+(?:\.[^.]+)*)\.txt$/;
/** The language code in a translation file's name, or "" when it isn't one. */
const langOf = (n: string) => {
  const c = TEXT_FILE.exec(n)?.[2] ?? "";
  return LANG.test(c) ? c : "";
};

/** The title and translation files of an item: title.txt (or <stem>.title.txt) and the first MAX_TRANSLATIONS
 *  caption.<lang>.txt / title.<lang>.txt pairs (only in a folder); `capped` says more languages were left out. */
export function inboxTextFiles<T extends { name: string }>(
  files: T[],
  stem: string | null,
): { files: T[]; capped: boolean } {
  const own = stem === null ? "title.txt" : `${stem}.title.txt`;
  const all = [...new Set(files.filter((f) => stem === null).map((f) => langOf(f.name)))].filter(Boolean).sort();
  const codes = all.slice(0, MAX_TRANSLATIONS);
  return {
    files: files.filter((f) => f.name === own || (stem === null && codes.includes(langOf(f.name)))),
    capped: all.length > MAX_TRANSLATIONS,
  };
}

/** A video's YouTube texts from its text files. null when there is no title or translation file; a translation
 *  needs both of its files, so a lone half is left out (`partial` names it). */
export function inboxTexts(files: { name: string; text: string }[], stem: string | null): YouTubeTexts | null {
  return readTexts(files, stem).texts;
}

function readTexts(files: { name: string; text: string }[], stem: string | null) {
  const own = stem === null ? "title.txt" : `${stem}.title.txt`;
  const title = files.find((f) => f.name === own)?.text.trim();
  const translations: Record<string, { title: string; description: string }> = {};
  const partial: string[] = [];
  for (const code of new Set(files.map((f) => (stem === null ? langOf(f.name) : "")).filter(Boolean))) {
    const t = files.find((f) => f.name === `title.${code}.txt`);
    const c = files.find((f) => f.name === `caption.${code}.txt`);
    if (t && c) translations[code] = { title: t.text.trim(), description: c.text.trim() };
    else partial.push(code);
  }
  const any = title !== undefined || Object.keys(translations).length > 0;
  const texts: YouTubeTexts | null = any
    ? {
        title: title ?? "",
        ...(Object.keys(translations).length ? { translations } : {}),
      }
    : null;
  return { texts, partial };
}

const unix = (t?: string) => (t ? Math.floor(Date.parse(t) / 1000) : 0);
const stem = (n: string) => n.replace(/\.[^.]+$/, "");

/** Workspaces scanned per run: the INBOX_WORKSPACES_PER_RUN variable when it is a whole number from 1 (at most
 *  INBOX_WORKSPACES_PER_RUN_MAX), else the default for Cloudflare's free plan. Node sets its own (apps/node/src/env.ts). */
export function inboxWorkspacesPerRun(env: Pick<Env, "INBOX_WORKSPACES_PER_RUN">): number {
  const n = Number(env.INBOX_WORKSPACES_PER_RUN);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, INBOX_WORKSPACES_PER_RUN_MAX) : INBOX_WORKSPACES_PER_RUN;
}

const setting = (env: Env, key: string) =>
  env.DB.prepare("SELECT value FROM settings WHERE key = ?1")
    .bind(key)
    .first<{ value: string }>()
    .then((r) => r?.value ?? null);
const saveSetting = (env: Env, key: string, value: string) =>
  env.DB.prepare("INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = ?2")
    .bind(key, value)
    .run();

/** The workspaces this run scans: the active ones (an archived workspace has nobody working in it) by id, from the
 *  first after the cursor on, wrapping round, at most `limit`. The cursor is only a position, so it doesn't matter
 *  whether its workspace is still there. */
export function nextWorkspaces(ids: string[], cursor: string | null, limit: number): string[] {
  // sorted here, the way `<=` compares: the database's ORDER BY may follow a collation that doesn't
  const sorted = [...ids].sort();
  const after = cursor === null ? 0 : sorted.filter((i) => i <= cursor).length;
  return [...sorted.slice(after), ...sorted.slice(0, after)].slice(0, limit);
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

/** The workspace's inbox/ folder id in the store, cached in settings (it saves a walk of the path each run). */
async function inboxId(env: Env, store: MediaStore, folder: string): Promise<string | null> {
  const key = `inbox_folder:${store.id}:${folder}`;
  const hit = await setting(env, key);
  if (hit) return hit;
  const node = await store.resolve(mediaPath(folder, "inbox"));
  if (!node) return null;
  await saveSetting(env, key, node.id);
  return node.id;
}

/** What's waiting in one store's inbox: a Reel or photo per media file, a post per folder. */
async function inboxItems(
  store: MediaStore,
  workspaceId: string,
  root: string,
  reads: { used: number },
): Promise<Item[]> {
  const items: Item[] = [];
  reads.used++;
  for (const proj of (await store.list(root)).filter((f) => f.folder && !f.name.startsWith("_"))) {
    reads.used++;
    const kids = await store.list(proj.id);
    for (const f of kids.filter((k) => isMedia(k))) {
      const s = stem(f.name);
      const t = (n: string) => kids.find((k) => k.name === n);
      items.push({
        workspaceId,
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
        titles: inboxTextFiles(kids, s).files,
        stem: s,
        capped: false,
      });
    }
    for (const dir of kids.filter((k) => k.folder && !k.name.startsWith("_"))) {
      reads.used++;
      const inner = await store.list(dir.id);
      const t = (n: string) => inner.find((k) => k.name === n);
      const images = inner.filter((k) => isMedia(k));
      // subtitles and a thumbnail belong to a folder of exactly one video; anything else is a post as before
      const one = images.filter((k) => !THUMBNAIL.test(k.name)).length === 1 && images.some((k) => isVideo(k));
      const media = (one ? [...images, ...inner.filter((k) => isSubtitle(k.name))] : images).sort((a, b) =>
        a.name.localeCompare(b.name),
      );
      const text = inboxTextFiles(inner, null);
      items.push({
        workspaceId,
        store,
        key: dir.id,
        project: proj.name,
        name: dir.name,
        media,
        texts: { caption: t("caption.txt"), comment: t("comment.txt"), comment2: t("comment2.txt"), alt: t("alt.txt") },
        titles: text.files,
        stem: null,
        capped: text.capped,
      });
    }
  }
  return items;
}

export interface InboxRun {
  drafted: string[];
  /** Items found but not drafted yet (still settling, or past this run's share). */
  waiting: number;
  /** The workspaces this run scanned. */
  reached: string[];
  /** Active workspaces this run left for the next ones. */
  waitingWorkspaces: number;
  note?: string;
}

export async function scanInbox(env: Env, deps: { fetch: typeof fetch; now: Date }): Promise<InboxRun> {
  const nowS = Math.floor(deps.now.getTime() / 1000);
  const limit = inboxWorkspacesPerRun(env);
  const active = (
    await env.DB.prepare("SELECT id FROM workspaces WHERE archived_at IS NULL ORDER BY id").all<{
      id: string;
    }>()
  ).results.map((r) => r.id);
  const reached = nextWorkspaces(active, await setting(env, "inbox_cursor"), limit);
  const run = (r: Omit<InboxRun, "reached" | "waitingWorkspaces">): InboxRun => ({
    ...r,
    reached,
    waitingWorkspaces: active.length - reached.length,
  });
  // what the dashboard shows of the budget: written even when nothing came of the run
  await saveSetting(
    env,
    "inbox_last",
    JSON.stringify({ at: nowS, reached: reached.length, total: active.length, limit }),
  );
  if (reached.length) await saveSetting(env, "inbox_cursor", reached[reached.length - 1]);

  const items: Item[] = [];
  const stores = new Map<string, MediaStore>();
  let inboxes = 0;
  const reads = { used: 0 };
  const failed: string[] = [];
  for (const workspaceId of reached) {
    const folder = (await workspaceSettings(env.DB, workspaceId)).mediaFolder;
    // the instance's stores and the workspace's own, each looked at in the workspace's folder
    for (const store of (await mediaStores(env, deps.fetch, workspaceId)).all) {
      // one store failing (a revoked grant, a bucket key that stopped working) doesn't stop the others
      try {
        const root = await inboxId(env, store, folder);
        if (!root) continue;
        inboxes++;
        stores.set(store.id, store);
        items.push(...(await inboxItems(store, workspaceId, root, reads)));
      } catch (e) {
        failed.push(`${workspaceId}/${store.id}: ${(e as Error).message.slice(0, 200)}`);
      }
    }
  }
  if (failed.length) console.log(`inbox: ${failed.join("; ")}`);
  if (!inboxes) return run({ drafted: [], waiting: 0, note: "no inbox folder in any workspace's media folder" });

  if (!items.length) return run({ drafted: [], waiting: 0 });
  const done = new Set<string>();
  for (const store of stores.values()) {
    const keys = items.filter((i) => i.store.id === store.id).map((i) => i.key);
    if (!keys.length) continue;
    const seen = await env.DB.prepare(
      `SELECT media_id FROM inbox_seen WHERE store = ?2 AND media_id IN ${jsonList(env.DB, 1)}`,
    )
      .bind(JSON.stringify(keys), store.id)
      .all<{ media_id: string }>();
    for (const r of seen.results) done.add(`${store.id}:${r.media_id}`);
  }
  const fresh = items.filter((i) => !done.has(`${i.store.id}:${i.key}`) && i.media.length);
  const settled = (i: Item) => {
    const files = [...i.media, ...i.titles, ...Object.values(i.texts).filter((x): x is MediaEntry => !!x)];
    return i.media.every((m) => m.checksum) && Math.max(...files.map((f) => unix(f.modifiedAt))) <= nowS - SETTLE_S;
  };
  // each workspace reached gets its share (at least one), what one doesn't use going to the ones after it: a backlog
  // in one workspace doesn't starve the others of the run
  const ready: Item[] = [];
  let budget = ITEMS_PER_RUN;
  for (const [n, ws] of reached.entries()) {
    const share = Math.max(1, Math.floor(budget / (reached.length - n)));
    const mine = fresh.filter((i) => i.workspaceId === ws && settled(i)).slice(0, share);
    ready.push(...mine);
    budget = Math.max(0, budget - mine.length);
  }
  const drafted: { title: string; workspaceId: string }[] = [];
  // a project without planned items starts on its workspace's first Instagram account
  const firsts = new Map<string, string>();
  const firstAccount = async (ws: string) => {
    if (!firsts.has(ws)) firsts.set(ws, (await instagramAccounts(env.DB, ws))[0]?.id ?? "");
    return firsts.get(ws) as string;
  };
  // sent even when a later item throws (a store failing midway): the drafts already made still get announced
  try {
    for (const i of ready) {
      // what reading this item's texts will cost, from the names already listed; the run's first item always goes, so
      // one heavy item can't stall the inbox, the ones after it wait for the next run
      const cost = Object.values(i.texts).filter(Boolean).length + i.titles.length;
      if (drafted.length && reads.used + cost > INBOX_READ_BUDGET) break;
      reads.used += cost;
      await draftItem(i);
    }
  } finally {
    const note = notifier(env, deps.fetch, nowS);
    for (const ws of new Set(drafted.map((d) => d.workspaceId)))
      await note.send(newDrafts(drafted.filter((d) => d.workspaceId === ws).map((d) => d.title)), ws);
  }
  return run({ drafted: drafted.map((d) => d.title), waiting: fresh.length - drafted.length });

  async function draftItem(i: Item) {
    const store = i.store;
    const account = await accountOf(env.DB, i.project, i.workspaceId);
    const video = i.media.some((m) => isVideo(m));
    // a video with only subtitles and a thumbnail beside it is one YouTube video, not a carousel
    const asideOnly = videoWithExtras(i.media);
    const kind = asideOnly ? "reel" : i.media.length > 1 ? "carousel" : video ? "reel" : "photo";
    const read = await Promise.all(i.titles.map(async (f) => ({ name: f.name, text: await store.readText(f.id) })));
    const { texts, partial } = readTexts(read, i.stem);
    const notes: string[] = [];
    if (i.capped) notes.push(`only the first ${MAX_TRANSLATIONS} translations were read`);
    if (partial.length)
      notes.push(`${partial.map((c) => `${c}: needs both caption.${c}.txt and title.${c}.txt`).join("; ")}`);
    let checked: YouTubeTexts | null = null;
    const yt = platform("youtube");
    if (texts && yt)
      try {
        checked = checkTexts(yt, texts);
      } catch (e) {
        notes.push(`YouTube texts skipped: ${(e as Error).message}`);
      }
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
    };
    if (i.media.length > 10 && !asideOnly) notes.push(`${i.media.length} media files: a carousel takes 10 at most`);
    if (!account) notes.push(`no planned items in ${i.project} yet: pick the account when scheduling it`);
    if (notes.length) payload.note = notes.join(". ");
    const id = `d_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO drafts (id, kind, account, payload, source, created_by, status, created_at, updated_at, workspace_id, texts) VALUES (?1, ?2, ?3, ?4, 'drive', ?7, 'draft', ?5, ?5, ?6, ?8)",
      ).bind(
        id,
        kind,
        account ?? (await firstAccount(i.workspaceId)),
        JSON.stringify(payload),
        nowS,
        i.workspaceId,
        `${store.id}-inbox`,
        checked === null ? null : JSON.stringify(checked),
      ),
      env.DB.prepare(
        "INSERT INTO inbox_seen (store, media_id, draft_id, at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (store, media_id) DO NOTHING",
      ).bind(store.id, i.key, id, nowS),
    ]);
    drafted.push({ title: `${i.project}/${i.name}`, workspaceId: i.workspaceId });
  }
}
