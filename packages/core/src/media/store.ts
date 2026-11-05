// Where the media lives (docs/PLAN.md 2.4, docs/media-stores.md). The database only references files in a store the
// owner controls; Drive is the first one. Paths are logical ("UPLOADS/inbox/<project>"), relative to the store's root.
// Nothing here deletes: posted media is moved aside, never removed.

/** A file in a store, as approvals and plan items record it. `checksum` is whatever the store guarantees (Drive's
 *  md5, an S3 ETag, a sha256): it's only compared for equality, so changing stores means approving again. */
export interface MediaRef {
  store: string;
  id: string;
  checksum: string;
}

export interface MediaEntry {
  id: string;
  name: string;
  mime: string;
  size: number;
  /** Empty while the store hasn't computed it yet (Drive, right after an upload). */
  checksum: string;
  /** ISO 8601. */
  modifiedAt: string;
  folder: boolean;
  /** The folder it's in (null at the store's root, or when the store doesn't say). */
  parent: string | null;
}

export interface UploadTarget {
  url: string;
  method: "PUT" | "POST";
  headers: Record<string, string>;
  /** The new file's id when the store knows it before the upload (S3: its key); otherwise the upload's last answer
   *  names it (Drive). */
  id?: string;
  /** Sent in pieces with Content-Range (a Drive resumable session), or as one request (a presigned PUT). */
  chunked: boolean;
}

/** A refused write (no permission): recorded and reported once, never retried. Anything else throws a plain Error. */
export class MediaRefused extends Error {}

export interface MediaStore {
  readonly id: string;
  /** null when missing or trashed. */
  stat(id: string): Promise<MediaEntry | null>;
  /** The bytes, honouring a Range header ("bytes=0-99"): 206 with Content-Range for a range, 404 when missing. */
  stream(id: string, range?: string | null): Promise<Response>;
  /** A small text file (captions dropped next to the media), at most 20,000 characters. */
  readText(id: string): Promise<string>;
  /** The file or folder at a logical path, or null. */
  resolve(path: string): Promise<MediaEntry | null>;
  /** Whether the file or folder is anywhere below the folder at a path (not the folder itself): what keeps a
   *  workspace's references inside its own media folder. False when the folder doesn't exist. */
  inside(id: string, folderPath: string): Promise<boolean>;
  /** What's directly inside a folder. */
  list(folderId: string): Promise<MediaEntry[]>;
  /** The folder at a path, created (with its parents) when missing; returns its id. */
  ensureFolder(path: string): Promise<string>;
  /** Moves a file or a folder (with its contents) into the folder at a path, created when missing. Throws MediaRefused
   *  when the store says no. */
  move(id: string, toFolderPath: string): Promise<void>;
  /** A URL the platform can fetch directly for `ttlS` seconds (presigned). Without it, the signed /m/ proxy streams. */
  publicUrl?(id: string, ttlS: number): Promise<string>;
  /** Where the browser uploads a new file into a folder path. Without it, the app hides the upload button. */
  createUpload?(name: string, folderPath: string, mime: string, origin: string): Promise<UploadTarget>;
}

export const isMedia = (e: Pick<MediaEntry, "mime">) => /^(image|video)\//.test(e.mime);
export const isVideo = (e: Pick<MediaEntry, "mime">) => e.mime.startsWith("video/");
