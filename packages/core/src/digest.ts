// The daily digest: once a day from the workspace's digest hour (its own time zone), in the inbox's cron run, one
// notification (push + ntfy) with today's items and their status, what still needs approval in the next 3 days,
// and the jobs that failed or were refused since yesterday. settings.digest_last holds the last day sent.
import { type CalEvent, calendar } from "./calendar";
import { pausedState } from "./data";
import type { Env } from "./env";
import { shiftDate, zoneDate, zoneHour } from "./formats/time";
import { notifier } from "./notify";
import { platform } from "./platforms/index";
import { digest as digestNote } from "./texts/notifications";
import { type WorkspaceSettings, workspaceSettings } from "./workspaces";

const AHEAD_DAYS = 3;
const NEEDS = new Set(["not approved", "re-approve"]);
const line = (e: CalEvent) =>
  `${e.time ?? "--:--"} ${e.label}${e.account_name ? ` ${e.account_name}` : ""} ${e.title}${!e.account_name && e.account ? ` @${e.account}` : ""}: ${e.status}`;

/** The digest's title and text for a workspace's day (exported for the tests and a future "send now"). */
export async function buildDigest(
  env: Env,
  fetcher: typeof fetch,
  now: Date,
  ws: Pick<WorkspaceSettings, "workspaceId" | "timezone">,
): Promise<{ title: string; text: string }> {
  const today = zoneDate(now, ws.timezone);
  const until = shiftDate(today, AHEAD_DAYS);
  const { events } = await calendar(env, fetcher, { id: ws.workspaceId, tz: ws.timezone }, today, until);
  const todays = events.filter((e) => e.date === today).sort((a, b) => (a.time ?? "").localeCompare(b.time ?? ""));
  const needs = events
    .filter((e) => NEEDS.has(e.status))
    .sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
  const failed = await env.DB.prepare(
    "SELECT item_key, state, last_error FROM jobs WHERE workspace_id = ?2 AND state IN ('failed', 'refused') AND updated_at >= ?1 ORDER BY updated_at",
  )
    .bind(Math.floor(now.getTime() / 1000) - 86400, ws.workspaceId)
    .all<{ item_key: string; state: string; last_error: string | null }>();

  // "Today: 1 Instagram, 2 YouTube": counted per platform, in the order they come
  const counts = new Map<string, number>();
  for (const e of todays) counts.set(e.platform, (counts.get(e.platform) ?? 0) + 1);
  const title = todays.length
    ? `Today: ${[...counts].map(([p, n]) => `${n} ${platform(p)?.name ?? p}`).join(", ")}`
    : "Today: nothing planned";
  const parts = [todays.length ? todays.map(line).join("\n") : "Nothing planned today."];
  // the plan reads as usual while paused, but nothing of it goes out: say so first
  const paused = await pausedState(env.DB, ws.workspaceId);
  if (paused) parts.unshift(`Publishing is paused (${paused.reason}): nothing goes out until it's resumed.`);
  if (needs.length)
    parts.push(`Needs approval (${needs.length}):\n${needs.map((e) => `${e.date.slice(5)} ${line(e)}`).join("\n")}`);
  if (failed.results.length)
    parts.push(
      `Failed/refused since yesterday:\n${failed.results.map((j) => `${j.item_key}: ${j.state}${j.last_error ? ` (${j.last_error.slice(0, 80)})` : ""}`).join("\n")}`,
    );
  return { title, text: parts.join("\n\n") };
}

/** Sends each workspace's digest once per day (in its time zone), from its digest hour on. An archived workspace
 *  gets none. */
export async function dailyDigest(
  env: Env,
  deps: { fetch: typeof fetch; now: Date },
): Promise<"sent" | "not yet" | "already sent"> {
  const ids = await env.DB.prepare(
    `SELECT s.workspace_id FROM workspace_settings s JOIN workspaces w ON w.id = s.workspace_id
     WHERE w.archived_at IS NULL ORDER BY s.workspace_id`,
  ).all<{ workspace_id: string }>();
  const outcomes: string[] = [];
  for (const { workspace_id } of ids.results) {
    const ws = await workspaceSettings(env.DB, workspace_id);
    if (zoneHour(deps.now, ws.timezone) < ws.digestHour) {
      outcomes.push("not yet");
      continue;
    }
    const today = zoneDate(deps.now, ws.timezone);
    const key = workspace_id === "default" ? "digest_last" : `digest_last:${workspace_id}`;
    const claimed = await env.DB.prepare(
      "INSERT INTO settings (key, value) VALUES (?2, ?1) ON CONFLICT (key) DO UPDATE SET value = ?1 WHERE settings.value < ?1 RETURNING key",
    )
      .bind(today, key)
      .first();
    if (!claimed) {
      outcomes.push("already sent");
      continue;
    }
    const { title, text } = await buildDigest(env, deps.fetch, deps.now, ws);
    await notifier(env, deps.fetch, Math.floor(deps.now.getTime() / 1000)).send(digestNote(title, text), workspace_id);
    outcomes.push("sent");
  }
  return outcomes.includes("sent") ? "sent" : outcomes.includes("already sent") ? "already sent" : "not yet";
}
