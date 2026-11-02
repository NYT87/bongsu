import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { CliError } from "./client";
import type { Ctx } from "./ctx";

export interface Profile {
  url: string;
  token: string;
}

export interface Config {
  default?: string;
  profiles: Record<string, Profile>;
}

export async function readConfig(path: string): Promise<Config> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { profiles: {} };
    if (code === "EACCES" || code === "EPERM") {
      throw new CliError(`can't read ${path}: permission denied; check its owner and mode`);
    }
    throw new CliError(`can't read ${path}: ${code ?? (e as Error).message}`);
  }
  return parseConfig(path, text);
}

// The parser's own message quotes the start of the file, which may be a token: it is never shown.
function parseConfig(path: string, text: string): Config {
  let c: unknown;
  try {
    c = JSON.parse(text);
  } catch {
    c = undefined;
  }
  if (typeof c !== "object" || c === null || Array.isArray(c)) {
    throw new CliError(`can't read ${path}: not valid JSON; fix or delete it`);
  }
  const config = c as Partial<Config>;
  return { ...config, profiles: config.profiles ?? {} };
}

/** The file holds tokens: only its owner may read it, whatever the umask. */
export async function writeConfig(path: string, c: Config): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(c, null, 2)}\n`, { mode: 0o600 });
}

/** The environment wins so scripts and CI need no file; then --workspace, then the last login. */
export async function profileFor(ctx: Ctx): Promise<Profile> {
  const { BONGSU_URL: url, BONGSU_TOKEN: token } = ctx.env;
  if (url && token) return { url, token };
  if (url || token) throw new CliError("set both BONGSU_URL and BONGSU_TOKEN, or neither");
  const c = await readConfig(ctx.configPath);
  const name = ctx.workspace ?? c.default;
  const p = name === undefined ? undefined : c.profiles[name];
  if (!p)
    throw new CliError(
      ctx.workspace ? `no profile "${ctx.workspace}": run bongsu login first` : "run bongsu login first",
    );
  return p;
}
