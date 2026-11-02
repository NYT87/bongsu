// The instance's media store (one per instance for now: MEDIA_STORE, default "drive"). Code that needs media asks for
// it here and only uses the MediaStore interface.
import type { Env } from "../env";
import { DriveStore } from "./drive";
import type { MediaRef, MediaStore } from "./store";

/** The instance's store id, without building the store. */
export const storeId = (env: Pick<Env, "MEDIA_STORE">) => env.MEDIA_STORE ?? "drive";

/** Stores a runtime adds (the Node app registers "local", a directory on the server): they live outside core so the
 *  Workers bundle never imports Node-only code. */
const registered = new Map<string, (env: Env, fetcher: typeof fetch) => MediaStore>();
export function registerStore(kind: string, make: (env: Env, fetcher: typeof fetch) => MediaStore) {
  registered.set(kind, make);
}

export function mediaStore(env: Env, fetcher: typeof fetch): MediaStore {
  const kind = storeId(env);
  if (kind === "drive")
    return new DriveStore({ saJson: env.DRIVE_SA_JSON, fetch: fetcher, ownerOauth: env.DRIVE_OWNER_OAUTH, db: env.DB });
  const make = registered.get(kind);
  if (make) return make(env, fetcher);
  throw new Error(`unknown MEDIA_STORE ${kind}`);
}

/** Whether a reference points into this store (approvals made on another store need approving again). */
export const inStore = (store: MediaStore, ref: Pick<MediaRef, "store">) => ref.store === store.id;
