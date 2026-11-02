// The app's calendar: Instagram plan items and what was posted, from the database, plus the YouTube accounts' uploads
// (published or scheduled), read with each account's connection and cached for an hour.
import { type Account, connectionSecret, listAccounts, youtubeAccounts } from "./accounts";
import { type Upload, YouTube } from "./clients/youtube";
import { approvalState, latestApprovals } from "./data";
import type { Env } from "./env";
import { shiftDate, utcIso, zoneDate, zoneStamp, zoneToUnix } from "./formats/time";
import { platform } from "./platforms/index";
import { type Format, formatLabel } from "./platforms/types";

export interface CalEvent {
  date: string; // YYYY-MM-DD in the viewer's zone
  time: string | null; // HH:MM in the viewer's zone
  at: string; // the instant, ISO 8601 UTC
  /** The account's platform and the post's format (null: decided by its media); `label` is what the platform calls
   *  it ("Reel", "Short"…). */
  platform: string;
  format: Format | null;
  label: string;
  title: string;
  status: string; // posted | approved | not approved | re-approve | hold | public | scheduled | private
  key?: string; // plan item (opens in the app)
  url?: string; // permalink / YouTube link
  /** The account's id (Instagram: the username). */
  account?: string;
  /** The account's display name (YouTube events). */
  account_name?: string;
  posted_at?: string; // "YYYY-MM-DD HH:MM" in the viewer's zone
}

/** How long a channel's cached uploads list stays fresh. */
export const YT_TTL_S = 3600;

/** A channel's recent uploads: the cached list (an hour) unless `refresh`. */
export async function channelUploads(
  env: Env,
  fetcher: typeof fetch,
  channel: Account,
  refresh = false,
  now = Math.floor(Date.now() / 1000),
): Promise<Upload[]> {
  const k = `yt_uploads:${channel.id}`;
  if (!refresh) {
    const row = await env.DB.prepare("SELECT value, updated_at FROM settings WHERE key = ?1")
      .bind(k)
      .first<{ value: string; updated_at: number }>();
    if (row && now - row.updated_at < YT_TTL_S) return JSON.parse(row.value) as Upload[];
  }
  const oauth = await connectionSecret(env, channel.connection);
  if (!oauth) throw new Error("no working connection");
  const items = await new YouTube(oauth, fetcher).uploads(50);
  await env.DB.prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  )
    .bind(k, JSON.stringify(items), now)
    .run();
  return items;
}

/** The channel and upload for a video id in a workspace: cached lists first, one refresh of each channel only when
 *  none has it (a video uploaded since the cache was read). */
export async function findUpload(
  env: Env,
  fetcher: typeof fetch,
  workspaceId: string,
  videoId: string,
): Promise<{ account: Account; upload: Upload } | null> {
  const channels = await youtubeAccounts(env.DB, workspaceId);
  for (const refresh of [false, true]) {
    for (const account of channels) {
      try {
        const upload = (await channelUploads(env, fetcher, account, refresh)).find((u) => u.id === videoId);
        if (upload) return { account, upload };
      } catch {
        // a channel that can't be read doesn't hide the others
      }
    }
  }
  return null;
}

const zoned = (unix: number, tz: string) => {
  const s = zoneStamp(unix, tz);
  return { date: s.slice(0, 10), time: s.slice(11, 16), at: utcIso(unix) };
};

/** A workspace's events between two dates (inclusive) on the viewer's clock, `ws.tz`. */
export async function calendar(
  env: Env,
  fetcher: typeof fetch,
  ws: { id: string; tz: string },
  from: string,
  to: string,
  refresh = false,
): Promise<{ events: CalEvent[]; warnings: string[] }> {
  const tz = ws.tz;
  const events: CalEvent[] = [];
  const warnings: string[] = [];
  const start = zoneToUnix(from, "00:00", tz) ?? 0;
  const end = (zoneToUnix(shiftDate(to, 1), "00:00", tz) ?? 0) - 1;
  const plan = await env.DB.prepare(
    `SELECT p.*, x.permalink, x.published_at AS posted_unix FROM plan_items p LEFT JOIN posted x ON x.item_key = p.item_key
     WHERE p.workspace_id = ?3 AND ((p.due_at BETWEEN ?1 AND ?2) OR (x.published_at BETWEEN ?1 AND ?2))`,
  )
    .bind(start, end, ws.id)
    .all<{
      item_key: string;
      account: string;
      name: string;
      folder: string;
      due_at: number | null;
      hold: number;
      permalink: string | null;
      posted_unix: number | null;
      title: string | null;
      format: string | null;
    }>();
  const approvals = await latestApprovals(
    env.DB,
    plan.results.map((p) => p.item_key),
  );
  const platformOf = new Map(
    (await listAccounts(env.DB, { workspaceId: ws.id, all: true })).map((a) => [a.id, a.platform]),
  );
  for (const p of plan.results) {
    const at = p.posted_unix ?? p.due_at;
    if (at === null) continue;
    let status: string;
    if (p.posted_unix !== null) status = "posted";
    else if (p.hold) status = "hold";
    else status = approvalState(approvals.get(p.item_key), p.due_at);
    const posted = p.posted_unix !== null ? zoneStamp(p.posted_unix, tz) : undefined;
    events.push({
      ...zoned(at, tz),
      platform: platformOf.get(p.account) ?? "unknown",
      format: (p.format as Format | null) ?? null,
      label: formatLabel(platform(platformOf.get(p.account) ?? ""), (p.format as Format | null) ?? null),
      title: p.title || (p.name.split("/").pop() ?? p.name),
      status,
      key: p.item_key,
      url: p.permalink ?? undefined,
      account: p.account,
      posted_at: posted,
    });
  }
  for (const ch of await youtubeAccounts(env.DB, ws.id)) {
    try {
      for (const u of await channelUploads(env, fetcher, ch, refresh)) {
        if (!u.when) continue;
        const z = zoned(Math.floor(Date.parse(u.when) / 1000), tz);
        if (z.date < from || z.date > to) continue;
        events.push({
          ...z,
          platform: "youtube",
          format: "video",
          label: u.short ? "Short" : "Video",
          account: ch.id,
          account_name: ch.displayName ?? ch.handle,
          title: `${u.short ? "Short · " : ""}${u.title}`,
          status: u.privacy === "public" ? "public" : u.privacy === "private" ? "scheduled" : u.privacy,
          url: `https://youtu.be/${u.id}`,
        });
      }
    } catch (e) {
      warnings.push(`YouTube ${ch.displayName ?? ch.handle}: ${(e as Error).message}`);
    }
  }
  events.sort((a, b) => a.at.localeCompare(b.at));
  return { events, warnings };
}

export const today = (tz: string) => zoneDate(new Date(), tz);
