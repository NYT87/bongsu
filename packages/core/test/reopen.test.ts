import { describe, expect, it } from "vitest";
import { type Payload, reopens } from "../src/tick";

// Which closed jobs a new approval brings back (#148): failed ones too, but never one that may already be live.
const FAILED_AT = Date.UTC(2026, 9, 20, 9, 0, 0) / 1000;
const p = (o: Partial<Payload> = {}): Payload => ({
  queueDir: "",
  account: "conn",
  igUserId: "1",
  postedKey: "k",
  location: "",
  captionPath: "",
  commentPath: "",
  approvedAt: "2026-10-17T01:00:00Z",
  ...o,
});
const after = { dueAt: 1, approvedAt: "2026-10-20T09:05:00Z" };
const failed = { state: "failed", media_id: null, updated_at: FAILED_AT };

describe("reopens", () => {
  it("brings back a refused job on a newer approval line, and a held one on its release", () => {
    expect(reopens({ state: "refused" }, p(), after)).toBe(true);
    expect(reopens({ state: "refused" }, p(), { dueAt: 1, approvedAt: "2026-10-17T01:00:00Z" })).toBe(false);
    expect(reopens({ state: "held" }, p({ onHold: true }), { dueAt: 1, approvedAt: "2026-10-17T01:00:00Z" })).toBe(
      true,
    );
  });

  it("brings back a failed job on an approval made after the failure", () => {
    expect(reopens(failed, p(), after)).toBe(true);
  });

  it("leaves a failed job failed on an approval made before (or as) it failed", () => {
    expect(reopens(failed, p(), { dueAt: 1, approvedAt: "2026-10-20T08:59:00Z" })).toBe(false);
    expect(reopens(failed, p(), { dueAt: 1, approvedAt: "2026-10-20T09:00:00Z" })).toBe(false);
    expect(reopens(failed, p(), { dueAt: 1, approvedAt: "not a date" })).toBe(false);
    expect(reopens({ state: "failed" }, p(), after)).toBe(false); // no failure time known
  });

  it("never brings back a failed job that may have gone live", () => {
    expect(reopens({ ...failed, media_id: "media-1" }, p(), after)).toBe(false);
    expect(reopens(failed, p({ mediaId: "media-1" }), after)).toBe(false);
    expect(reopens(failed, p({ publishing: true }), after)).toBe(false);
  });

  it("never brings back a refused or held job that may have gone live", () => {
    expect(reopens({ state: "refused" }, p({ publishing: true }), after)).toBe(false);
    expect(reopens({ state: "refused", media_id: "media-1" }, p(), after)).toBe(false);
    expect(reopens({ state: "held" }, p({ publishing: true }), after)).toBe(false);
    expect(reopens({ state: "held" }, p({ onHold: true, publishing: true }), after)).toBe(false);
  });

  it("brings back a private upload made ahead of its time on a newer approval, never an Instagram container", () => {
    const upload = (data: Record<string, unknown>, o: Partial<Payload> = {}) =>
      p({ step: { state: "ready", data }, ...o });
    const running = { state: "container_created" };
    const older = { ...after, approvedAt: "2026-10-17T01:00:00Z" };
    expect(reopens(running, upload({ phase: "waiting", videoId: "vid-1" }), after)).toBe(true);
    expect(reopens(running, upload({ phase: "uploading", session: "https://upload.example.com/s" }), after)).toBe(true);
    expect(reopens(running, upload({ phase: "waiting", videoId: "vid-1" }), older)).toBe(false);
    expect(reopens(running, upload({ phase: "waiting", videoId: "vid-1" }, { publishing: true }), after)).toBe(false);
    expect(reopens(running, upload({ container: "container-1" }), after)).toBe(false);
  });

  it("ignores a revoked approval and jobs that aren't closed", () => {
    expect(reopens(failed, p(), { dueAt: null, approvedAt: after.approvedAt })).toBe(false);
    for (const state of ["pending", "container_created", "published", "done"])
      expect(reopens({ state, updated_at: FAILED_AT }, p(), after)).toBe(false);
  });
});
