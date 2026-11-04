// The Env (core/env.ts) on Node: the database and the static files from here, everything else from process.env (or a
// .env file docker-compose passes in). The names are the Cloudflare ones, so site/docs/configuration.md covers both.

import { NODE_JOBS_PER_TICK } from "@bongsu/core/constants";
import type { Db } from "@bongsu/core/db";
import type { Env } from "@bongsu/core/env";

type Vars = Record<string, string | undefined>;

export class ConfigError extends Error {}

export function nodeEnv(vars: Vars, db: Db, assets?: Env["ASSETS"]): Env {
  const publicUrl = vars.PUBLIC_URL?.replace(/\/$/, "");
  if (!publicUrl) throw new ConfigError("PUBLIC_URL is required: the instance's public https:// address");
  const env: Env = {
    DB: db,
    ASSETS: assets,
    PUBLIC_URL: publicUrl,
    RP_ID: vars.RP_ID ?? new URL(publicUrl).hostname,
    DRY_RUN: vars.DRY_RUN ?? "1",
    VAPID_PUBLIC_KEY: vars.VAPID_PUBLIC_KEY ?? "",
    VAPID_SUBJECT: vars.VAPID_SUBJECT ?? "",
    DRIVE_SA_JSON: vars.DRIVE_SA_JSON ?? "",
    MEDIA_SIGNING_KEY: vars.MEDIA_SIGNING_KEY ?? "",
    // no per-invocation subrequest limit here, unlike Cloudflare's free plan: more jobs a tick
    JOBS_PER_TICK: vars.JOBS_PER_TICK ?? String(NODE_JOBS_PER_TICK),
  };
  // the optional ones, only when set
  for (const k of [
    "VAPID_PRIVATE_KEY",
    "COMPOSIO_CONSUMER_KEY",
    "MEDIA_STORE",
    "MEDIA_DIR",
    "ENCRYPTION_KEY",
    "SETUP_TOKEN",
    "DRIVE_OWNER_OAUTH",
    "MAILER",
    "MAIL_FROM",
    "RESEND_API_KEY",
    "SMTP_HOST",
    "SMTP_PORT",
    "SMTP_USER",
    "SMTP_PASS",
  ] as const)
    if (vars[k]) (env as unknown as Vars)[k] = vars[k];
  // Connections set up by hand name their secret (connections.secret_name): any other variable can be one.
  return new Proxy(env, {
    get: (t, k) => (k in t ? t[k as keyof Env] : typeof k === "string" ? vars[k] : undefined),
    has: (t, k) => k in t || (typeof k === "string" && k in vars),
  });
}
