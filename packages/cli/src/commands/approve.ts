import { parseArgs } from "node:util";
import { type Api, apiFor, CliError } from "../client";
import { type Command, type Ctx, oneKey, parsed } from "../ctx";
import { emit } from "../output";

interface Summary {
  key: string;
  account: string;
  due: string | null;
  caption: string | null;
  comment: string | null;
  comment2: string | null;
  alt: string | null;
  media: { name: string; checksum: string; mime: string }[];
  lint: { check: string; status: string; detail: string }[];
  /** Relayed as it came: the API checks it, the CLI never reads it. */
  snapshot: unknown;
}

const path = (key: string) => `/v1/approve/${encodeURIComponent(key)}`;

/** What the owner is about to approve, as the app shows it: texts, media and the checks that didn't pass. */
function describe(s: Summary): string {
  const lines = [`${s.key}`, `account  ${s.account}`, `due      ${s.due ?? "(not scheduled)"}`];
  for (const f of ["caption", "comment", "comment2", "alt"] as const) if (s[f]) lines.push("", `${f}:`, s[f]);
  if (s.media.length) lines.push("", "media:", ...s.media.map((m) => `  ${m.name}  ${m.checksum}`));
  const warnings = s.lint.filter((l) => l.status !== "PASS");
  if (warnings.length) lines.push("", "lint:", ...warnings.map((l) => `  ${l.status}  ${l.check}: ${l.detail}`));
  return `${lines.join("\n")}\n\n`;
}

/** A refusal from the API is shown with what it says is wrong, so the owner knows what to fix. */
function refusal(e: unknown): unknown {
  if (!(e instanceof CliError) || e.status !== 409) return e;
  const problems = e.extra?.problems;
  if (!Array.isArray(problems) || !problems.length) return e;
  const list = problems.map((p) => `  - ${typeof p === "string" ? p : JSON.stringify(p)}`).join("\n");
  return new CliError(`${e.message}\n${list}`, e.status, e.extra);
}

async function load(api: Api, key: string): Promise<Summary> {
  try {
    return await api.get<Summary>(path(key));
  } catch (e) {
    throw refusal(e);
  }
}

export const approve: Command = {
  name: "approve",
  summary: "approve <key> [--yes]                         approve an item or a Shorts comment (comment:<video id>)",
  async run(ctx: Ctx, args: string[]) {
    const { values, positionals } = parsed(() =>
      parseArgs({ args, allowPositionals: true, options: { yes: { type: "boolean" } } }),
    );
    const key = oneKey(positionals, "approve");
    if (!values.yes && !ctx.io.isTTY) throw new CliError("not a terminal: add --yes to approve without the prompt");
    const api = await apiFor(ctx);
    const s = await load(api, key);
    // With --json stdout is the machine answer, but the owner must still see what they approve.
    (ctx.json ? ctx.io.err : ctx.io.out)(describe(s));
    if (!values.yes) {
      const answer = (await ctx.io.ask("approve? [y/N] ")).trim().toLowerCase();
      if (answer !== "y" && answer !== "yes") throw new CliError("not approved");
    }
    const done = await api.post<{ approved: true; key: string; due: string }>("/v1/approve", {
      key: s.key,
      snapshot: s.snapshot,
    });
    emit(ctx, done, () => `approved ${done.key} for ${done.due}\n`);
    return 0;
  },
};
