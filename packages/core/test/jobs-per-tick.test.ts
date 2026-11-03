// How many publishing jobs a tick advances: Cloudflare's default unless JOBS_PER_TICK says otherwise, within bounds.
import { describe, expect, it } from "vitest";
import { JOBS_PER_TICK, JOBS_PER_TICK_MAX } from "../src/constants";
import { jobsPerTick } from "../src/tick";

describe("jobsPerTick", () => {
  it("is the Cloudflare default when unset or not a whole number from 1", () => {
    for (const v of [undefined, "", "0", "-3", "2.5", "many"])
      expect(jobsPerTick({ JOBS_PER_TICK: v })).toBe(JOBS_PER_TICK);
  });

  it("takes the setting, capped", () => {
    expect(jobsPerTick({ JOBS_PER_TICK: "12" })).toBe(12);
    expect(jobsPerTick({ JOBS_PER_TICK: "100000" })).toBe(JOBS_PER_TICK_MAX);
  });
});
