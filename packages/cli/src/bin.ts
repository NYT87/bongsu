// The real Ctx: the only file that touches `process`, the terminal, child processes and the home folder.
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Ctx, Exec } from "./ctx";
import { main } from "./main";

// Prompts go to stderr so that stdout stays the command's answer when it is piped.
function ask(q: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) =>
    rl.question(q, (answer) => {
      rl.close();
      resolve(answer);
    }),
  );
}

/** Reads a line with echo off, so a token never shows on the screen or in a terminal recording. */
function secret(q: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) return ask(q);
  process.stderr.write(q);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise((resolve) => {
    let typed = "";
    const done = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write("\n");
      resolve(typed);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") return done();
        if (ch === "\u0003") {
          stdin.setRawMode(false);
          process.stderr.write("\n");
          process.exit(130);
        }
        if (ch === "\u007f" || ch === "\b") typed = typed.slice(0, -1);
        else typed += ch;
      }
    };
    stdin.on("data", onData);
  });
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

const exec: Exec = (cmd, args, input, cwd) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      resolve({ code, stdout, stderr });
    };
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("error", (e) => {
      stderr += e.message;
      finish(127);
    });
    child.on("close", (code) => finish(code ?? 1));
    child.stdin.end(input ?? "");
  });

const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");

const ctx: Ctx = {
  io: {
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
    isTTY: Boolean(process.stdin.isTTY),
    ask,
    secret,
    readStdin,
    lines: () => createInterface({ input: process.stdin, crlfDelay: Infinity }),
  },
  fetch: globalThis.fetch,
  env: process.env,
  configPath: join(configHome, "bongsu", "cli.json"),
  json: false,
  exec,
  cwd: process.cwd(),
};

process.exitCode = await main(process.argv.slice(2), ctx);
