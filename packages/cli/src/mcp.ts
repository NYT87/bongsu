import type { Api } from "./client";

const rpcError = (id: unknown, code: number, message: string) =>
  `${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`;

/** One JSON-RPC message in, at most one line out. A notification has no `id` and no answer, so the client isn't
 *  left waiting for a line that never comes; a failure to reach the server answers the request instead of ending
 *  the bridge, so the client sees an error rather than a hang. */
async function relay(line: string, api: Api, out: (s: string) => void): Promise<void> {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    out(rpcError(null, -32700, "parse error: not JSON"));
    return;
  }
  const id = typeof message === "object" && message !== null && "id" in message ? message.id : undefined;
  try {
    const { status, text } = await api.postRaw("/mcp", line);
    if (id === undefined) return;
    const body = parseObject(text);
    if (body && ("jsonrpc" in body || status < 300)) {
      // The body is JSON on one line already; re-serialising guards against a pretty-printed answer.
      out(`${JSON.stringify(body)}\n`);
    } else if (!text.trim() && status < 300) {
      return;
    } else if (body) {
      // The auth guard and rate limit answer a plain {error}: without a JSON-RPC answer the client would wait forever.
      out(rpcError(id, -32000, `${status} ${typeof body.error === "string" ? body.error : "request refused"}`));
    } else {
      out(rpcError(id, -32000, `${api.url} didn't answer JSON (${status})`));
    }
  } catch (e) {
    if (id !== undefined) out(rpcError(id, -32000, (e as Error).message));
  }
}

function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(text);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

export async function bridge(lines: AsyncIterable<string>, api: Api, out: (s: string) => void): Promise<void> {
  for await (const line of lines) {
    if (line.trim()) await relay(line, api, out);
  }
}
