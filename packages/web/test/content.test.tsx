// @vitest-environment happy-dom
// The content screens on another host (#145): the dashboard runs the app's screens against /admin-api/content. What a
// host sets: where the API is, and a cache of its own, so two hosts or two workspaces never read each other's answers.
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, setApiBase } from "../src/api";
import { cacheGet, cachePut, type Me, setCacheScope } from "../src/common";
import { applyContent, ContentProviders, contentRoute, useSharedState } from "../src/content";
import { fakeApi } from "./fake-api";

afterEach(() => {
  cleanup();
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

const me: Me = {
  signedIn: true,
  locale: "en",
  timezone: "UTC",
  setupNeeded: false,
  vapidPublicKey: "",
  dryRun: false,
  workspace: { id: "w1", name: "Demo Travel", mediaFolder: "UPLOADS", iconUrl: null },
  you: { name: "Ada", emailName: "ada", displayName: null, shownAs: "Ada" },
};

/** A host of the screens: the shared lists, the person, and one content route's page. */
function Host({ route }: { route: string }) {
  const shared = useSharedState();
  return (
    <ContentProviders me={me} shared={shared}>
      {contentRoute(route, null, () => {})?.page}
    </ContentProviders>
  );
}

describe("the content module", () => {
  it("the content routes and their titles; Settings is the host's own", () => {
    const noop = () => {};
    expect(contentRoute("/queue", null, noop)?.title).toBe("Queue");
    expect(contentRoute("/calendar", null, noop)?.title).toBe("Calendar");
    expect(contentRoute("/stats/youtube/demo_running", null, noop)?.title).toBe("Channel");
    expect(contentRoute("", null, noop)?.title).toBe("Today");
    // an item's page is titled by its name once it's known, else by its key
    expect(contentRoute("/item/reel%3Ax%2Fshort1", { key: "reel:x/short1", title: "Lisbon" }, noop)?.title).toBe(
      "Lisbon",
    );
    expect(contentRoute("/settings", null, noop)).toBeNull();
  });

  it("the content screens run on another host: every call goes to its API, none to the app's", async () => {
    const calls = fakeApi(
      {
        "GET status": { body: { paused: false } },
        "GET queue?days=7": { body: { items: [] } },
        "GET drafts": { body: { drafts: [], accounts: [] } },
        "GET comments/unseen": { body: { n: 0 } },
      },
      "/admin-api/content",
    );
    applyContent({ apiBase: "/admin-api/content", brand: { name: "Demo", themeColor: "#112233" } }, me, []);
    render(<Host route="/queue" />);
    await waitFor(() => expect(calls.map((c) => c.path)).toContain("status"));
    expect(calls.filter((c) => c.path.startsWith("/app-api"))).toEqual([]);
    // and its cache is the host's and the workspace's
    cachePut("x", 1);
    expect(Object.keys(localStorage).some((k) => k.includes(":/admin-api/content|w1:x"))).toBe(true);
  });
});
