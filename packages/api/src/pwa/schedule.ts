// Draft → scheduled item: the owner picks the account, date and time in the app, edits
// the texts, and the draft becomes a plan item whose texts and media live in D1 (content = 'db'). It still needs
// the usual passkey approval (same fingerprints: text sha256 + the media's checksums) before the scheduler publishes it.
import { listAccounts } from "@bongsu/core/accounts";
import {
  dueFrom,
  freeSlots,
  getItem,
  isPosted,
  keyClass,
  makeKey,
  slotMessage,
  slotTaken,
  TextsError,
  WhenError,
  youtubeTextsStatement,
} from "@bongsu/core/data";
import type { Env } from "@bongsu/core/env";
import { checkTexts, parseTexts, type YouTubeTexts } from "@bongsu/core/formats/youtube-texts";
import { mediaStores } from "@bongsu/core/media/index";
import { assertOwns, MediaError } from "@bongsu/core/media/owns";
import { platform } from "@bongsu/core/platforms/index";
import { type Format, OptionsError, type Platform, validateOptions } from "@bongsu/core/platforms/types";
import { workspaceSettings } from "@bongsu/core/workspaces";
import { videoAlone } from "./approve";

export class ScheduleError extends Error {
  constructor(
    public status: 400 | 404 | 409,
    msg: string,
    public extra?: Record<string, unknown>,
  ) {
    super(msg);
  }
}

const NAME = /^[A-Za-z0-9_.-]{1,80}$/;
const text = (v: unknown, max: number) =>
  typeof v === "string" && v.trim() ? v.replace(/\r\n/g, "\n").trim().slice(0, max) : null;

/** A video's texts, checked for the platform (a TextsError is the caller's mistake: 400). */
function checked(p: Platform, raw: unknown): YouTubeTexts | null {
  try {
    return checkTexts(p, raw);
  } catch (e) {
    if (e instanceof TextsError) throw new ScheduleError(400, e.message);
    throw e;
  }
}

