import { parseArgs } from "node:util";
import { apiFor, UsageError } from "../client";
import { type Command, type Ctx, parsed } from "../ctx";
import { emit, table } from "../output";

export interface QueueItem {
  key: string;
  account: string;
  due: string | null;
  due_at: string | null;
  hold: boolean;
  approved: boolean;
  approval_matches_schedule: boolean;
  [field: string]: unknown;
}

export interface QueueAnswer {
  timezone: string;
  until: string;
  items: QueueItem[];
}

/** The queue lists only what is still to come, so an item is held, approved (for this time or another) or not. */
export function stateOf(i: QueueItem): string {
  if (i.hold) return "held";
  if (i.approved) return i.approval_matches_schedule ? "approved" : "approved (time changed)";
  return "not approved";
}

function days(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw) || Number(raw) < 1) throw new UsageError("--days must be a whole number of days");
  return Number(raw);
}

export const queue: Command = {
  name: "queue",
  summary: "queue [--days n] [--account id]              what is due next and whether it's approved",
  async run(ctx: Ctx, args: string[]) {
    const { values } = parsed(() =>
      parseArgs({ args, options: { days: { type: "string" }, account: { type: "string" } } }),
    );
    const q = await (await apiFor(ctx)).get<QueueAnswer>("/v1/queue", {
      days: days(values.days),
      account: values.account,
    });
    emit(ctx, q, () =>
      q.items.length
        ? table(
            q.items.map((i) => ({ ...i, state: stateOf(i) })),
            ["due", "account", "key", "state"],
          )
        : `nothing due until ${q.until}\n`,
    );
    return 0;
  },
};
