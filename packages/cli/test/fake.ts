import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Config } from "../src/config";
import type { Ctx, Exec } from "../src/ctx";

/** A canned answer: a bare body is a 200 JSON answer, `{ status, body }` any status, `{ status, text }` a non-JSON one. */
type Answer = unknown | { status: number; body: unknown } | { status: number; text: string };

export interface FakeOptions {
  /** Keyed "METHOD /path" (or "METHOD /path?query" to match the query too). */
  responses?: Record<string, Answer>;
  /** Written to the config path before the command runs. */
  config?: Config;
  env?: Record<string, string | undefined>;
  isTTY?: boolean;
  /** Answers to `ask` and `secret`, in order. */
  answers?: string[];
  stdin?: string;
  /** What `io.lines()` yields. */
  stdinLines?: string[];
  exec?: Exec;
}

const isAnswer = (a: unknown): a is { status: number; body: unknown } =>
  typeof a === "object" && a !== null && "status" in a && "body" in a;
const isText = (a: unknown): a is { status: number; text: string } =>
  typeof a === "object" && a !== null && "status" in a && "text" in a;

export function fakeCtx(opts: FakeOptions = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const calls: { method: string; url: string; body: unknown }[] = [];
  const execs: { cmd: string; args: string[]; input?: string; cwd?: string }[] = [];
  const prompts: { q: string; secret: boolean }[] = [];
  const answers = [...(opts.answers ?? [])];
  const configPath = join(mkdtempSync(join(tmpdir(), "bongsu-cli-")), "bongsu", "cli.json");
  if (opts.config) {
    mkdirFor(configPath);
    writeFileSync(configPath, JSON.stringify(opts.config));
  }

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, url: url.toString(), body });
    const responses = opts.responses ?? {};
    const key = [`${method} ${url.pathname}${url.search}`, `${method} ${url.pathname}`].find((k) => k in responses);
    if (key === undefined) return Response.json({ error: "not found" }, { status: 404 });
    const answer = responses[key];
    if (isText(answer))
      return new Response(answer.text, { status: answer.status, headers: { "content-type": "text/html" } });
    return isAnswer(answer) ? Response.json(answer.body, { status: answer.status }) : Response.json(answer);
  }) as typeof fetch;

  const next = (q: string, secret: boolean) => {
    prompts.push({ q, secret });
    return Promise.resolve(answers.shift() ?? "");
  };

  const ctx: Ctx = {
    io: {
      out: (s) => out.push(s),
      err: (s) => err.push(s),
      isTTY: opts.isTTY ?? true,
      ask: (q) => next(q, false),
      secret: (q) => next(q, true),
      readStdin: () => Promise.resolve(opts.stdin ?? ""),
      lines: async function* () {
        yield* opts.stdinLines ?? [];
      },
    },
    fetch: fetchImpl,
    env: opts.env ?? {},
    configPath,
    json: false,
    exec: (cmd, args, input, cwd) => {
      execs.push({ cmd, args, input, cwd });
      return (opts.exec ?? (() => Promise.resolve({ code: 0, stdout: "", stderr: "" })))(cmd, args, input, cwd);
    },
    cwd: process.cwd(),
  };
  return { ctx, out, err, calls, execs, prompts };
}

function mkdirFor(path: string) {
  mkdirSync(dirname(path), { recursive: true });
}
