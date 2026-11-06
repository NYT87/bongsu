// What a YouTube video's form sends for its settings (kept apart from App.tsx so it can be tested on its own).
import type { YouTubeSettings } from "./api";

/** The settings that differ from where the form started. A value equal to the channel's default goes as null, so the
 *  post follows the channel again (and a later change to the channel's default reaches it). */
export function changedSettings(
  now: YouTubeSettings,
  start: YouTubeSettings,
  channel: YouTubeSettings,
): { [K in keyof YouTubeSettings]?: YouTubeSettings[K] | null } {
  return Object.fromEntries(
    (Object.keys(now) as (keyof YouTubeSettings)[])
      .filter((k) => now[k] !== start[k])
      .map((k) => [k, now[k] === channel[k] ? null : now[k]]),
  );
}
