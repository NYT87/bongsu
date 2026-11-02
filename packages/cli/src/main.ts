import pkg from "../package.json";
import { CliError, UsageError } from "./client";
import { approve } from "./commands/approve";
import { deploySecrets } from "./commands/deploy-secrets";
import { exportPlan } from "./commands/export";
import { ingest } from "./commands/ingest";
import { login, logout } from "./commands/login";
import { mcp } from "./commands/mcp";
import { queue } from "./commands/queue";
import { schema } from "./commands/schema";
import { stats } from "./commands/stats";
import { status } from "./commands/status";
import { texts } from "./commands/texts";
import type { Command, Ctx } from "./ctx";

const commands: Command[] = [
  login,
  logout,
  status,
  queue,
  texts,
  approve,
  stats,
  ingest,
  exportPlan,
  mcp,
  schema,
  deploySecrets,
];

export function usage(): string {
  return [
    "usage: bongsu [--workspace <name>] [--json] <command> [options]",
    "",
    "commands:",
    ...commands.map((c) => `  ${c.summary}`),
    "",
    "global options:",
    "  --workspace <name>   the profile to use (default: the last login)",
    "  --json               print the API's answer as JSON",
    "  --help, --version",
    "",
    "BONGSU_URL and BONGSU_TOKEN, when both are set, take the place of the profile.",
    "",
  ].join("\n");
}

interface Globals {
  rest: string[];
  json: boolean;
  workspace?: string;
  help: boolean;
  version: boolean;
}

/** The global options may come before or after the command (`bongsu queue --json`); the rest goes to the command.
 *  After `--`, everything is the command's. */
function globals(argv: string[]): Globals {
  const g: Globals = { rest: [], json: false, help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      g.rest.push(...argv.slice(i));
      break;
    }
    if (a === "--json") g.json = true;
    else if (a === "--help" || a === "-h") g.help = true;
    else if (a === "--version") g.version = true;
    else if (a.startsWith("--workspace=")) g.workspace = a.slice("--workspace=".length);
    else if (a === "--workspace") {
      const name = argv[++i];
      if (name === undefined || name.startsWith("-")) throw new UsageError("--workspace needs a profile name");
      g.workspace = name;
    } else g.rest.push(a);
  }
  if (g.workspace === "") throw new UsageError("--workspace needs a profile name");
  return g;
}

async function dispatch(argv: string[], ctx: Ctx): Promise<number> {
  const g = globals(argv);
  if (g.version) {
    ctx.io.out(`${pkg.version}\n`);
    return 0;
  }
  const [name, ...args] = g.rest;
  if (g.help || name === undefined) {
    ctx.io.out(usage());
    return 0;
  }
  const command = commands.find((c) => c.name === name);
  if (!command) throw new UsageError(`unknown command: ${name}`);
  if (g.json) ctx.json = true;
  if (g.workspace !== undefined) ctx.workspace = g.workspace;
  return command.run(ctx, args);
}

export async function main(argv: string[], ctx: Ctx): Promise<number> {
  try {
    return await dispatch(argv, ctx);
  } catch (e) {
    if (e instanceof UsageError) {
      ctx.io.err(`bongsu: ${e.message}\n\n${usage()}`);
      return 2;
    }
    if (e instanceof CliError) {
      ctx.io.err(`bongsu: ${e.message}\n`);
      return 1;
    }
    throw e;
  }
}
