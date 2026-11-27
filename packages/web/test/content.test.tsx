// @vitest-environment happy-dom
// The content screens on another host (#145): the dashboard runs the app's screens against /admin-api/content. What a
// host sets: where the API is, and a cache of its own, so two hosts or two workspaces never read each other's answers.
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, setApiBase } from "../src/api";
import { cacheGet, cachePut, setCacheScope } from "../src/common";
import { fakeApi } from "./fake-api";

afterEach(() => {
  vi.unstubAllGlobals();
  setApiBase("/app-api");
  setCacheScope("");
});

describe("a host's API and cache", () => {
  it("the API base decides where every call goes", async () => {
    const calls = fakeApi({ "GET queue": { body: { items: [] } } }, "/admin-api/content");
    setApiBase("/admin-api/content");
    expect(await api("queue")).toEqual({ items: [] });
    setApiBase("/app-api");
    await api("queue").catch(() => null);
    expect(calls.map((c) => c.path)).toEqual(["queue", "/app-api/queue"]);
  });

  it("two scopes never read each other's cache", () => {
    setCacheScope("/app-api|w_a");
    cachePut("queue", 1);
    setCacheScope("/admin-api/content|w_a");
    expect(cacheGet("queue")).toBeNull();
    setCacheScope("/app-api|w_b");
    expect(cacheGet("queue")).toBeNull();
    setCacheScope("/app-api|w_a");
    expect(cacheGet<number>("queue")?.data).toBe(1);
  });
});
