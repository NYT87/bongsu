import { describe, expect, it } from "vitest";
import { Api } from "../src/client";
import { main } from "../src/main";
import { bridge } from "../src/mcp";
import { fakeCtx } from "./fake";

const list = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}';
const answer = { jsonrpc: "2.0", id: 1, result: { tools: [] } };

async function* lines(...l: string[]) {
  yield* l;
}

function run(l: string[], fetchImpl: typeof fetch) {
  const out: string[] = [];
  return bridge(lines(...l), new Api("https://bongsu.example.com/", "bongsu_cli_abc", fetchImpl), (s) =>
    out.push(s),
  ).then(() => out);
}

describe("mcp bridge", () => {
  it("posts a request to /mcp with the bearer and writes the answer as one line", async () => {
    const seen: { url: string; init?: RequestInit }[] = [];
    const out = await run([list], (async (url: string, init?: RequestInit) => {
      seen.push({ url, init });
      return Response.json(answer);
    }) as unknown as typeof fetch);
    expect(seen[0].url).toBe("https://bongsu.example.com/mcp");
    expect(seen[0].init?.method).toBe("POST");
    expect((seen[0].init?.headers as Record<string, string> | undefined)?.authorization).toBe("Bearer bongsu_cli_abc");
    expect(seen[0].init?.body).toBe(list);
    expect(out).toEqual([`${JSON.stringify(answer)}\n`]);
  });

  it("posts a notification and writes nothing", async () => {
    let posted = 0;
    const out = await run(['{"jsonrpc":"2.0","method":"notifications/initialized"}'], (async () => {
      posted++;
      return new Response(null, { status: 202 });
    }) as unknown as typeof fetch);
    expect(posted).toBe(1);
    expect(out).toEqual([]);
  });

  it("skips blank lines", async () => {
    let posted = 0;
    const out = await run(["", "  "], (async () => {
      posted++;
      return Response.json(answer);
    }) as unknown as typeof fetch);
    expect(posted).toBe(0);
    expect(out).toEqual([]);
  });

  it("answers a transport failure with a JSON-RPC error carrying the request's id", async () => {
    const out = await run([list], (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch);
    const reply = JSON.parse(out[0]);
    expect(out[0].endsWith("\n")).toBe(true);
    expect(reply).toMatchObject({ jsonrpc: "2.0", id: 1, error: { code: -32000 } });
    expect(reply.error.message).toContain("connection refused");
  });

  it("answers a plain {error} refusal (401) with a JSON-RPC error for the request", async () => {
    const out = await run([list], (async () =>
      Response.json({ error: "unauthorized" }, { status: 401 })) as unknown as typeof fetch);
    expect(JSON.parse(out[0])).toEqual({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32000, message: "401 unauthorized" },
    });
  });

  it("answers a non-JSON body with a readable message, not the parser's", async () => {
    const out = await run(
      [list],
      (async () => new Response("<html>bad gateway</html>", { status: 502 })) as unknown as typeof fetch,
    );
    const reply = JSON.parse(out[0]);
    expect(reply.id).toBe(1);
    expect(reply.error.message).toBe("https://bongsu.example.com didn't answer JSON (502)");
  });

  it("the mcp command feeds stdin lines through the profile's token", async () => {
    const { ctx, out, calls } = fakeCtx({
      config: { default: "t", profiles: { t: { url: "https://t.example.com", token: "bongsu_cli_t" } } },
      stdinLines: [list],
      responses: { "POST /mcp": answer },
    });
    expect(await main(["mcp"], ctx)).toBe(0);
    expect(calls[0].url).toBe("https://t.example.com/mcp");
    expect(out).toEqual([`${JSON.stringify(answer)}\n`]);
  });
});
