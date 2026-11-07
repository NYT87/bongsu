// Where a YouTube upload is, for the item page: read from the job's step (providers/youtube.ts UploadData), which
// the tick keeps between runs. Instagram jobs have no phases, so they show none.
import { YOUTUBE_LOCKED } from "./texts/notifications";

export type UploadProgress =
  | { phase: "uploading"; percent: number }
  | { phase: "extras" }
  | { phase: "processing" }
  | { phase: "ready"; at: number }
  | { phase: "locked" }
  | null;

export function uploadProgress(job: {
  state: string;
  due_at: number;
  last_error: string | null;
  payload: string;
}): UploadProgress {
  // the audit lock is a failure the owner can only fix in Google's console, so it stays on the page
  if (job.state === "failed") return job.last_error?.startsWith(YOUTUBE_LOCKED) ? { phase: "locked" } : null;
  // the steps run while the job is container_created; before (pending) and after (published, done) there's none
  if (job.state !== "container_created") return null;
  let data: Record<string, unknown> | undefined;
  try {
    data = JSON.parse(job.payload)?.step?.data;
  } catch {
    return null;
  }
  switch (data?.phase) {
    case "uploading": {
      // offset is what YouTube confirmed it holds, so the share never runs ahead of the upload
      const size = Number(data.size);
      const offset = Number(data.offset ?? 0);
      const percent = size > 0 && Number.isFinite(offset) ? Math.floor((Math.min(offset, size) / size) * 100) : 0;
      return { phase: "uploading", percent };
    }
    case "extras":
      return { phase: "extras" };
    case "processing":
      return { phase: "processing" };
    case "waiting":
      return { phase: "ready", at: job.due_at };
    default:
      return null;
  }
}
