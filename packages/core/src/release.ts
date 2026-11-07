// Moving the release date of a scheduled YouTube video: by the owner, or by an agent key the owner opted in.
import { connectionSecret, youtubeAccounts } from "./accounts";
import { findUpload } from "./calendar";
import { ReleaseError, type Upload, YouTube } from "./clients/youtube";
import { RELEASE_LEAD_S } from "./constants";
import { freeSlots, slotMessage, slotTaken } from "./data";
import type { Env } from "./env";
import { utcIso, zoneStamp } from "./formats/time";
import { notifier } from "./notify";
import { releaseMoved } from "./texts/notifications";
import { memberName } from "./workspaces";
import { bongsuVideos } from "./youtube-videos";

export type ReleaseActor = { kind: "owner"; userId: string | null } | { kind: "key"; id: string; name: string };

export interface ReleaseRequest {
  workspaceId: string;
  videoId: string;
  /** The new release, unix seconds. */
  at: number;
  nowS: number;
  /** The caller's zone, for the stamps in the answer and the notification. */
  tz: string;
  actor: ReleaseActor;
}

export interface ReleaseResult {
  video: string;
  title: string;
  account: string;
  due: string;
  due_at: string;
  from: string;
  from_at: string;
}

/** The HTTP status every surface answers for a refused move. */
export const releaseStatus = (e: ReleaseError) => (e.reason === "missing" ? 404 : e.reason === "lead" ? 400 : 409);

/** The calendar reads the cached list for an hour: patch the moved video there, so it shows at once. */
async function patchCache(env: Env, accountId: string, videoId: string, iso: string): Promise<void> {
  const k = `yt_uploads:${accountId}`;
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?1").bind(k).first<{ value: string }>();
  if (!row) return;
  const items = (JSON.parse(row.value) as Upload[]).map((u) =>
    u.id === videoId ? { ...u, when: iso, publishAt: iso } : u,
  );
  // updated_at stays: the list's age is still the age of the other rows
  await env.DB.prepare("UPDATE settings SET value = ?2 WHERE key = ?1").bind(k, JSON.stringify(items)).run();
}

/** A Bongsu upload's release is its plan item's time: moving it voids the approval (the owner approves the new time),
 *  and YouTube is never called. The video's own `publishAt` is set by the job when it goes public. */
async function moveItem(env: Env, req: ReleaseRequest, itemKey: string) {
  const item = await env.DB.prepare(
    `SELECT p.account, p.name, p.title, p.due_at, x.item_key AS posted FROM plan_items p
       LEFT JOIN posted x ON x.item_key = p.item_key WHERE p.item_key = ?1 AND p.workspace_id = ?2`,
  )
    .bind(itemKey, req.workspaceId)
    .first<{ account: string; name: string; title: string | null; due_at: number | null; posted: string | null }>();
  if (!item) throw new ReleaseError("missing", "this video's plan item is gone");
  if (item.posted || item.due_at === null) throw new ReleaseError("not_scheduled", "The video is not scheduled");
  if (!(req.at > req.nowS)) throw new ReleaseError("past", "The new release time is not in the future");
  // as plan_update: one item per account per hour
  const taken = await slotTaken(env.DB, item.account, req.at, req.tz, itemKey);
  if (taken) {
    const free = await freeSlots(env.DB, item.account, req.at, req.tz, itemKey);
    throw new ReleaseError(
      "conflict",
      `${slotMessage(item.account, taken, req.tz)}${free.length ? ` (free: ${free.map((f) => `${f.date} ${f.time}`).join(", ")})` : ""}`,
    );
  }
  // who moved it, as the app (owner@app) and plan_update (the key's id) record it; the hold is left as it is
  const by = req.actor.kind === "owner" ? "owner@app" : req.actor.id;
  await env.DB.prepare(
    "UPDATE plan_items SET due_at = ?1, updated_at = ?2, updated_by = ?5 WHERE item_key = ?3 AND workspace_id = ?4",
  )
    .bind(req.at, req.nowS, itemKey, req.workspaceId, by)
    .run();
  return {
    account: item.account,
    title: item.title || (item.name.split("/").pop() ?? item.name),
    from: utcIso(item.due_at),
  };
}

export async function moveRelease(env: Env, fetcher: typeof fetch, req: ReleaseRequest): Promise<ReleaseResult> {
  const { videoId, at, nowS, tz, actor } = req;
  const channels = await youtubeAccounts(env.DB, req.workspaceId);
  const itemKey = (
    await bongsuVideos(
      env.DB,
      channels.map((ch) => ch.id),
      req.workspaceId,
    )
  ).get(videoId);
  const found = itemKey ? null : await findUpload(env, fetcher, req.workspaceId, videoId);
  if (!itemKey && !found) throw new ReleaseError("missing", "no such video in this workspace");
  if (actor.kind === "key" && at - nowS < RELEASE_LEAD_S)
    throw new ReleaseError("lead", "an agent must leave at least 1 hour: pick a later time");
  const to = utcIso(at);
  let account: string;
  let title: string;
  let from: string;
  if (itemKey) {
    ({ account, title, from } = await moveItem(env, req, itemKey));
  } else if (found) {
    const oauth = await connectionSecret(env, found.account.connection);
    if (!oauth) throw new ReleaseError("missing", "the channel has no working connection");
    ({ from } = await new YouTube(oauth, fetcher).setReleaseDate(videoId, to));
    await patchCache(env, found.account.id, videoId, to);
    account = found.account.id;
    title = found.upload.title;
  } else throw new ReleaseError("missing", "no such video in this workspace");

  await env.DB.prepare(
    "INSERT INTO audit (at, actor, action, target, detail, user_id, workspace_id) VALUES (?1, ?2, 'release_move', ?3, ?4, ?5, ?6)",
  )
    .bind(
      nowS,
      actor.kind === "owner" ? `user:${actor.userId ?? "?"}` : `key:${actor.id}`,
      `youtube:${videoId}`,
      JSON.stringify({ account, title, from, to }),
      actor.kind === "owner" ? actor.userId : null,
      req.workspaceId,
    )
    .run();

  const stamp = (s: number) => `${zoneStamp(s, tz)} ${tz}`;
  const fromS = Math.floor(Date.parse(from) / 1000);
  // everyone the notification reaches reads the mover's name, as this workspace names them
  const by =
    actor.kind === "key"
      ? actor.name
      : ((actor.userId ? await memberName(env.DB, actor.userId, req.workspaceId) : null) ?? "someone");
  await notifier(env, fetcher, nowS).send(releaseMoved(title, stamp(fromS), stamp(at), by), req.workspaceId);
  return {
    video: videoId,
    title,
    account,
    due: stamp(at),
    due_at: to,
    from: stamp(fromS),
    from_at: from,
  };
}
