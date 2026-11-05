// The HTTP side of Bongsu, independent of the runtime: /health, the signed media links Instagram fetches (/m/…), the
// agent API (/v1, /mcp), the owner's app API (/app-api) and, when the runtime provides them, the app's static files.

import type { Env } from "@bongsu/core/env";
import { iconByHash } from "@bongsu/core/icon";
import { serveMedia } from "@bongsu/core/media";
import { mediaStoreById, storeRows } from "@bongsu/core/media/index";
import { tableNames } from "@bongsu/core/sql";
import { Hono } from "hono";
import { apiRoutes } from "./agent/routes";
import { adminRoutes } from "./dashboard/routes";
import { appRoutes } from "./pwa/routes";

/** Secrets every instance needs, and the ones a kind of connection needs (only when one exists). The media stores'
 *  credentials are in the database, encrypted: they need ENCRYPTION_KEY like the rest. */
const SECRETS = ["MEDIA_SIGNING_KEY"] as const;
/** Tables /health looks for: the database is reachable and migrated. */
const CORE_TABLES = ["api_keys", "audit", "drafts", "jobs", "locks", "push_subs"];
const SECRETS_FOR: Record<string, (keyof Env)[]> = {
  composio: ["COMPOSIO_CONSUMER_KEY"],
  instagram: ["ENCRYPTION_KEY"], // renewed tokens are stored encrypted
};

/** The HTTP app. `fetcher` is the fetch every outside call goes through (tests pass a fake world). */
export function createApp(fetcher: typeof fetch) {
  const app = new Hono<{ Bindings: Env }>();

  // Liveness plus a configuration check: database reachable and migrated, which secrets are set (names only), and the
  // media stores (at least one, none broken).
  app.get("/health", async (c) => {
    const tables = (await tableNames(c.env.DB)).filter((n) => CORE_TABLES.includes(n));
    const providers = (await c.env.DB.prepare("SELECT DISTINCT provider FROM connections").all<{ provider: string }>())
      .results;
    // anything stored encrypted (credentials, OAuth app secrets, ntfy topics) needs the key to be read back
    const encrypted = await c.env.DB.prepare(
      `SELECT 1 FROM connections WHERE credentials IS NOT NULL UNION ALL SELECT 1 FROM oauth_apps
       UNION ALL SELECT 1 FROM workspace_oauth_apps
       UNION ALL SELECT 1 FROM workspace_settings WHERE notify_url IS NOT NULL
       UNION ALL SELECT 1 FROM media_store WHERE credentials IS NOT NULL LIMIT 1`,
    ).first();
    const rows = await storeRows(c.env.DB, { workspaceId: null }); // the instance's: a workspace's broken store isn't its health
    const needed = [
      ...SECRETS,
      ...providers.flatMap((p) => SECRETS_FOR[p.provider] ?? []),
      ...(encrypted ? (["ENCRYPTION_KEY"] as const) : []),
    ];
    const missing = [...new Set(needed)].filter((k) => !c.env[k]);
    const media_stores = rows.map((r) => ({ kind: r.kind, status: r.status, default: r.isDefault }));
    const ok =
      tables.length === CORE_TABLES.length &&
      missing.length === 0 &&
      rows.length > 0 &&
      rows.every((r) => r.status === "ok");
    return c.json(
      {
        ok,
        dry_run: c.env.DRY_RUN !== "0",
        tables: tables.sort(),
        missing_secrets: missing,
        media_stores,
      },
      ok ? 200 : 503,
    );
  });

  app.on(["GET", "HEAD"], "/m/:store/:file", async (c) =>
    serveMedia(
      c.req.raw,
      c.env.MEDIA_SIGNING_KEY,
      (id) => mediaStoreById(c.env, fetcher, id),
      Math.floor(Date.now() / 1000),
    ),
  );

  // A workspace's icon: public, addressed by the content's hash, so it can't be guessed and never changes.
  app.get("/icon/:file", async (c) => {
    const m = /^([0-9a-f]{64})\.png$/.exec(c.req.param("file"));
    const png = m ? await iconByHash(c.env.DB, m[1]) : null;
    if (!png) return c.body(null, 404);
    return new Response(new Uint8Array(png), {
      headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=31536000, immutable" },
    });
  });

  // The agent API: REST /v1 and MCP /mcp, behind API keys (agent/).
  app.route("/", apiRoutes(fetcher));
  // The owner's app API: /app-api, behind a passkey session (pwa/).
  app.route("/", appRoutes(fetcher));
  // The dashboard's API: /admin-api, behind its own sign-in (email + passkey; dashboard/).
  app.route("/", adminRoutes(fetcher));

  app.notFound(async (c) => {
    // Anything else is one of the two apps (single-page apps): their static files, else their index.html. The
    // dashboard lives under /dashboard/ (built into the PWA's dist/dashboard/).
    if (c.env.ASSETS && c.req.method === "GET" && !/^\/(app-api|admin-api|v1)\//.test(c.req.path)) {
      if (c.req.path === "/dashboard" || c.req.path.startsWith("/dashboard/")) {
        const file = /\.[a-z0-9]{2,5}$/i.test(c.req.path);
        const url = new URL(c.req.url);
        // "/dashboard/", not ".../index.html": the assets layer redirects that to its canonical "/dashboard/"
        if (!file) url.pathname = "/dashboard/";
        return c.env.ASSETS.fetch(new Request(url.toString(), c.req.raw));
      }
      return c.env.ASSETS.fetch(c.req.raw);
    }
    return c.json({ error: "not found" }, 404);
  });

  return app;
}
