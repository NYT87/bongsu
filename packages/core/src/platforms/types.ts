// What a social network allows, as data (docs/PLAN.md 2.10). The tick, the app, the agent API and the caption check
// read a platform's capabilities instead of checking its name, so a new network is a new file here plus a provider.
import type { Check, LintRules } from "../formats/caption-lint";

/** What a post can be. */
export type Format = "video" | "image" | "carousel" | "story" | "text";

export interface Limits {
  /** Media files in one post (a carousel's slides). */
  mediaMax: number;
  /** Longest video, in seconds. */
  videoSecondsMax: number;
  /** Characters in the caption (the post's text). */
  captionMax: number;
  hashtagsMax?: number;
  /** Characters in one alt text. */
  altMax?: number;
}

export interface Features {
  /** A comment posted by the account right after the post. */
  firstComment: boolean;
  /** A second one after it. */
  secondComment: boolean;
  /** Alt texts on images. */
  altText: boolean;
  /** A place tagged on the post. */
  location: boolean;
  /** A chosen frame of the video as its cover. */
  coverFrame: boolean;
  /** Trial posts shown to non-followers first (Instagram's Trial Reels). */
  trial: boolean;
  /** Reading comments and replying. */
  comments: boolean;
  /** Per-post results (views, likes…). */
  insights: boolean;
  /** Commenting on posts published outside Bongsu (YouTube Shorts comments). */
  commentOnExisting: boolean;
}

/** A platform-specific choice on a post, kept in plan_items.options (validated with validateOptions). */
export interface OptionSpec {
  key: string;
  type: "boolean" | "integer" | "string";
  /** What the app and the agent API show. */
  label: string;
  /** Only for these formats (all when absent). */
  formats?: Format[];
  /** For integers. */
  min?: number;
  max?: number;
  /** For strings. */
  maxLength?: number;
  pattern?: RegExp;
}

export interface Label {
  name: string;
  plural: string;
}

export interface Platform {
  /** The value of accounts.platform. */
  id: string;
  name: string;
  /** What the network calls each format ("Reel", "Short", "Post"); `post` names a post whose media decide. */
  labels: Partial<Record<Format | "post", Label>>;
  /** "account", "channel", "profile"… */
  accountNoun: string;
  /** Formats Bongsu can publish here (empty: it only comments on posts made elsewhere). */
  formats: Format[];
  /** Seconds before the due time that the provider starts work (a YouTube upload); absent: at the due time. */
  uploadLeadS?: number;
  limits: Limits;
  features: Features;
  options: OptionSpec[];
  /** The caption check for this network (FAIL blocks approval), with the rules to apply (its defaults when none). */
  lint(caption: string, rules?: LintRules): Check[];
  /** The caption rules an account starts from; accounts.settings.captionRules overrides fields (accounts.ts). */
  lintDefaults: LintRules;
}

/** The name a post goes by on its platform: its format's label, or the platform's word for a post. */
export function formatLabel(p: Platform | null, format: Format | null | undefined, plural = false): string {
  const l = (format && p?.labels[format]) || p?.labels.post;
  const fallback = format ? format[0].toUpperCase() + format.slice(1) : "Post";
  return l ? (plural ? l.plural : l.name) : plural ? `${fallback}s` : fallback;
}

/** A platform as the app and agents see it (no functions; option patterns as text). */
export function describePlatform(p: Platform) {
  return {
    id: p.id,
    name: p.name,
    accountNoun: p.accountNoun,
    formats: p.formats.map((f) => ({
      format: f,
      ...(p.labels[f] ?? { name: formatLabel(p, f), plural: formatLabel(p, f, true) }),
    })),
    post: p.labels.post ?? { name: "Post", plural: "Posts" },
    limits: p.limits,
    features: p.features,
    options: p.options.map((o) => ({ ...o, pattern: o.pattern?.source })),
  };
}

export const NO_FEATURES: Features = {
  firstComment: false,
  secondComment: false,
  altText: false,
  location: false,
  coverFrame: false,
  trial: false,
  comments: false,
  insights: false,
  commentOnExisting: false,
};

/** The rules of a platform whose `lint` checks nothing (or ignores them): no cap, no fold, no language heuristics. */
export const NO_LINT: LintRules = { hashtagMax: 0, foldChars: 0, languageChecks: false };

export class OptionsError extends Error {}

/** The options a post may carry on this platform and format: unknown keys and bad values are refused; null removes. */
export function validateOptions(p: Platform, format: Format, given: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(given)) {
    const spec = p.options.find((o) => o.key === k);
    if (!spec) throw new OptionsError(`${p.name} has no option ${k}`);
    if (spec.formats && !spec.formats.includes(format)) throw new OptionsError(`${k} doesn't apply to a ${format}`);
    if (v === null || v === undefined) continue;
    if (spec.type === "boolean" && typeof v !== "boolean") throw new OptionsError(`${k} must be true or false`);
    if (spec.type === "integer") {
      if (typeof v !== "number" || !Number.isInteger(v)) throw new OptionsError(`${k} must be a whole number`);
      if ((spec.min !== undefined && v < spec.min) || (spec.max !== undefined && v > spec.max))
        throw new OptionsError(`${k} must be between ${spec.min} and ${spec.max}`);
    }
    if (spec.type === "string") {
      if (typeof v !== "string") throw new OptionsError(`${k} must be text`);
      if (spec.maxLength !== undefined && v.length > spec.maxLength) throw new OptionsError(`${k} is too long`);
      if (spec.pattern && !spec.pattern.test(v)) throw new OptionsError(`${k} isn't valid`);
    }
    out[k] = v;
  }
  return out;
}
