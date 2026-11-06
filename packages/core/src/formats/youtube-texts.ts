// A YouTube video's own texts (title, languages, tags, translations), checked on every write. Approval hashes them
// (textsSha) and the provider sends them, so what is stored is already normalised: LF line ends, trimmed, no blanks.
import type { Platform } from "../platforms/types";
import { TextsError } from "./texts";

export interface Translation {
  title: string;
  description: string;
}

export interface YouTubeTexts {
  title: string;
  language?: string;
  audioLanguage?: string;
  tags?: string[];
  translations?: Record<string, Translation>;
}

export const LANG = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const TITLE_MAX = 100;
const DESCRIPTION_MAX = 5000;
const TAGS_MAX = 500;
const FIELDS = ["title", "language", "audioLanguage", "tags", "translations"];

/** Characters of a tag set as YouTube counts them: a tag with a space counts in quotes, and one separator sits
 *  between tags. */
export function tagsLength(tags: string[]): number {
  return tags.reduce((n, t) => n + t.length + (t.includes(" ") ? 2 : 0), 0) + Math.max(0, tags.length - 1);
}

const clean = (s: string): string => s.replace(/\r\n?/g, "\n").trim();

function text(v: unknown, field: string): string {
  if (typeof v !== "string") throw new TextsError(`${field}: must be text`);
  return clean(v);
}

function noBrackets(s: string, field: string): void {
  if (/[<>]/.test(s)) throw new TextsError(`${field}: no < or > (YouTube refuses them)`);
}

function lang(v: unknown, field: string): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string" || !LANG.test(v)) throw new TextsError(`${field}: not a language tag (like en or pt-BR)`);
  return v;
}

function translation(v: unknown, code: string): Translation {
  const at = `translations.${code}`;
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new TextsError(`${at}: needs a title and a description`);
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o))
    if (k !== "title" && k !== "description") throw new TextsError(`${at}: unknown field ${k}`);
  const title = text(o.title, `${at}.title`);
  const description = o.description === undefined ? "" : text(o.description, `${at}.description`);
  if (title.length < 1 || title.length > TITLE_MAX) throw new TextsError(`${at}.title: 1–${TITLE_MAX} characters`);
  if (description.length > DESCRIPTION_MAX)
    throw new TextsError(`${at}.description: at most ${DESCRIPTION_MAX} characters`);
  noBrackets(title, `${at}.title`);
  noBrackets(description, `${at}.description`);
  return { title, description };
}

/** Checks and normalises a video's texts. null/undefined mean none. An empty title is allowed while editing (approval
 *  asks for one); throws TextsError on anything else wrong. */
export function checkTexts(p: Platform, raw: unknown): YouTubeTexts | null {
  if (raw === null || raw === undefined) return null;
  if (p.id !== "youtube") throw new TextsError(`${p.name} posts have no title or translations`);
  if (typeof raw !== "object" || Array.isArray(raw)) throw new TextsError("texts must be an object");
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!FIELDS.includes(k)) throw new TextsError(`unknown field ${k}`);

  const title = text(o.title ?? "", "title");
  if (title.length > TITLE_MAX) throw new TextsError(`title: at most ${TITLE_MAX} characters`);
  noBrackets(title, "title");
  const out: YouTubeTexts = { title };

  const language = lang(o.language, "language");
  if (language) out.language = language;
  const audioLanguage = lang(o.audioLanguage, "audioLanguage");
  if (audioLanguage) out.audioLanguage = audioLanguage;

  if (o.tags !== undefined && o.tags !== null) {
    if (!Array.isArray(o.tags)) throw new TextsError("tags: must be a list");
    const tags = o.tags.map((t) => text(t, "tags")).filter(Boolean);
    for (const t of tags) noBrackets(t, "tags");
    if (tagsLength(tags) > TAGS_MAX)
      throw new TextsError(`tags: at most ${TAGS_MAX} characters as YouTube counts them`);
    if (tags.length) out.tags = tags;
  }

  if (o.translations !== undefined && o.translations !== null) {
    if (typeof o.translations !== "object" || Array.isArray(o.translations))
      throw new TextsError("translations: must be an object keyed by language");
    const translations: Record<string, Translation> = {};
    for (const [code, v] of Object.entries(o.translations)) {
      if (!LANG.test(code)) throw new TextsError(`translations.${code}: not a language tag (like es or pt-BR)`);
      if (code === language) throw new TextsError(`translations.${code}: that is the video's own language`);
      translations[code] = translation(v, code);
    }
    if (Object.keys(translations).length) out.translations = translations;
  }
  return out;
}

/** Stored JSON (plan_items.texts, drafts.texts) back to an object; null when absent or unreadable. */
export function parseTexts(json: string | null | undefined): YouTubeTexts | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json);
    return v && typeof v === "object" ? (v as YouTubeTexts) : null;
  } catch {
    return null;
  }
}
