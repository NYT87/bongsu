import { apiFor } from "../client";
import type { Command, Ctx } from "../ctx";
import { bridge } from "../mcp";

export const mcp: Command = {
  name: "mcp",
  summary: "mcp                                           stdio bridge to /mcp, for MCP clients without HTTP",
  async run(ctx: Ctx) {
    await bridge(ctx.io.lines(), await apiFor(ctx), ctx.io.out);
    return 0;
  },
};
