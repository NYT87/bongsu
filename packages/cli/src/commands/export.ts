import { parseArgs } from "node:util";
import { apiFor, UsageError } from "../client";
import { type Command, type Ctx, parsed } from "../ctx";
import { csv } from "../output";

const COLUMNS = [
  "key",
  "account",
  "platform",
  "format",
  "due",
  "due_at",
  "hold",
  "approved",
  "approval_matches",
  "approved_at",
  "posted_media_id",
  "posted_permalink",
  "published_at",
  "note",
];
const TEXT_COLUMNS = ["caption", "comment", "comment2", "alt"];

export const exportPlan: Command = {
  name: "export",
  summary: "export [--format json|csv] [--texts]            every plan item, to stdout (default json)",
  async run(ctx: Ctx, args: string[]) {
    const { values } = parsed(() =>
      parseArgs({ args, options: { format: { type: "string", default: "json" }, texts: { type: "boolean" } } }),
    );
    const format = values.format;
    if (format !== "json" && format !== "csv") throw new UsageError("--format must be json or csv");
    const { items } = await (await apiFor(ctx)).get<{ items: Record<string, unknown>[] }>("/v1/export", {
      texts: values.texts ? 1 : undefined,
    });
    // The file is the answer, so --json changes nothing here: json is one of the two formats.
    // In CSV the alt lines share one cell, one per line; JSON keeps the array.
    const flat = items.map((i) => (Array.isArray(i.alt) ? { ...i, alt: i.alt.join("\n") } : i));
    ctx.io.out(
      format === "csv"
        ? csv(flat, values.texts ? [...COLUMNS, ...TEXT_COLUMNS] : COLUMNS)
        : `${JSON.stringify(items, null, 2)}\n`,
    );
    return 0;
  },
};
