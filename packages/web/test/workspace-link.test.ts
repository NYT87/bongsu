import { describe, expect, it } from "vitest";
import { takeWorkspaceParam } from "../src/workspace-link";

// A push opens /?w=<id>#/item/… (core/notify.ts withWorkspace): the app takes `w` off the URL before it routes.

describe("takeWorkspaceParam", () => {
  it("takes w and leaves the route", () => {
    expect(takeWorkspaceParam({ search: "?w=w2", hash: "#/item/reel%3Ax" })).toEqual({
      w: "w2",
      cleaned: "/#/item/reel%3Ax",
    });
  });

  it("answers null and leaves the URL as it is without w", () => {
    expect(takeWorkspaceParam({ search: "", hash: "#/queue" })).toEqual({ w: null, cleaned: "/#/queue" });
    expect(takeWorkspaceParam({ search: "?a=1", hash: "#/" })).toEqual({ w: null, cleaned: "/?a=1#/" });
  });

  it("keeps the other params", () => {
    expect(takeWorkspaceParam({ search: "?a=1&w=w2&b=2", hash: "#/item/x" })).toEqual({
      w: "w2",
      cleaned: "/?a=1&b=2#/item/x",
    });
  });

  it("ignores an empty w", () => {
    expect(takeWorkspaceParam({ search: "?w=", hash: "" })).toEqual({ w: null, cleaned: "/" });
  });

  it("keeps the path it was given", () => {
    expect(takeWorkspaceParam({ pathname: "/app/", search: "?w=w2", hash: "" }).cleaned).toBe("/app/");
  });
});
