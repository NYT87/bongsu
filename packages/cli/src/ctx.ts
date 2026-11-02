// What a command may touch. bin.ts builds the real one from `process`; tests build a fake (test/fake.ts), so no
// command reads the terminal, the network, the environment or the disk's home folder directly.

import { UsageError } from "./client";

export interface Io {
  out(s: string): void;
  err(s: string): void;
  isTTY: boolean;
  ask(q: string): Promise<string>;
  /** Like `ask`, with echo off when stdin is a terminal: for tokens. */
  secret(q: string): Promise<string>;
  readStdin(): Promise<string>;
  /** Stdin line by line, until it closes: the MCP bridge. */
  lines(): AsyncIterable<string>;
}

/** Runs a program, with `input` on its stdin, in `cwd` (default: the process's). */
export type Exec = (
  cmd: string,
  args: string[],
  input?: string,
  cwd?: string,
) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface Ctx {
  io: Io;
  fetch: typeof fetch;
  env: Record<string, string | undefined>;
  configPath: string;
  json: boolean;
  /** The profile chosen with --workspace. */
  workspace?: string;
  exec: Exec;
  cwd: string;
}

export type Command = { name: string; summary: string; run(ctx: Ctx, args: string[]): Promise<number> };

/** The one key a command takes; any other count is a usage error (exit 2). */
export function oneKey(positionals: string[], usage: string): string {
  if (positionals.length !== 1) throw new UsageError(`${usage} needs exactly one key`);
  return positionals[0];
}

/** Runs a `parseArgs` call, turning its complaints (unknown option, missing value) into a usage error. */
export function parsed<T>(parse: () => T): T {
  try {
    return parse();
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
}
