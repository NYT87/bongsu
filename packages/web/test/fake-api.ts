// The app's backend, faked at fetch: no server runs. A route answers `METHOD /app-api/<path>`; the calls are kept so a
// test can check what the screen sent.
import { vi } from "vitest";

export type Reply = { status?: number; body?: unknown };
export type Call = { method: string; path: string; body: unknown };

export function fakeApi(routes: Record<string, Reply | ((body: unknown) => Reply)>) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).replace(/^\/app-api\//, "");
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ method, path, body });
      const route = routes[`${method} ${path}`];
      if (!route) return new Response(JSON.stringify({ error: `no route ${method} ${path}` }), { status: 404 });
      const r = typeof route === "function" ? route(body) : route;
      return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200 });
    }),
  );
  return calls;
}
