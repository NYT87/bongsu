import assert from "node:assert/strict";
import { createServer } from "node:net";
import { describe, it } from "node:test";
import { assertPortFree, PORT, serve } from "./serve.mjs";

const listen = () =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(PORT, "127.0.0.1", () => resolve(s));
  });

describe("the demo's port", () => {
  it("is refused when something else listens on it, and accepted once it is free", async () => {
    const other = await listen();
    await assert.rejects(assertPortFree(), /port 8787 in use/);
    await assert.rejects(serve({ dbPath: "x", mediaDir: "y" }), /port 8787 in use/);
    await new Promise((r) => other.close(r));
    await assertPortFree();
  });
});
