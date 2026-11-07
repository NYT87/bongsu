// What a YouTube video's form sends for its settings (kept apart from App.tsx so it can be tested on its own).
import { LANG, tagsLength } from "@bongsu/core/formats/youtube-texts";
import type { YouTubeSettings, YouTubeTexts } from "./api";

export const YT_TITLE_MAX = 100;
export const YT_DESCRIPTION_MAX = 5000;
export const YT_TAGS_MAX = 500;

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

/** What stops the form saving (the server would refuse it); an empty title only stops approving. Translations need
 *  the video's own language (checkTexts' LANGUAGE_NEEDED; the form shows yt.languageNeeded). */
export function ytBlocked(x: YouTubeTexts): boolean {
  const bad = (c?: string) => !!c && !LANG.test(c.trim());
  const translations = Object.values(x.translations ?? {});
  return (
    x.title.length > YT_TITLE_MAX ||
    (translations.length > 0 && !x.language?.trim()) ||
    bad(x.language) ||
    bad(x.audioLanguage) ||
    tagsLength(x.tags ?? []) > YT_TAGS_MAX ||
    translations.some(
      (tr) => !tr.title.trim() || tr.title.length > YT_TITLE_MAX || tr.description.length > YT_DESCRIPTION_MAX,
    )
  );
}
