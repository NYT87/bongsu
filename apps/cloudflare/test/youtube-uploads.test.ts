import { env } from "cloudflare:workers";
import { addApproval, latestApprovals } from "@bongsu/core/data";
import { describe, expect, it } from "vitest";

describe("YouTube uploads: data", () => {
  it("an approval keeps its texts fingerprint", async () => {
    const base = {
      account: "demo_channel",
      dueAt: 1000,
      captionSha256: "a".repeat(64),
      commentSha256: null,
      altSha256: null,
      media: [],
      approvedAt: "2026-10-20T00:00:00Z",
      approvedBy: "owner@app",
    };
    await addApproval(env.DB, { ...base, key: "yt-with", textsSha256: "f".repeat(64) });
    await addApproval(env.DB, { ...base, key: "yt-without" });
    const got = await latestApprovals(env.DB, ["yt-with", "yt-without"]);
    expect(got.get("yt-with")?.textsSha256).toBe("f".repeat(64));
    expect(got.get("yt-without")?.textsSha256).toBeNull();
  });
});
