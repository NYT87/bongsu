// How many publishing jobs a tick advances: Cloudflare's default unless JOBS_PER_TICK says otherwise, within bounds.
import { describe, expect, it } from "vitest";
import {
  INBOX_WORKSPACES_PER_RUN,
  INBOX_WORKSPACES_PER_RUN_MAX,
  JOBS_PER_TICK,
  JOBS_PER_TICK_MAX,
} from "../src/constants";
import { inboxWorkspacesPerRun } from "../src/inbox";
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

describe("inboxWorkspacesPerRun", () => {
  it("is the default unless the setting is a whole number from 1, capped", () => {
    for (const v of [undefined, "", "0", "x", "2.5"])
      expect(inboxWorkspacesPerRun({ INBOX_WORKSPACES_PER_RUN: v })).toBe(INBOX_WORKSPACES_PER_RUN);
    expect(inboxWorkspacesPerRun({ INBOX_WORKSPACES_PER_RUN: "7" })).toBe(7);
    expect(inboxWorkspacesPerRun({ INBOX_WORKSPACES_PER_RUN: "500" })).toBe(INBOX_WORKSPACES_PER_RUN_MAX);
  });
});
