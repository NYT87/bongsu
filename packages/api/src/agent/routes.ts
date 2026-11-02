// The agent API over HTTP: REST under /v1 and MCP (stateless streamable HTTP, JSON
// responses) at /mcp. Both take "Authorization: Bearer bongsu_…", count against the key's rate limit, and check the
// tool's scope. The registry (tools.ts) is the single list of what agents can do.

import type { Env } from "@bongsu/core/env";
import { type Context, Hono } from "hono";
import { resolveItem, type Snapshot, sameSnapshot, snapshot, writeApproval } from "../pwa/approve";
import { authenticate, type Caller, withinRate } from "./auth";
import { ApiError, audit, exportPlan, type OpCtx, zoneOf } from "./ops";
import { TOOLS, type Tool, toolByName } from "./tools";

type Vars = { caller: Caller };
export const PROTOCOL = "2025-06-18";

export function apiRoutes(fetcher: typeof fetch) {
  const api = new Hono<{ Bindings: Env; Variables: Vars }>();

  const guard = async (c: Context<{ Bindings: Env; Variables: Vars }>, next: () => Promise<void>) => {
    const nowS = Math.floor(Date.now() / 1000);
    const caller = await authenticate(c.env.DB, c.req.header("Authorization"), nowS);
    if (!caller) return c.json({ error: "missing or invalid API key" }, 401);
    if (!(await withinRate(c.env.DB, caller.id, nowS)))
      return c.json({ error: "rate limit: 60 requests a minute" }, 429);
    c.set("caller", caller);
    await next();
  };
  api.use("/v1/*", guard);
  api.use("/mcp", guard);

  const ctx = (c: Context<{ Bindings: Env; Variables: Vars }>): OpCtx => ({
    env: c.env,
    fetch: fetcher,
    now: new Date(),
    caller: c.get("caller"),
  });

  async function call(c: Context<{ Bindings: Env; Variables: Vars }>, tool: Tool, args: Record<string, unknown>) {
    if (!c.get("caller").scopes.includes(tool.scope))
      throw new ApiError(403, `this key lacks the "${tool.scope}" scope`);
    return tool.run(ctx(c), args);
  }

  // ---- REST
  /** A route's answer as JSON; an ApiError becomes { error, ...extra } with its status. */
  const answer =
    (run: (c: Context<{ Bindings: Env; Variables: Vars }>) => Promise<unknown>) =>
    async (c: Context<{ Bindings: Env; Variables: Vars }>) => {
      try {
        return c.json(await run(c));
      } catch (e) {
        if (e instanceof ApiError) return c.json({ error: e.message, ...(e.extra ?? {}) }, e.status as 400);
        throw e;
      }
    };
  const rest = (
    method: "get" | "post",
    path: string,
    name: string,
    args: (c: Context<{ Bindings: Env; Variables: Vars }>) => Promise<Record<string, unknown>>,
  ) =>
    api[method](
      path,
      answer(async (c) => call(c, toolByName.get(name)!, await args(c))),
    );
  const q = (c: Context, k: string) => c.req.query(k);
  const num = (v: string | undefined) => (v === undefined ? undefined : Number(v));
  const body = async (c: Context) => {
    try {
      return (await c.req.json()) as Record<string, unknown>;
    } catch {
      return {};
    }
  };
  rest("get", "/v1/status", "get_status", async () => ({}));
  rest("get", "/v1/accounts", "list_accounts", async () => ({}));
  rest("get", "/v1/queue", "list_queue", async (c) => ({
    days: num(q(c, "days")),
    account: q(c, "account"),
    channel: q(c, "channel"),
    group: q(c, "group"),
    from: q(c, "from"),
  }));
  rest("get", "/v1/queue/groups", "queue_groups", async (c) => ({ days: num(q(c, "days")) }));
  const flag = (v: string | undefined) => v === "1" || v === "true";
  // before get_item's route: a key has slashes, so `<key>/metrics` would read as a key
  rest("get", "/v1/items/:key{.+}/metrics", "get_metrics", async (c) => ({
    key: decodeURIComponent(c.req.param("key") ?? ""),
    daily: flag(q(c, "daily")),
    from: q(c, "from"),
    to: q(c, "to"),
    metrics: q(c, "metrics"),
  }));
  rest("get", "/v1/performance", "list_performance", async (c) => ({
    account: q(c, "account"),
    platform: q(c, "platform"),
    from: q(c, "from"),
    to: q(c, "to"),
    sort: q(c, "sort"),
    limit: num(q(c, "limit")),
  }));
  rest("get", "/v1/accounts/:id/metrics", "get_account_metrics", async (c) => ({
    account: c.req.param("id") ?? "",
    daily: flag(q(c, "daily")),
    from: q(c, "from"),
    to: q(c, "to"),
  }));
  rest("get", "/v1/items/:key{.+}", "get_item", async (c) => ({ key: decodeURIComponent(c.req.param("key") ?? "") }));
  rest("get", "/v1/jobs", "list_jobs", async (c) => ({ days: num(q(c, "days")) }));
  rest("get", "/v1/notifications", "list_notifications", async (c) => ({ limit: num(q(c, "limit")) }));
  rest("get", "/v1/drafts", "list_drafts", async (c) => ({ status: q(c, "status") }));
  rest("post", "/v1/drafts", "create_draft", body);
  rest("post", "/v1/drafts/:id/withdraw", "withdraw_draft", async (c) => ({ id: c.req.param("id") ?? "" }));
  rest("post", "/v1/youtube/reschedule", "youtube_reschedule", body);
  rest("post", "/v1/metrics", "ingest_metrics", body);
  rest("post", "/v1/pause", "pause_scheduler", body);
  rest("post", "/v1/plan", "plan_add", body);
  rest("post", "/v1/plan/update", "plan_update", body);
  rest("post", "/v1/plan/remove", "plan_remove", body);
  rest("post", "/v1/posted", "record_posted", body);
  rest("post", "/v1/shorts", "shorts_add", body);
  rest("post", "/v1/shorts/commented", "record_commented", body);

  // ---- Approving from the CLI. Not a tool: an agent key can never approve, whatever scopes its row lists. Only a CLI
  // token (it names its person) whose role grants "approve" can, and only exactly what it was shown: the POST resolves
  // the item again and compares its snapshot, as the app's passkey flow does.
  const human = (c: Context<{ Bindings: Env; Variables: Vars }>) => {
    const k = c.get("caller");
    if (!k.scopes.includes("approve") || !k.userId)
      throw new ApiError(403, "approving takes a CLI token of an owner, admin or approver");
    return k;
  };
  const approvable = async (c: Context<{ Bindings: Env; Variables: Vars }>, key: string) => {
    const r = await resolveItem(c.env, fetcher, key, await zoneOf(ctx(c)), c.get("caller").workspaceId);
    if (!r) throw new ApiError(404, `${key} isn't planned`);
    if (r.problems.length) throw new ApiError(409, "can't approve yet", { problems: r.problems });
    return r;
  };
  api.get(
    "/v1/approve/:key{.+}",
    answer(async (c) => {
      human(c);
      const r = await approvable(c, decodeURIComponent(c.req.param("key") ?? ""));
      return {
        key: r.key,
        account: r.account,
        platform: r.platform,
        label: r.label,
        due: r.due,
        due_at: r.dueAt,
        hold: r.hold,
        caption: r.caption,
        comment: r.comment,
        comment2: r.comment2,
        alt: r.alt,
        media: r.media.map(({ name, checksum, mime }) => ({ name, checksum, mime })),
        lint: r.lint,
        approved: r.approved,
        snapshot: await snapshot(r),
      };
    }),
  );
  api.post(
    "/v1/approve",
    answer(async (c) => {
      const caller = human(c);
      const b = await body(c);
      const key = String(b.key ?? "");
      const r = await approvable(c, key);
      const now = await snapshot(r);
      if (!sameSnapshot(b.snapshot as Snapshot, now))
        throw new ApiError(409, "it changed since you looked: check the new version, then approve", { changed: true });
      await writeApproval(c.env, fetcher, r, now, new Date(), caller.userId!, "owner@cli");
      await audit(ctx(c), "approve", key, { due_at: now.dueAt, media: now.media.length });
      return { approved: true, key, due: r.due };
    }),
  );

  // The whole plan of the workspace for the CLI's `export`: not an agent tool (the registry is what agents see).
  api.get(
    "/v1/export",
    answer(async (c) => {
      if (!c.get("caller").scopes.includes("read")) throw new ApiError(403, 'this key lacks the "read" scope');
      return exportPlan(ctx(c), { texts: c.req.query("texts") === "1" });
    }),
  );

  // ---- MCP (JSON-RPC 2.0 over POST /mcp; no sessions, no server-initiated messages)
  api.post("/mcp", async (c) => {
    let msg: { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };
    try {
      msg = await c.req.json();
    } catch {
      return c.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, 400);
    }
    const reply = (result: unknown) => c.json({ jsonrpc: "2.0", id: msg.id ?? null, result });
    const fail = (code: number, message: string) =>
      c.json({ jsonrpc: "2.0", id: msg.id ?? null, error: { code, message } });
    if (msg.id === undefined || msg.id === null) return c.body(null, 202); // notifications (e.g. notifications/initialized)
    const caller = c.get("caller");
    switch (msg.method) {
      case "initialize":
        return reply({
          protocolVersion: PROTOCOL,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "bongsu", version: "1.0.0" },
          instructions:
            "Bongsu publishing scheduler. Start with list_accounts (the workspace's Instagram profiles and YouTube channels) and get_status (today's date and your time zone: dates and times you give and read are in it; times are stored in UTC, and due_at fields and `at` inputs are ISO 8601). Read the queue, items, jobs and notifications; edit the plan (add, reschedule, hold, remove; record manual posts/comments); set the texts it posts (plan_add / plan_update caption, comment, comment2, alt; shorts_add text); propose drafts; pause publishing. Every post needs the owner's approval: approving and resuming are owner-only, and a changed text needs a new approval.",
        });
      case "ping":
        return reply({});
      case "tools/list":
        return reply({
          tools: TOOLS.filter((t) => caller.scopes.includes(t.scope)).map(({ name, description, inputSchema }) => ({
            name,
            description,
            inputSchema,
          })),
        });
      case "tools/call": {
        const tool = toolByName.get(String(msg.params?.name ?? ""));
        if (!tool) return fail(-32602, `unknown tool ${msg.params?.name}`);
        try {
          const out = await call(c, tool, (msg.params?.arguments as Record<string, unknown>) ?? {});
          return reply({
            content: [{ type: "text", text: JSON.stringify(out, null, 1) }],
            structuredContent: out,
            isError: false,
          });
        } catch (e) {
          const m = e instanceof ApiError ? e.message : `internal error: ${(e as Error).message}`;
          return reply({ content: [{ type: "text", text: m }], isError: true });
        }
      }
      default:
        return fail(-32601, `method not found: ${msg.method}`);
    }
  });
  api.get("/mcp", (c) => c.body(null, 405)); // no server-to-client stream

  return api;
}
