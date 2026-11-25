// The dashboard's backend, faked at fetch: no server runs. A route answers `METHOD <path>` (the path after
// /admin-api/); the calls are kept so a test can check what the page sent. A file body is kept as its type and name.
import { vi } from "vitest";

export type Reply = { status?: number; body?: unknown };
export type Call = { method: string; path: string; body: unknown };

export function fakeApi(routes: Record<string, Reply | ((body: unknown) => Reply)>) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).replace(/^\/admin-api\//, "");
      const method = init?.method ?? "GET";
      const raw = init?.body;
      const body =
        typeof raw === "string"
          ? JSON.parse(raw)
          : raw instanceof File
            ? { type: raw.type, name: raw.name }
            : undefined;
      calls.push({ method, path, body });
      const route = routes[`${method} ${path}`];
      if (!route) return new Response(JSON.stringify({ error: `no route ${method} ${path}` }), { status: 404 });
      const r = typeof route === "function" ? route(body) : route;
      return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200 });
    }),
  );
  return calls;
}
