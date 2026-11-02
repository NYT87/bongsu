import { describe, expect, it } from "vitest";
import { InstagramProvider } from "../src/providers/instagram-publish";

describe("InstagramProvider.finish", () => {
  it("keeps the media id of a live post when the permalink lookup fails", async () => {
    let published = false;
    const pr = new InstagramProvider({
      id: "instagram-graph",
      trialNote: null,
      publish: async () => {
        published = true;
        return "live-media-id";
      },
      media: async () => {
        throw new Error("temporary outage");
      },
    } as never);
    await expect(pr.finish({ state: "ready", data: { container: "container-1" } })).resolves.toEqual({
      mediaId: "live-media-id",
      permalink: null,
      publishedAt: null,
    });
    expect(published).toBe(true);
  });
});
