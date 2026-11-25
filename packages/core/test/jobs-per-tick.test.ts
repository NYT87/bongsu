// How many publishing jobs a tick advances: the runtime's default (Cloudflare's unless Node gives its own) unless
// JOBS_PER_TICK says otherwise, within bounds.
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

  it("falls back to the runtime's own default when one is given (Node's), not Cloudflare's", () => {
    for (const v of [undefined, "", "0", "many"])
      expect(jobsPerTick({ JOBS_PER_TICK: v, JOBS_PER_TICK_DEFAULT: "20" })).toBe(20);
    expect(jobsPerTick({ JOBS_PER_TICK: "8", JOBS_PER_TICK_DEFAULT: "20" })).toBe(8);
    // a default that isn't a whole number from 1 is ignored
    expect(jobsPerTick({ JOBS_PER_TICK: "x", JOBS_PER_TICK_DEFAULT: "nope" })).toBe(JOBS_PER_TICK);
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

  it("falls back to the runtime's own default when one is given (Node's), not Cloudflare's", () => {
    for (const v of [undefined, "", "x"])
      expect(inboxWorkspacesPerRun({ INBOX_WORKSPACES_PER_RUN: v, INBOX_WORKSPACES_PER_RUN_DEFAULT: "20" })).toBe(20);
    expect(inboxWorkspacesPerRun({ INBOX_WORKSPACES_PER_RUN: "7", INBOX_WORKSPACES_PER_RUN_DEFAULT: "20" })).toBe(7);
  });
});
