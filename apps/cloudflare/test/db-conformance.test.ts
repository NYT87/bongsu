// The Db port on D1 runs the same conformance cases as SQLite on Node (apps/node/test/node.test.ts).
import { env } from "cloudflare:workers";
import { dbCases } from "@bongsu/core/db-conformance";
import { describe, it } from "vitest";

describe("db conformance: D1", () => {
  for (const c of dbCases(env.DB)) it(c.name, c.run);
});
