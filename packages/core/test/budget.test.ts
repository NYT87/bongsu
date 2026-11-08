import { describe, expect, it, vi } from "vitest";
import { BudgetSpent, runBudget, runSubrequests } from "../src/budget";

describe("runSubrequests", () => {
  it("defaults to 50 when unset", () => {
    expect(runSubrequests({})).toEqual({ value: 50, source: "default", invalid: null });
  });
  it("takes a number in range", () => {
    expect(runSubrequests({ RUN_SUBREQUESTS: "200" })).toEqual({ value: 200, source: "variable", invalid: null });
  });
  it("takes unlimited", () => {
    expect(runSubrequests({ RUN_SUBREQUESTS: "unlimited" })).toEqual({
      value: Number.POSITIVE_INFINITY,
      source: "variable",
      invalid: null,
    });
  });
  it.each(["5", "abc", "20000000"])("falls back to 50 for %s and reports it", (bad) => {
    expect(runSubrequests({ RUN_SUBREQUESTS: bad })).toEqual({ value: 50, source: "default", invalid: bad });
  });
});

describe("runBudget", () => {
  const make = (limit: number) => {
    const f = vi.fn(async () => new Response("ok"));
    return { f, run: runBudget(limit, f as unknown as typeof fetch) };
  };

  it("gives each step a fair share and re-shares what is left", async () => {
    const { run } = make(50);
    const a = run.step("a", 3);
    expect(a.left()).toBe(14);
    for (let i = 0; i < 4; i++) await a.fetch("https://example.com");
    expect(a.used()).toBe(4);
    expect(run.step("b", 2).left()).toBe(20);
    expect(run.used()).toBe(4);
    expect(run.left()).toBe(46);
  });

  it("stops a step at its share without calling fetch", async () => {
    const { f, run } = make(50);
    const a = run.step("a", 3);
    for (let i = 0; i < 14; i++) await a.fetch("https://example.com");
    await expect(a.fetch("https://example.com")).rejects.toThrow(BudgetSpent);
    await expect(a.fetch("https://example.com")).rejects.toThrow(/a/);
    expect(f).toHaveBeenCalledTimes(14);
    expect(run.stopped()).toEqual(["a"]);
  });

  it("canAfford agrees with fetch and records a refusal", async () => {
    const { run } = make(50);
    const a = run.step("a", 3);
    for (let i = 0; i < 12; i++) await a.fetch("https://example.com");
    expect(a.canAfford(2)).toBe(true);
    expect(run.stopped()).toEqual([]);
    expect(a.canAfford(3)).toBe(false);
    expect(run.stopped()).toEqual(["a"]);
    await a.fetch("https://example.com");
    await a.fetch("https://example.com");
    await expect(a.fetch("https://example.com")).rejects.toThrow(BudgetSpent);
    expect(run.stopped()).toEqual(["a"]);
  });

  it("counts the run's own fetch, and never lets a step past the limit", async () => {
    const { f, run } = make(20);
    for (let i = 0; i < 10; i++) await run.fetch("https://example.com");
    expect(run.used()).toBe(10);
    const a = run.step("a", 1);
    expect(a.left()).toBe(4);
    for (let i = 0; i < 4; i++) await a.fetch("https://example.com");
    await expect(a.fetch("https://example.com")).rejects.toThrow(BudgetSpent);
    expect(f).toHaveBeenCalledTimes(14);
  });

  it("is unbounded for Infinity", async () => {
    const { run } = make(Number.POSITIVE_INFINITY);
    const a = run.step("a", 3);
    expect(a.left()).toBe(Number.POSITIVE_INFINITY);
    expect(run.left()).toBe(Number.POSITIVE_INFINITY);
    expect(a.canAfford(1_000_000)).toBe(true);
    for (let i = 0; i < 1000; i++) await a.fetch("https://example.com");
    expect(a.used()).toBe(1000);
    expect(run.stopped()).toEqual([]);
  });
});
