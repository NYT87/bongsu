import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { apiFor, CliError, UsageError } from "../client";
import type { Command, Ctx } from "../ctx";
import { emit } from "../output";

interface Answer {
  posts: { added: number; skipped: number };
  accounts: { added: number; skipped: number };
}

const n = (k: number, one: string) => `${k} ${one}${k === 1 ? "" : "s"}`;

export const ingest: Command = {
  name: "ingest",
  summary: "ingest <file.json | ->                       upload metrics samples collected elsewhere",
  async run(ctx: Ctx, args: string[]) {
    const from = args[0];
    if (!from || args.length > 1) throw new UsageError("ingest takes one file of samples (or - for stdin)");
    let text: string;
    try {
      text = from === "-" ? await ctx.io.readStdin() : await readFile(resolve(ctx.cwd, from), "utf8");
    } catch (e) {
      throw new CliError(`can't read ${from}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new CliError(`${from} isn't JSON: it should be { "posts": [...], "accounts": [...] }`);
    }
    const r = await (await apiFor(ctx)).post<Answer>("/v1/metrics", body);
    emit(
      ctx,
      r,
      () =>
        `${n(r.posts.added, "post sample")} added (${r.posts.skipped} already there), ${n(r.accounts.added, "account sample")} added (${r.accounts.skipped} already there)\n`,
    );
    return 0;
  },
};
