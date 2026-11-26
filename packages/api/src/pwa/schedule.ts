// Draft → scheduled item: the owner picks the account, date and time in the app, edits
// the texts, and the draft becomes a plan item whose texts and media live in D1 (content = 'db'). It still needs
// the usual passkey approval (same fingerprints: text sha256 + the media's checksums) before the scheduler publishes it.
// One draft can go to several accounts at once (cross-posting): one item each, the caption cut to each network's limit.

import { listAccounts } from "@bongsu/core/accounts";
import {
  dueFrom,
  freeSlots,
  getItem,
  isPosted,
  keyClass,
  keyTakenElsewhere,
  makeKey,
  slotMessage,
  slotTaken,
  TextsError,
  WhenError,
  youtubeTextsStatement,
} from "@bongsu/core/data";
import type { DbStatement } from "@bongsu/core/db";
import type { Env } from "@bongsu/core/env";
import { cutGraphemes } from "@bongsu/core/formats/graphemes";
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
/** Accounts one draft can be scheduled to at once. */
const ACCOUNTS_MAX = 10;
const text = (v: unknown, max: number) =>
  typeof v === "string" && v.trim() ? cutGraphemes(v.replace(/\r\n/g, "\n").trim(), max) : null;

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
): Promise<{ key: string; keys: string[]; shortened: string[] }> {
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

  // One account, or several at once (cross-posting): each gets its own item and its own approval.
  const wanted = Array.isArray(b.accounts) ? [...new Set(b.accounts.map(String))] : [String(b.account ?? d.account)];
  if (!wanted.length || wanted.length > ACCOUNTS_MAX)
    throw new ScheduleError(400, `pick 1 to ${ACCOUNTS_MAX} accounts`);
  const several = wanted.length > 1;
  const accounts = (await listAccounts(env.DB, { workspaceId })).filter((a) => platform(a.platform)?.formats.length);
  const ids = accounts.map((a) => a.id);
  // A Story: one image or video, no caption or comments, and it doesn't take an hour slot.
  const story = b.format === "story";
  if (story && media.length !== 1) throw new ScheduleError(400, "a Story is one image or one video");
  const project = String(p.folder ?? "drafts");
  const baseName = String(b.name ?? p.name ?? id);
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

  const planned: { key: string; account: string; insert: DbStatement }[] = [];
  const shortened: string[] = [];
  for (const account of wanted) {
    const plat = platform(accounts.find((a) => a.id === account)?.platform ?? "");
    if (!plat) throw new ScheduleError(400, `account must be one of ${ids.join(", ")}`);
    // with several accounts, an error says which one it's about
    const at = (msg: string) => (several ? `@${account}: ${msg}` : msg);
    const tube = plat.id === "youtube";
    if (tube && d.kind !== "reel") throw new ScheduleError(400, at(`${plat.name} takes a video draft`));
    if (!tube && media.length > plat.limits.mediaMax)
      throw new ScheduleError(400, at(`${plat.name} takes ${plat.limits.mediaMax} files at most`));
    // a video draft with its subtitle files and thumbnail is a YouTube video: elsewhere the first file would go out as
    // the Reel, and that may be the .srt or the .jpg
    if (!tube && d.kind === "reel" && media.length > 1) throw new ScheduleError(400, at(videoAlone(plat.name)));
    if (story && !plat.formats.includes("story")) throw new ScheduleError(400, at(`${plat.name} has no Stories`));
    // The video's own texts: the body's, else the draft's. Only YouTube has them: with several accounts the others
    // simply don't get them; one account that isn't a channel refuses them (checkTexts says so).
    const texts = several && !tube ? null : checked(plat, "texts" in b ? b.texts : parseTexts(d.texts));
    // the caption as each network takes it: cut to its limit, which the owner sees on the item before approving
    const caption = story ? null : text(b.caption, plat.limits.captionMax);
    if (!story && !caption && !tube) throw new ScheduleError(400, at("a caption is needed"));
    if (caption && caption !== text(b.caption, Number.MAX_SAFE_INTEGER)) shortened.push(account);
    const name = several ? `${baseName}.${account}` : baseName;
    if (!NAME.test(name) || !NAME.test(project)) throw new ScheduleError(400, "name: letters, digits, _ . - only");
    // The project's folder from its planned items (keeps channel/group filters right), else inbox/<project>.
    const known = await env.DB.prepare(
      "SELECT folder FROM plan_items WHERE folder LIKE '%/' || ?1 AND account = ?2 LIMIT 1",
    )
      .bind(project, account)
      .first<{ folder: string }>();
    const folder = known?.folder ?? `inbox/${project}`;
    const key = makeKey(keyClass(format), folder, name);
    if (await keyTakenElsewhere(env.DB, key, workspaceId))
      throw new ScheduleError(409, at("that name is taken: pick another"));
    if (planned.some((x) => x.key === key) || (await getItem(env.DB, key, workspaceId)))
      throw new ScheduleError(409, at(`${key} is already planned: pick another name`));
    // A YouTube video's settings: the draft's (create_draft kept them in its payload), the body's on top.
    let options: Record<string, unknown> = b.location && !story ? { location: String(b.location).slice(0, 40) } : {};
    if (tube) {
      if (b.options !== undefined && !isObject(b.options)) throw new ScheduleError(400, "options must be an object");
      options = checkedOptions(plat, {
        ...(isObject(p.options) ? p.options : {}),
        ...(isObject(b.options) ? b.options : {}),
      });
    } else if (!plat.options.some((o) => o.key === "location")) options = {};
    const taken = story ? null : await slotTaken(env.DB, account, due, tz, key);
    if (taken) {
      const free = await freeSlots(env.DB, account, due, tz, key);
      throw new ScheduleError(
        409,
        at(
          `${slotMessage(account, taken, tz)}${free.length ? ` (free: ${free.map((f) => `${f.date} ${f.time}`).join(", ")})` : ""}`,
        ),
        { suggestions: free },
      );
    }
    planned.push({
      key,
      account,
      insert: env.DB.prepare(
        `INSERT INTO plan_items (item_key, format, account, folder, name, due_at, options, hold, note, sort, updated_by, content, caption, comment, alt, media, draft_id, comment2, workspace_id, created_at, updated_at, texts, texts_at, texts_by)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8, (SELECT COALESCE(MAX(sort), 0) + 1 FROM plan_items), 'owner@app', 'db', ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?16, ?17, ?18, ?19)`,
      ).bind(
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
      ),
    });
  }
  // every item or none: a name planned meanwhile fails the whole batch
  try {
    await env.DB.batch([
      ...planned.map((x) => x.insert),
      env.DB.prepare("UPDATE drafts SET status = 'approved', updated_at = ?1 WHERE id = ?2").bind(nowS, id),
      ...planned.map((x) =>
        env.DB.prepare(
          "INSERT INTO audit (at, actor, action, target, detail, user_id, workspace_id) VALUES (?1, ?2, 'draft_schedule', ?3, ?4, ?5, ?6)",
        ).bind(nowS, `user:${userId}`, x.key, JSON.stringify({ draft: id, due_at: due }), userId, workspaceId),
      ),
    ]);
  } catch (e) {
    if (/UNIQUE|constraint/i.test((e as Error).message))
      throw new ScheduleError(409, "one of the names was planned meanwhile: pick another name");
    throw e;
  }
  return { key: planned[0].key, keys: planned.map((x) => x.key), shortened };
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
