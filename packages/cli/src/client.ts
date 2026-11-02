import { profileFor } from "./config";
import type { Ctx } from "./ctx";

/** A failure the user can act on: main prints its message without a stack. */
export class CliError extends Error {
  constructor(
    message: string,
    public status?: number,
    public extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "CliError";
  }
}

type Query = Record<string, string | number | boolean | undefined>;

/** The API's own words for these are written for agents; a person at a terminal needs to know what to do. */
function messageFor(status: number, error: string): string {
  if (status === 401) return "the token isn't valid any more: run bongsu login";
  if (status === 429) return "rate limit: 60 requests a minute, wait and retry";
  return error;
}

export class Api {
  public url: string;

  constructor(
    url: string,
    private token: string,
    private fetchImpl: typeof fetch,
  ) {
    this.url = url.replace(/\/+$/, "");
  }

  get<T>(path: string, query?: Query): Promise<T> {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) params.set(k, String(v));
    const qs = params.toString();
    return this.send<T>("GET", qs ? `${path}?${qs}` : path);
  }

  post<T>(path: string, body: unknown): Promise<T> {
    return this.send<T>("POST", path, body);
  }

  /** The answer as it came, whatever the status: the MCP bridge relays JSON-RPC bodies and empty 202s untouched. */
  async postRaw(path: string, body: string): Promise<{ status: number; text: string }> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.url}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
        body,
      });
    } catch (e) {
      throw new CliError(`can't reach ${this.url}: ${(e as Error).message}`);
    }
    return { status: res.status, text: await res.text() };
  }

  private async send<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}` };
    if (body !== undefined) headers["content-type"] = "application/json";
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.url}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new CliError(`can't reach ${this.url}: ${(e as Error).message}`);
    }
    const data = (await res.json().catch(() => undefined)) as Record<string, unknown> | undefined;
    // A wrong --url (any web site answering 200 with a page) must not pass for an instance.
    if (res.ok && (typeof data !== "object" || data === null)) {
      throw new CliError(`${this.url} didn't answer like a Bongsu instance`, res.status);
    }
    if (!res.ok) {
      const { error, ...rest } = data ?? {};
      const text = typeof error === "string" ? error : `${res.status} ${res.statusText}`.trim();
      throw new CliError(messageFor(res.status, text), res.status, rest);
    }
    return data as T;
  }
}

export async function apiFor(ctx: Ctx): Promise<Api> {
  const p = await profileFor(ctx);
  return new Api(p.url, p.token, ctx.fetch);
}

/** The command line itself is wrong: main prints the message and the usage, and exits 2. */
export class UsageError extends CliError {}
