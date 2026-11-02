import { parseArgs } from "node:util";
import { Api, CliError, UsageError } from "../client";
import { readConfig, writeConfig } from "../config";
import { type Command, type Ctx, parsed } from "../ctx";

function publicUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UsageError(`--url must be the instance's address, like https://bongsu.example.com (got ${raw})`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new UsageError("--url must be an http(s) address");
  return url;
}

/** Checks the token against the instance before saving anything, so a typo never becomes the default profile. */
async function check(api: Api) {
  try {
    await api.get("/v1/status");
  } catch (e) {
    if (e instanceof CliError && e.status === 401) {
      throw new CliError("the instance refused the token: create a CLI token in the app and try again", 401);
    }
    throw e;
  }
}

export const login: Command = {
  name: "login",
  summary: "login --url <PUBLIC_URL> [--token <token>]   save a CLI token (prompted when not given)",
  async run(ctx: Ctx, args: string[]) {
    const { values } = parsed(() =>
      parseArgs({ args, options: { url: { type: "string" }, token: { type: "string" } } }),
    );
    if (!values.url) throw new UsageError("login needs --url <PUBLIC_URL>");
    const url = publicUrl(values.url);
    const token = (values.token ?? (await ctx.io.secret("CLI token: "))).trim();
    if (!token) throw new UsageError("login needs a token: paste the CLI token from the app");
    const api = new Api(values.url, token, ctx.fetch);
    await check(api);

    const name = ctx.workspace ?? url.hostname;
    const config = await readConfig(ctx.configPath);
    config.profiles[name] = { url: api.url, token };
    config.default = name;
    await writeConfig(ctx.configPath, config);
    ctx.io.out(`logged in to ${api.url} as profile "${name}" (now the default)\n`);
    return 0;
  },
};

export const logout: Command = {
  name: "logout",
  summary: "logout                                       forget a profile (--workspace, else the default)",
  async run(ctx: Ctx, args: string[]) {
    parsed(() => parseArgs({ args, options: {} }));
    const config = await readConfig(ctx.configPath);
    const name = ctx.workspace ?? config.default;
    if (name === undefined || !config.profiles[name]) {
      throw new CliError(name === undefined ? "not logged in" : `no profile "${name}"`);
    }
    delete config.profiles[name];
    if (config.default === name) delete config.default;
    await writeConfig(ctx.configPath, config);
    ctx.io.out(`logged out of profile "${name}"\n`);
    return 0;
  },
};
