import { describe, expect, it } from "vitest";
import { YOUTUBE_LOCKED } from "../src/texts/notifications";
import { uploadProgress } from "../src/upload-progress";

const job = (state: string, data: Record<string, unknown> | null, last_error: string | null = null) => ({
  state,
  due_at: 1_800_000_000,
  last_error,
  payload: JSON.stringify(data === null ? {} : { username: "main", step: { state: "processing", data } }),
});

describe("uploadProgress", () => {
  it("reads the upload's share from offset ÷ size", () => {
    expect(uploadProgress(job("container_created", { phase: "uploading", size: 100, offset: 40 }))).toEqual({
      phase: "uploading",
      percent: 40,
    });
    // before YouTube confirmed a byte, and never over 100
    expect(uploadProgress(job("container_created", { phase: "uploading", size: 100 }))).toEqual({
      phase: "uploading",
      percent: 0,
    });
    expect(uploadProgress(job("container_created", { phase: "uploading", size: 3, offset: 3 }))).toEqual({
      phase: "uploading",
      percent: 100,
    });
  });

  it("names the extras and processing phases", () => {
    expect(uploadProgress(job("container_created", { phase: "extras", size: 1 }))).toEqual({ phase: "extras" });
    expect(uploadProgress(job("container_created", { phase: "processing", size: 1 }))).toEqual({
      phase: "processing",
    });
  });

  it("a waiting video is ready and goes public at the job's due time", () => {
    expect(uploadProgress(job("container_created", { phase: "waiting", size: 1, videoId: "v1" }))).toEqual({
      phase: "ready",
      at: 1_800_000_000,
    });
  });

  it("a job failed on YouTube's audit is locked; any other failure isn't progress", () => {
    expect(uploadProgress(job("failed", { phase: "waiting", size: 1 }, YOUTUBE_LOCKED))).toEqual({ phase: "locked" });
    expect(uploadProgress(job("failed", { phase: "uploading", size: 1 }, "quota"))).toBeNull();
  });

  it("an Instagram job, a job not started and a finished one have none", () => {
    expect(uploadProgress(job("container_created", { containerId: "c1" }))).toBeNull();
    expect(uploadProgress(job("pending", null))).toBeNull();
    expect(uploadProgress(job("published", { phase: "waiting", size: 1 }))).toBeNull();
    expect(uploadProgress({ state: "container_created", due_at: 1, last_error: null, payload: "not json" })).toBeNull();
  });
});