/** A YouTube video's settings as the owner or the draft gave them, checked as a video. */
function checkedOptions(p: Platform, given: Record<string, unknown>): Record<string, unknown> {
  try {
    return validateOptions(p, "video", given);
  } catch (e) {
    if (e instanceof OptionsError) throw new ScheduleError(400, e.message);
    throw e;
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

interface DraftRow {
  id: string;
  kind: string;
  account: string;
  payload: string;
  status: string;
  texts: string | null;
}

/** `tz`: the owner's zone, which the date and time are on. */
export async function scheduleDraft(
  env: Env,
  fetcher: typeof fetch,
  id: string,
  b: Record<string, unknown>,
  nowS: number,
  tz: string,
  workspaceId: string,
  userId: string,
): Promise<{ key: string }> {
  const d = await env.DB.prepare(
    "SELECT id, kind, account, payload, status, texts, workspace_id FROM drafts WHERE id = ?1 AND workspace_id = ?2",
  )
    .bind(id, workspaceId)
    .first<DraftRow>();
  if (!d || d.status !== "draft") throw new ScheduleError(404, `no open draft ${id}`);
  if (d.kind === "shorts_comment") throw new ScheduleError(400, "a Shorts comment draft can't be scheduled here");
  const p = JSON.parse(d.payload) as {
    media?: { store?: unknown; id?: unknown }[];
    folder?: string;
    name?: string;
    title?: string;
    options?: unknown;
  };
  const media = (p.media ?? [])
    .filter((m) => typeof m?.store === "string" && typeof m?.id === "string" && m.id)
    .map((m) => ({ store: String(m.store), id: String(m.id) }));
  if (!media.length) throw new ScheduleError(400, "the draft has no media files to publish");
  // a YouTube video brings its subtitle files and thumbnail along, so its limit is wider than a carousel's
  if (media.length > 50) throw new ScheduleError(400, "a draft takes 50 files at most");
  // A last check: a draft's payload may predate the checks when it was made, or come from a path that skipped them.
  try {
    await assertOwns(
      await mediaStores(env, fetcher, workspaceId),
      (await workspaceSettings(env.DB, workspaceId)).mediaFolder,
      media,
    );
  } catch (e) {
    if (e instanceof MediaError) throw new ScheduleError(e.status, e.message);
    throw e;
  }

  const account = String(b.account ?? d.account);
  const accounts = (await listAccounts(env.DB, { workspaceId })).filter((a) => platform(a.platform)?.formats.length);
  const ids = accounts.map((a) => a.id);
  const plat = platform(accounts.find((a) => a.id === account)?.platform ?? "");
  if (!plat) throw new ScheduleError(400, `account must be one of ${ids.join(", ")}`);
  const tube = plat.id === "youtube";
  if (tube && d.kind !== "reel") throw new ScheduleError(400, `${plat.name} takes a video draft`);
  if (!tube && media.length > 10) throw new ScheduleError(400, "a carousel takes 10 media at most");
  // a video draft with its subtitle files and thumbnail is a YouTube video: elsewhere the first file would go out as
  // the Reel, and that may be the .srt or the .jpg
  if (!tube && d.kind === "reel" && media.length > 1) throw new ScheduleError(400, videoAlone(plat.name));
  if (tube && b.format === "story") throw new ScheduleError(400, `${plat.name} has no Stories`);
  // The video's own texts: the body's, else the draft's. Instagram refuses them (checkTexts says so).
  const texts = checked(plat, "texts" in b ? b.texts : parseTexts(d.texts));
  // A Story: one image or video, no caption or comments, and it doesn't take an hour slot.
  const story = b.format === "story";
  if (story && media.length !== 1) throw new ScheduleError(400, "a Story is one image or one video");
  const caption = story ? null : text(b.caption, plat.limits.captionMax);
  // a YouTube video's description may be empty here (a draft is scheduled before it's written), but approval asks
  // for a non-empty one, as for any caption
  if (!story && !caption && !tube) throw new ScheduleError(400, "a caption is needed");
  const project = String(p.folder ?? "drafts");
  const name = String(b.name ?? p.name ?? id);
  if (!NAME.test(name) || !NAME.test(project)) throw new ScheduleError(400, "name: letters, digits, _ . - only");

  // a draft's media decide the format later unless it's a Story or a video draft (a Reel)
  const format: Format | null = story ? "story" : d.kind === "reel" ? "video" : null;
  let due: number | null | undefined;
  try {
    due = dueFrom({ date: b.date ?? null, time: b.time ?? null }, format, tz);
  } catch (e) {
    if (e instanceof WhenError) throw new ScheduleError(400, e.message);
    throw e;
  }
  if (due == null) throw new ScheduleError(400, "pick a date");
  // The project's folder from its planned items (keeps channel/group filters right), else inbox/<project>.
  const known = await env.DB.prepare(
    "SELECT folder FROM plan_items WHERE folder LIKE '%/' || ?1 AND account = ?2 LIMIT 1",
  )
    .bind(project, account)
    .first<{ folder: string }>();
  const folder = known?.folder ?? `inbox/${project}`;
  const key = makeKey(keyClass(format), folder, name);
  // A YouTube video's settings: the draft's (create_draft kept them in its payload), the body's on top.
  let options: Record<string, unknown> = b.location && !story ? { location: String(b.location).slice(0, 40) } : {};
  if (tube) {
    if (b.options !== undefined && !isObject(b.options)) throw new ScheduleError(400, "options must be an object");
    options = checkedOptions(plat, {
      ...(isObject(p.options) ? p.options : {}),
      ...(isObject(b.options) ? b.options : {}),
    });
  }
  const taken = story ? null : await slotTaken(env.DB, account, due, tz, key);
  if (taken) {
    const free = await freeSlots(env.DB, account, due, tz, key);
    throw new ScheduleError(
      409,
      `${slotMessage(account, taken, tz)}${free.length ? ` (free: ${free.map((f) => `${f.date} ${f.time}`).join(", ")})` : ""}`,
      { suggestions: free },
    );
  }
  const r = await env.DB.prepare(
    `INSERT INTO plan_items (item_key, format, account, folder, name, due_at, options, hold, note, sort, updated_by, content, caption, comment, alt, media, draft_id, comment2, workspace_id, created_at, updated_at, texts, texts_at, texts_by)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8, (SELECT COALESCE(MAX(sort), 0) + 1 FROM plan_items), 'owner@app', 'db', ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?16, ?17, ?18, ?19)
     ON CONFLICT (item_key) DO NOTHING RETURNING item_key`,
  )
    .bind(
      key,
      format,
      account,
      folder,
      name,
      due,
      JSON.stringify(options),
      `from draft ${id}`,
      caption,
      story ? null : text(b.comment, 2200),
      format === null ? text(b.alt, 5000) : null,
      JSON.stringify(media),
      id,
      story ? null : text(b.comment2, 2200),
      workspaceId,
      nowS,
      texts === null ? null : JSON.stringify(texts),
      texts === null ? null : nowS,
      texts === null ? null : "owner@app",
    )
    .first();
  if (!r) throw new ScheduleError(409, `${key} is already planned: pick another name`);
  await env.DB.batch([
    env.DB.prepare("UPDATE drafts SET status = 'approved', updated_at = ?1 WHERE id = ?2").bind(nowS, id),
    env.DB.prepare(
      "INSERT INTO audit (at, actor, action, target, detail, user_id, workspace_id) VALUES (?1, ?2, 'draft_schedule', ?3, ?4, ?5, ?6)",
    ).bind(nowS, `user:${userId}`, key, JSON.stringify({ draft: id, due_at: due }), userId, workspaceId),
  ]);
  return { key };
}

/** Edit a draft-made item's texts (content = 'db', not posted yet). An approved item then needs approving again. */
export async function editTexts(
  env: Env,
  key: string,
  b: Record<string, unknown>,
  nowS: number,
  workspaceId: string,
  userId: string,
): Promise<{ key: string }> {
  const i = await getItem(env.DB, key, workspaceId);
  if (!i) throw new ScheduleError(404, `${key} isn't planned`);
  // Any item, repo or draft: the texts the scheduler posts are this copy (a repo item's files aren't changed; the
  // importer or `bongsu texts set` with those files brings the scheduler in step).
  if (await isPosted(env.DB, key)) throw new ScheduleError(409, `${key} was published`);
  const plat = platform(
    (await listAccounts(env.DB, { workspaceId, all: true })).find((a) => a.id === i.account)?.platform ?? "",
  );
  if (!plat) throw new ScheduleError(400, `${i.account} isn't a publishing account`);
  const tube = plat.id === "youtube";
  // Checked before anything is written, so a bad title leaves the item as it was.
  const texts = "texts" in b ? checked(plat, b.texts) : undefined;
  // A YouTube video's form may send only some fields (a texts-only edit): what is absent keeps its stored value.
  // Instagram's form always sends them all, so an absent one clears there.
  const field = (name: "caption" | "comment" | "comment2" | "alt", max: number) =>
    tube && !(name in b) ? i[name] : text(b[name], max);
  const caption = field("caption", plat.limits.captionMax);
  if (!caption && i.format !== "story" && !tube) throw new ScheduleError(400, "a caption is needed");
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE plan_items SET caption = ?1, comment = ?2, alt = ?3, comment2 = ?6, texts_at = ?4, texts_by = 'owner@app', updated_at = ?4, updated_by = 'owner@app' WHERE item_key = ?5 AND workspace_id = ?7",
    ).bind(
      caption,
      field("comment", 2200),
      i.format !== "video" && i.format !== "story" ? field("alt", 5000) : null,
      nowS,
      key,
      field("comment2", 2200),
      workspaceId,
    ),
    // in the same batch, so the description and the texts are written together or not at all
    ...(texts === undefined ? [] : [youtubeTextsStatement(env.DB, key, texts, "owner@app", nowS, workspaceId)]),
    env.DB.prepare(
      "INSERT INTO audit (at, actor, action, target, detail, user_id, workspace_id) VALUES (?1, ?2, 'edit_texts', ?3, '{}', ?4, ?5)",
    ).bind(nowS, `user:${userId}`, key, userId, workspaceId),
  ]);
  return { key };
}
