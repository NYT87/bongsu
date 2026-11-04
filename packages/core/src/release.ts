// Moving the release date of a scheduled YouTube video: by the owner, or by an agent key the owner opted in.
import { connectionSecret } from "./accounts";
import { findUpload } from "./calendar";
import { ReleaseError, type Upload, YouTube } from "./clients/youtube";
import { RELEASE_LEAD_S } from "./constants";
import type { Env } from "./env";
import { utcIso, zoneStamp } from "./formats/time";
import { notifier } from "./notify";
import { releaseMoved } from "./texts/notifications";

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

export async function moveRelease(env: Env, fetcher: typeof fetch, req: ReleaseRequest): Promise<ReleaseResult> {
  const { videoId, at, nowS, tz, actor } = req;
  const found = await findUpload(env, fetcher, req.workspaceId, videoId);
  if (!found) throw new ReleaseError("missing", "no such video in this workspace");
  if (actor.kind === "key" && at - nowS < RELEASE_LEAD_S)
    throw new ReleaseError("lead", "an agent must leave at least 1 hour: pick a later time");
  const { account, upload } = found;
  const oauth = await connectionSecret(env, account.connection);
  if (!oauth) throw new ReleaseError("missing", "the channel has no working connection");
  const to = utcIso(at);
  const { from } = await new YouTube(oauth, fetcher).setReleaseDate(videoId, to);
  await patchCache(env, account.id, videoId, to);

  await env.DB.prepare(
    "INSERT INTO audit (at, actor, action, target, detail, user_id, workspace_id) VALUES (?1, ?2, 'release_move', ?3, ?4, ?5, ?6)",
  )
    .bind(
      nowS,
      actor.kind === "owner" ? `user:${actor.userId ?? "?"}` : `key:${actor.id}`,
      `youtube:${videoId}`,
      JSON.stringify({ account: account.id, title: upload.title, from, to }),
      actor.kind === "owner" ? actor.userId : null,
      req.workspaceId,
    )
    .run();

  const stamp = (s: number) => `${zoneStamp(s, tz)} ${tz}`;
  const fromS = Math.floor(Date.parse(from) / 1000);
  const by = actor.kind === "owner" ? "you" : actor.name;
  await notifier(env, fetcher, nowS).send(releaseMoved(upload.title, stamp(fromS), stamp(at), by), req.workspaceId);
  return {
    video: videoId,
    title: upload.title,
    account: account.id,
    due: stamp(at),
    due_at: to,
    from: stamp(fromS),
    from_at: from,
  };
}
