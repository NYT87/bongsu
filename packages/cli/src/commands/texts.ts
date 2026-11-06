import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { apiFor, CliError, UsageError } from "../client";
import { type Command, type Ctx, oneKey, parsed } from "../ctx";
import { emit } from "../output";

const FIELDS = ["caption", "comment", "comment2", "alt"] as const;
type Field = (typeof FIELDS)[number];

interface TextItem {
  key: string;
  caption: string | null;
  comment: string | null;
  comment2: string | null;
  alt?: string[] | null;
  /** A YouTube video's title and translations; null for an Instagram item. */
  texts?: YouTubeTexts | null;
}

interface Translation {
  title: string;
  description: string;
}
interface YouTubeTexts {
  title: string;
  translations?: Record<string, Translation>;
  tags?: string[];
}

// The CLI doesn't import core, so this mirrors core's LANG loosely; the API has the last word.
const LANG = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

const path = (key: string) => `/v1/items/${encodeURIComponent(key)}`;

async function get(ctx: Ctx, args: string[]): Promise<number> {
  const { positionals } = parsed(() => parseArgs({ args, allowPositionals: true }));
  const key = oneKey(positionals, "texts get");
  const it = await (await apiFor(ctx)).get<TextItem>(path(key));
  const shown = (f: Field) => (f === "alt" ? (it.alt?.length ? it.alt.join("\n") : "") : it[f]) || "(none)";
  emit(ctx, it, () => (it.texts ? youtubeText(it.texts) : FIELDS.map((f) => `== ${f}\n${shown(f)}\n`).join("\n")));
  return 0;
}

function youtubeText(t: YouTubeTexts): string {
  const parts = [`== title\n${t.title || "(none)"}\n`];
  for (const [lang, tr] of Object.entries(t.translations ?? {})) {
    parts.push(`== translation ${lang}\n${tr.title}\n\n${tr.description}\n`);
  }
  return parts.join("\n");
}

/** A file path, or `-` for stdin. */
async function source(ctx: Ctx, from: string, stdinUsed: boolean): Promise<string> {
  if (from === "-") {
    if (stdinUsed) throw new CliError("stdin can be used once");
    return ctx.io.readStdin();
  }
  try {
    return await readFile(resolve(ctx.cwd, from), "utf8");
  } catch (e) {
    throw new CliError(`can't read ${from}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
  }
}

async function set(ctx: Ctx, args: string[]): Promise<number> {
  const { values, positionals, tokens } = parsed(() =>
    parseArgs({
      args,
      allowPositionals: true,
      tokens: true,
      options: {
        caption: { type: "string" },
        comment: { type: "string" },
        comment2: { type: "string" },
        alt: { type: "string" },
        title: { type: "string", multiple: true },
        translation: { type: "string", multiple: true },
        description: { type: "string", multiple: true },
      },
    }),
  );
  const key = oneKey(positionals, "texts set");
  const given = FIELDS.filter((f) => values[f] !== undefined);

  // --title and --description after a --translation belong to it, until the next --translation.
  let title: string | undefined;
  const translations: { lang: string; title?: string; description?: string }[] = [];
  for (const t of tokens) {
    if (t.kind !== "option") continue;
    const last = translations[translations.length - 1];
    if (t.name === "translation") translations.push({ lang: t.value as string });
    else if (t.name === "title") {
      if (last) last.title = t.value as string;
      else title = t.value as string;
    } else if (t.name === "description") {
      if (!last) throw new UsageError("--description belongs to a --translation <lang>");
      last.description = t.value as string;
    }
  }
  for (const tr of translations) {
    if (!LANG.test(tr.lang)) throw new UsageError(`"${tr.lang}" is not a language tag (like es or pt-BR)`);
    if (tr.title === undefined || tr.description === undefined) {
      throw new UsageError(`translation ${tr.lang} needs both a --title and a --description`);
    }
  }
  if (!given.length && title === undefined && !translations.length) {
    throw new CliError("give at least one of --caption, --comment, --comment2, --alt, --title, --translation");
  }

  const body: { key: string; texts?: YouTubeTexts } & Partial<Record<Field, string>> = { key };
  let stdinUsed = false;
  for (const f of given) {
    const from = values[f] as string;
    body[f] = await source(ctx, from, stdinUsed);
    if (from === "-") stdinUsed = true;
  }
  const api = await apiFor(ctx);
  const changed: string[] = [...given];
  if (title !== undefined || translations.length) {
    // plan_update replaces the texts whole, so start from what is there.
    const current = (await api.get<TextItem>(path(key))).texts ?? { title: "" };
    const merged: YouTubeTexts = { ...current };
    if (title !== undefined) {
      merged.title = title;
      changed.push("title");
    }
    for (const tr of translations) {
      const description = await source(ctx, tr.description as string, stdinUsed);
      if (tr.description === "-") stdinUsed = true;
      merged.translations = { ...merged.translations, [tr.lang]: { title: tr.title as string, description } };
      changed.push(`translation ${tr.lang}`);
    }
    body.texts = merged;
  }
  const it = await api.post<TextItem>("/v1/plan/update", body);
  emit(ctx, it, () => `updated ${changed.join(", ")} of ${key}\n`);
  return 0;
}

export const texts: Command = {
  name: "texts",
  summary:
    "texts get <key> | set <key> [--caption f] [--comment f] [--comment2 f] [--alt f] [--title t] [--translation lang --title t --description f]   read or set texts (- is stdin)",
  async run(ctx: Ctx, args: string[]) {
    const [sub, ...rest] = args;
    if (sub === "get") return get(ctx, rest);
    if (sub === "set") return set(ctx, rest);
    throw new UsageError("texts needs get or set");
  },
};
