// Composio's consumer MCP endpoint over plain HTTP: one tool per call, through
// COMPOSIO_MULTI_EXECUTE_TOOL, always with an explicit account (and raw Instagram calls through the workbench).
const URL = "https://connect.composio.dev/mcp";
const GRAPH = "https://graph.instagram.com/v23.0";
const MARK = "__BONGSU__";

export class ComposioError extends Error {}

export class Composio {
  constructor(
    private key: string,
    private fetcher: typeof fetch,
  ) {}

  private async call(name: string, args: Record<string, unknown>, what: string): Promise<Record<string, unknown>> {
    const r = await this.fetcher(URL, {
      method: "POST",
      headers: {
        "x-consumer-api-key": this.key,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
    if (!r.ok) throw new ComposioError(`composio ${what}: HTTP ${r.status}`);
    const text = await r.text();
    const lines = text
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5));
    const msg = JSON.parse(lines.length ? lines[lines.length - 1] : text);
    if (msg.error) throw new ComposioError(`composio ${what}: ${JSON.stringify(msg.error).slice(0, 300)}`);
    return JSON.parse(msg.result.content[0].text);
  }

  async exec<T = Record<string, unknown>>(slug: string, args: Record<string, unknown>, account: string): Promise<T> {
    if (!account) throw new ComposioError("refusing a Composio call without an account");
    const out = (await this.call(
      "COMPOSIO_MULTI_EXECUTE_TOOL",
      {
        tools: [{ tool_slug: slug, arguments: args, account }],
        thought: `scheduler: ${slug}`,
        sync_response_to_workbench: false,
        current_step: "SCHEDULER",
        current_step_metric: "0/1",
      },
      slug,
    )) as {
      data?: { results?: { response?: { successful?: boolean; data?: unknown; error?: unknown }; error?: unknown }[] };
      error?: unknown;
    };
    const item = out?.data?.results?.[0];
    if (!item?.response?.successful) {
      throw new ComposioError(
        `${slug} failed: ${JSON.stringify(item?.error ?? item?.response?.error ?? out?.error ?? out).slice(0, 300)}`,
      );
    }
    return item.response.data as T;
  }

  /**
   * A raw Instagram Graph API call, for what Composio's tools don't take (Trial Reels' trial_params). The consumer
   * endpoint has no proxy tool, so it runs proxy_execute in Composio's remote workbench, which can't pick an account:
   * it uses the default Instagram connection. So the cell first checks that the default is `igUserId` and refuses
   * otherwise (Instagram would refuse too: another account's id "does not exist" for that login).
   */
  async instagramRaw<T = Record<string, unknown>>(
    igUserId: string,
    method: "GET" | "POST",
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const spec = JSON.stringify({
      user: igUserId,
      method,
      url: `${GRAPH}/${path.replace(/^\//, "")}`,
      body: body ?? null,
    });
    const code = [
      "import json",
      `B = json.loads(${JSON.stringify(spec)})`,
      `me, e = proxy_execute("GET", "${GRAPH}/me", "instagram", query_params={"fields": "id"})`,
      `if e or not isinstance(me, dict) or me.get("id") != B["user"]:`,
      `    out = {"error": "Composio's default Instagram account is not " + B["user"] + ": " + str(e or me)[:200]}`,
      "else:",
      `    r, e = proxy_execute(B["method"], B["url"], "instagram", body=B["body"])`,
      `    out = {"data": r, "error": e}`,
      `print("${MARK}" + json.dumps(out, default=str))`,
    ].join("\n");
    const out = (await this.call(
      "COMPOSIO_REMOTE_WORKBENCH",
      {
        code_to_execute: code,
        thought: `scheduler: Instagram ${method} ${path}`,
        current_step: "SCHEDULER",
        current_step_metric: "0/1",
      },
      "workbench",
    )) as { data?: { stdout?: string; error?: string } };
    const line = (out?.data?.stdout ?? "").split("\n").find((l) => l.startsWith(MARK));
    if (!line)
      throw new ComposioError(`workbench: no result (${JSON.stringify(out?.data?.error || out).slice(0, 300)})`);
    const res = JSON.parse(line.slice(MARK.length)) as { data?: Record<string, unknown>; error?: string };
    // An HTTP error comes back as data {status, data: {error}} with no `error` of its own.
    const http = res.data && typeof res.data.status === "number" ? res.data : null;
    const igErr = (http?.data as { error?: { error_user_msg?: string; message?: string } } | undefined)?.error;
    if (res.error || igErr || (http && (http.status as number) >= 400)) {
      throw new ComposioError(
        `Instagram ${method} ${path}: ${res.error || igErr?.error_user_msg || igErr?.message || `HTTP ${http?.status}`}`.slice(
          0,
          300,
        ),
      );
    }
    return (http ? http.data : res.data) as T;
  }
}

/** A container or media id from a Composio Instagram response (it nests them inconsistently, as ig.py handles). */
export function idOf(d: Record<string, unknown>): string | undefined {
  return (d.id as string) ?? ((d.data as Record<string, unknown> | undefined)?.id as string | undefined);
}
