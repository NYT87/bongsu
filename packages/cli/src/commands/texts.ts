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
}

const path = (key: string) => `/v1/items/${encodeURIComponent(key)}`;

async function get(ctx: Ctx, args: string[]): Promise<number> {
  const { positionals } = parsed(() => parseArgs({ args, allowPositionals: true }));
  const key = oneKey(positionals, "texts get");
  const it = await (await apiFor(ctx)).get<TextItem>(path(key));
  const shown = (f: Field) => (f === "alt" ? (it.alt?.length ? it.alt.join("\n") : "") : it[f]) || "(none)";
  emit(ctx, it, () => FIELDS.map((f) => `== ${f}\n${shown(f)}\n`).join("\n"));
  return 0;
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
  const { values, positionals } = parsed(() =>
    parseArgs({
      args,
      allowPositionals: true,
      options: Object.fromEntries(FIELDS.map((f) => [f, { type: "string" as const }])),
    }),
  );
  const key = oneKey(positionals, "texts set");
  const given = FIELDS.filter((f) => values[f] !== undefined);
  if (!given.length) throw new CliError("give at least one of --caption, --comment, --comment2, --alt");
  const body: { key: string } & Partial<Record<Field, string>> = { key };
  let stdinUsed = false;
  for (const f of given) {
    const from = values[f] as string;
    body[f] = await source(ctx, from, stdinUsed);
    if (from === "-") stdinUsed = true;
  }
  const it = await (await apiFor(ctx)).post<TextItem>("/v1/plan/update", body);
  emit(ctx, it, () => `updated ${given.join(", ")} of ${key}\n`);
  return 0;
}

export const texts: Command = {
  name: "texts",
  summary:
    "texts get <key> | set <key> [--caption f] [--comment f] [--comment2 f] [--alt f]   read or set texts (- is stdin)",
  async run(ctx: Ctx, args: string[]) {
    const [sub, ...rest] = args;
    if (sub === "get") return get(ctx, rest);
    if (sub === "set") return set(ctx, rest);
    throw new UsageError("texts needs get or set");
  },
};
