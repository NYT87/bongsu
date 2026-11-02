import { parseArgs } from "node:util";
import { postgresSchema } from "@bongsu/schema/postgres";
import { sqliteSchema } from "@bongsu/schema/sqlite";
import { UsageError } from "../client";
import { type Command, type Ctx, parsed } from "../ctx";

export const schema: Command = {
  name: "schema",
  summary: "schema --dialect sqlite|postgres                the DDL for a fresh database",
  async run(ctx: Ctx, args: string[]) {
    const { values } = parsed(() => parseArgs({ args, options: { dialect: { type: "string" } } }));
    if (values.dialect === "sqlite") ctx.io.out(sqliteSchema());
    else if (values.dialect === "postgres") ctx.io.out(postgresSchema());
    else throw new UsageError("--dialect must be sqlite or postgres");
    return 0;
  },
};
