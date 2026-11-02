import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { CliError, UsageError } from "../client";
import { type Command, type Ctx, parsed } from "../ctx";
import { generateSecrets } from "../secrets";

const FILES = ["wrangler.toml", "wrangler.cron.toml"];
const NAMES = ["SETUP_TOKEN", "ENCRYPTION_KEY", "MEDIA_SIGNING_KEY", "VAPID_PRIVATE_KEY"] as const;

/** The names Cloudflare already holds for one Worker. Failing here stops everything before a single `put`. */
async function listed(ctx: Ctx, cwd: string, file: string): Promise<Set<string>> {
  const r = await ctx.exec("npx", ["wrangler", "secret", "list", "--config", file, "--format", "json"], undefined, cwd);
  if (r.code !== 0) throw new CliError(`wrangler secret list failed: ${r.stderr.trim() || `exit ${r.code}`}`);
  try {
    return new Set((JSON.parse(r.stdout) as { name: string }[]).map((s) => s.name));
  } catch {
    throw new CliError("wrangler secret list did not print JSON");
  }
}

export const deploySecrets: Command = {
  name: "deploy-secrets",
  summary: "deploy-secrets [--config-dir <dir>] [--rotate] [--only A,B]   generate and set the Cloudflare secrets",
  async run(ctx: Ctx, args: string[]) {
    const { values } = parsed(() =>
      parseArgs({
        args,
        options: {
          "config-dir": { type: "string", default: "apps/cloudflare" },
          rotate: { type: "boolean" },
          only: { type: "string" },
        },
      }),
    );
    const only = values.only?.split(",").map((n) => n.trim());
    const unknown = only?.filter((n) => !(NAMES as readonly string[]).includes(n));
    if (unknown?.length)
      throw new UsageError(`--only: unknown secret ${unknown.join(", ")} (known: ${NAMES.join(", ")})`);
    const wanted = NAMES.filter((n) => !only || only.includes(n));

    // wrangler runs in the config dir so that `npx` finds the project's pinned wrangler.
    const dir = resolve(ctx.cwd, values["config-dir"]);
    const present = new Map<string, Set<string>>();
    for (const file of FILES) present.set(file, await listed(ctx, dir, file));

    // Both Workers must hold the same value: a name is kept only when both have it, set (once generated, in both)
    // when neither has it or on --rotate. A name in one only can't be read back to copy it, so that stops here.
    const keep = new Set<string>();
    for (const name of wanted) {
      const where = FILES.filter((f) => present.get(f)?.has(name));
      if (values.rotate || where.length === 0) continue;
      if (where.length === FILES.length) keep.add(name);
      else
        throw new CliError(
          `${name} is set in ${where[0]} but not in ${FILES.find((f) => f !== where[0])}: run again with --rotate --only ${name}`,
        );
    }

    const secrets = await generateSecrets();
    let vapidSet = false;
    let setupSet = false;
    const done: Record<string, string[]> = {};
    const report = (file: string) => {
      const kept = wanted.filter((n) => keep.has(n));
      if (done[file]?.length) ctx.io.out(`set ${done[file].join(", ")} in ${file}\n`);
      if (kept.length) ctx.io.out(`kept ${kept.join(", ")} in ${file}\n`);
    };
    const reportAll = () => {
      for (const file of FILES) report(file);
      // The public key only matches a private key set now; a kept private key has its own, already in the configs.
      if (vapidSet)
        ctx.io.out(
          `\nPut this in [vars] of both ${FILES.join(" and ")}:\nVAPID_PUBLIC_KEY = "${secrets.vapidPublicKey}"\n`,
        );
      // Printed once, since nothing can read a secret back: the dashboard's first sign-up asks for it. A kept token
      // is the operator's own and stays unprinted.
      if (setupSet)
        ctx.io.out(
          `\nThe dashboard's first sign-up asks for this SETUP_TOKEN (it works once; it isn't shown again):\n` +
            `${secrets.SETUP_TOKEN}\n`,
        );
    };
    try {
      for (const file of FILES) {
        done[file] = [];
        for (const name of wanted) {
          if (keep.has(name)) continue;
          // The value only travels on stdin: never in the arguments or a file (the output: SETUP_TOKEN only, above).
          const r = await ctx.exec("npx", ["wrangler", "secret", "put", name, "--config", file], secrets[name], dir);
          if (r.code !== 0)
            throw new CliError(`wrangler secret put ${name} failed: ${r.stderr.trim() || `exit ${r.code}`}`);
          done[file].push(name);
          if (name === "VAPID_PRIVATE_KEY") vapidSet = true;
          if (name === "SETUP_TOKEN") setupSet = true;
        }
      }
    } catch (e) {
      // What did go out must not be lost: the private key without its public half can't be paired later.
      reportAll();
      throw e;
    }
    reportAll();
    return 0;
  },
};
