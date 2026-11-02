// Instagram's caption rules (platforms/instagram.ts uses them as its Platform.lint), ported from the shorts-check skill (.claude/skills/shorts-check/caption.py, lint_ig) so
// the app can show it before approving. Same checks, limits and wording; a FAIL blocks
// approval in the app as it does in the CLI's `bongsu approve`. Keep the two in step when one changes.

export interface Check {
  check: string;
  status: "PASS" | "WARN" | "FAIL";
  detail: string;
}

/** What an owner can tune per account (accounts.settings.captionRules); the platform gives the defaults. */
export interface LintRules {
  /** The hashtag cap: more is a FAIL. */
  hashtagMax: number;
  /** Where the feed cuts the caption to "… more": the first line, the hook and tag placement are judged against it. */
  foldChars: number;
  /** The checks that read the caption's language (a concrete hook, one call to action): off for captions the
   *  heuristics don't fit. */
  languageChecks: boolean;
}

const IG_LIMIT = 2200; // Instagram caption hard limit
const IG_MENTIONS = 20; // @-mention cap per caption
/** Instagram's defaults: the fold at about 125 characters, the hashtag cap of 5 since 18 Dec 2025. */
export const IG_RULES: LintRules = { hashtagMax: 5, foldChars: 125, languageChecks: true };

// Python's \w is Unicode; here letters, marks, digits and _ (so Korean and Spanish tags count).
const W = "[\\p{L}\\p{M}\\p{N}_]";
const HASHTAG_RE = new RegExp(`(?:^|(?<=\\s))#(${W}+)`, "gu");
const MENTION_RE = new RegExp(`(?:^|(?<=\\s))@((?:${W}|\\.)+)`, "gu");
const LINK_RE = /https?:\/\/\S+|\bwww\.\S+|\b[a-z0-9-]+\.(?:com|co|io|net|org|ai|app|be)\/\S*/gi;
// biome-ignore lint/suspicious/noMisleadingCharacterClass: the variation selector is matched on its own, as in the Python lint this mirrors
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}☀-➿←-⇿️]/gu;
const CONCRETE_RE = /\d|(?<!^)\b[A-ZÁÉÍÓÚÑÜ][a-záéíóúñü]{2,}/gmu;
const INVISIBLE_RE = /[​-‏⁠-⁤﻿­‪-‮]/gu;

const ASKS: [RegExp, string][] = [
  [/\bcomment\b|\bcomenta\b|댓글/iu, "comment"],
  [/\b(?:dm|message) me\b|\bescríbeme|\bmd\b|디엠/iu, "DM"],
  [/\bsave (?:this|it)\b|\bguárda(?:lo|la|te)?|저장/iu, "save"],
  [/\bshare (?:this|it)\b|\bcompárte(?:lo|la)?|공유/iu, "share"],
  // "follow" only as a call to action: "follow the blue line" is a description, not an ask.
  [/\bfollow (?:me|us|for|along|@)|\bsígueme|\bsubscribe\b|\bsuscríbete|팔로우|구독/iu, "follow/subscribe"],
  [/\blink in (?:my )?bio\b|\blink en (?:la |mi )?bio\b|프로필 링크/iu, "link in bio"],
  [/\bwhat would you\b|\bwhich (?:one|would)\b|\btell me\b|\bdime\b|어떤|알려주|\?/iu, "question"],
];
const FILLER_TAGS = new Set([
  "viral",
  "fyp",
  "explore",
  "explorepage",
  "foryou",
  "foryoupage",
  "trending",
  "instagood",
  "love",
  "follow",
  "like4like",
  "reels",
  "reelsinstagram",
  "viralreels",
  "instadaily",
]);

const all = (re: RegExp, s: string) => [...s.matchAll(re)];
/** Lengths in characters (code points), as Python counts them: an emoji is one, not two UTF-16 units. */
const len = (s: string) => [...s].length;

export function lintCaption(raw: string, rules: LintRules = IG_RULES): Check[] {
  const { hashtagMax: IG_HASHTAGS, foldChars: IG_FOLD } = rules;
  const text = raw.trim();
  const checks: Check[] = [];
  const add = (check: string, status: Check["status"], detail: string) => checks.push({ check, status, detail });
  const first = text.split("\n", 1)[0].trim();
  const tags = all(HASHTAG_RE, text).map((m) => m[1]);
  const mentions = all(MENTION_RE, text);
  const links = all(LINK_RE, text);
  const window = [...text].slice(0, IG_FOLD).join("");
  const asks = ASKS.filter(([re]) => re.test(text)).map(([, name]) => name);

  add("LENGTH", len(text) > IG_LIMIT ? "FAIL" : "PASS", `${len(text)} / ${IG_LIMIT} characters`);
  if (!first) add("FIRST LINE", "FAIL", "opens on a blank line");
  else if ("#@".includes(first[0]))
    add("FIRST LINE", "FAIL", "opens on a hashtag/mention — the one spot worth a sentence");
  else if (len(first) > IG_FOLD) add("FIRST LINE", "WARN", `${len(first)} chars, cut at ${IG_FOLD} mid-thought`);
  else add("FIRST LINE", "PASS", `${len(first)} chars, lands whole`);
  const nConc = all(CONCRETE_RE, window).length;
  if (rules.languageChecks)
    add(
      "CONCRETE HOOK",
      nConc ? "PASS" : "WARN",
      nConc
        ? `${nConc} number(s)/name(s) before the fold`
        : "no number or name before the fold (check by eye for Korean, which has no capitals)",
    );
  const filler = tags.filter((t) => FILLER_TAGS.has(t.toLowerCase()));
  if (tags.length > IG_HASHTAGS) add("HASHTAGS", "FAIL", `${tags.length} tags, over Instagram's cap of ${IG_HASHTAGS}`);
  else if (filler.length)
    add("HASHTAGS", "WARN", `${tags.length} tags, generic: ${filler.map((t) => `#${t}`).join(" ")}`);
  else add("HASHTAGS", "PASS", tags.length ? `${tags.length} tag(s): ${tags.map((t) => `#${t}`).join(" ")}` : "none");
  if (tags.some((t) => window.includes(`#${t}`)))
    add("TAG PLACEMENT", "WARN", "a hashtag sits before the fold, spending feed space on a label");
  add("MENTIONS", mentions.length > IG_MENTIONS ? "FAIL" : "PASS", `${mentions.length} @mention(s)`);
  add(
    "LINKS",
    links.length ? "WARN" : "PASS",
    links.length ? `${links.length} link(s) — captions aren't clickable; use the bio` : "none",
  );
  if (!rules.languageChecks) {
    // the ask heuristics are English/Spanish/Korean: skipped when the owner turns the language checks off
  } else if (asks.length === 1) add("ONE ASK", "PASS", `call to action: ${asks[0]}`);
  else add("ONE ASK", "WARN", asks.length ? `${asks.length} asks (${asks.join(", ")})` : "no call to action");
  const emoji = all(EMOJI_RE, text).length;
  const density = (emoji * 100) / Math.max(len(text), 1);
  add("EMOJI", density > 4 ? "WARN" : "PASS", `${emoji} emoji, ${density.toFixed(1)}/100 chars`);
  const invisible = [...new Set(all(INVISIBLE_RE, text).map((m) => m[0]))];
  if (invisible.length) {
    add(
      "INVISIBLE",
      "FAIL",
      `${all(INVISIBLE_RE, text).length} zero-width/format character(s): ` +
        invisible
          .sort()
          .map((c) => `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`)
          .join(" ") +
        " — strip them",
    );
  }
  return checks;
}
