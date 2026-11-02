import { parseArgs } from "node:util";
import { apiFor } from "../client";
import { type Command, type Ctx, parsed } from "../ctx";
import { emit } from "../output";

export interface StatusAnswer {
  dry_run: boolean;
  paused: boolean;
  today: string;
  timezone: string;
  jobs_last_7_days: { state: string; mode: string; n: number }[];
  accounts: string[];
}

function summary(s: StatusAnswer): string {
  const jobs = s.jobs_last_7_days.map((j) => `${j.n} ${j.state}${j.mode === "dry" ? " (dry run)" : ""}`);
  return [
    `publishing: ${s.paused ? "paused" : "on"}${s.dry_run ? " (dry run: nothing reaches the platforms)" : ""}`,
    `today:      ${s.today} (${s.timezone})`,
    `accounts:   ${s.accounts.length ? s.accounts.join(", ") : "none"}`,
    `jobs, last 7 days: ${jobs.length ? jobs.join(", ") : "none"}`,
    "",
  ].join("\n");
}

export const status: Command = {
  name: "status",
  summary: "status                                       paused or not, today, accounts, recent jobs",
  async run(ctx: Ctx, args: string[]) {
    parsed(() => parseArgs({ args, options: {} }));
    const s = await (await apiFor(ctx)).get<StatusAnswer>("/v1/status");
    emit(ctx, s, () => summary(s));
    return 0;
  },
};
