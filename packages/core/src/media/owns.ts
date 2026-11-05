// A reference to a file only counts when the file is in the caller's workspace: below its media folder in an
// instance store, or anywhere in a store that is the workspace's own. Everything that takes file references from a
// caller (the agent API, the app's drafts, scheduling) asks here, so one workspace can't publish, list or link another's.
import type { MediaStores } from "./index";
import type { MediaRef } from "./store";

/** The refusal for a foreign reference. */
export class MediaError extends Error {
  constructor(
    public status: 400,
    msg: string,
  ) {
    super(msg);
  }
}

export const NOT_OURS = "not in this workspace's media";
const TIMEOUT_MS = 10_000;

/** Whether the file is the workspace's: false for a store that isn't set up, and for any error or timeout. */
export async function ownsRef(
  stores: MediaStores,
  folder: string,
  ref: Pick<MediaRef, "store" | "id">,
): Promise<boolean> {
  const store = stores.get(ref.store);
  if (!store) return false;
  if (stores.isOwn(ref.store)) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      store.inside(ref.id, folder),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), TIMEOUT_MS);
      }),
    ]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Throws MediaError(400) unless every reference is the workspace's. */
export async function assertOwns(
  stores: MediaStores,
  folder: string,
  refs: Pick<MediaRef, "store" | "id">[],
): Promise<void> {
  for (const r of refs) if (!(await ownsRef(stores, folder, r))) throw new MediaError(400, NOT_OURS);
}
