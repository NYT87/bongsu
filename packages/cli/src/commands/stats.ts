import { parseArgs } from "node:util";
import { apiFor, UsageError } from "../client";
import { type Command, type Ctx, parsed } from "../ctx";
import { emit, table } from "../output";

const COUNTS = ["views", "reach", "likes", "comments", "saves", "shares", "follows", "profile_visits"];

/** A sample's time: UTC, to the minute (the API answers unix seconds). */
const when = (at: number) => `${new Date(at * 1000).toISOString().slice(0, 16).replace("T", " ")}Z`;

interface Point {
  at: number;
  value: number | null;
}

export const stats: Command = {
  name: "stats",
  summary: "stats <key> | --account id [--daily] [--from d] [--to d]   a post's or an account's metrics series",
  async run(ctx: Ctx, args: string[]) {
    const { values, positionals } = parsed(() =>
      parseArgs({
        args,
        allowPositionals: true,
        options: {
          account: { type: "string" },
          daily: { type: "boolean" },
          from: { type: "string" },
          to: { type: "string" },
        },
      }),
    );
    const key = positionals[0];
    if (!key === !values.account) throw new UsageError("stats takes a post's key or --account <id>");
    const query = { daily: values.daily ? "1" : undefined, from: values.from, to: values.to };
    const api = await apiFor(ctx);
    if (key) {
      const r = await api.get<{ samples: Record<string, number | null>[] }>(
        `/v1/items/${encodeURIComponent(key)}/metrics`,
        query,
      );
      emit(ctx, r, () =>
        r.samples.length
          ? table(
              r.samples.map((p) => ({ ...p, at: when(p.at as number) })),
              ["at", ...COUNTS],
            )
          : "no samples yet\n",
      );
      return 0;
    }
    const r = await api.get<{ followers: Point[]; views: Point[] }>(
      `/v1/accounts/${encodeURIComponent(values.account as string)}/metrics`,
      query,
    );
    const part = (title: string, pts: Point[]) =>
      `${title}\n${
        pts.length
          ? table(
              pts.map((p) => ({ at: when(p.at), value: p.value })),
              ["at", "value"],
            )
          : "none\n"
      }`;
    emit(ctx, r, () => `${part("followers", r.followers)}\n${part("views per day", r.views)}`);
    return 0;
  },
};
