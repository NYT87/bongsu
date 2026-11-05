// A workspace's media folder: the one folder of the media store its files live in (workspace_settings.media_folder),
// unique among workspaces so two never share files. The name is a single path segment, so it can't climb out.

import type { Db } from "../db";

export class FolderError extends Error {}

const MAX = 60;
const ALLOWED = /^[A-Za-z0-9_ -]+$/;

/** `<folder>` or `<folder>/<rest>`: a path inside a workspace's folder, `rest` without a leading slash. */
export const mediaPath = (folder: string, rest = ""): string => {
  const r = rest.replace(/^\/+/, "");
  return r ? `${folder}/${r}` : folder;
};

/** The trimmed name when it can be a folder: 1 to 60 letters, digits, `-`, `_` and spaces, not `.` or `..`. */
export function checkFolderName(name: string): string {
  const n = name.trim();
  if (!n) throw new FolderError("the folder needs a name");
  if (n.length > MAX) throw new FolderError(`the folder's name is at most ${MAX} characters`);
  if (n === "." || n === ".." || !ALLOWED.test(n))
    throw new FolderError("the folder's name may hold letters, digits, - _ and spaces");
  return n;
}

/** A folder name for a workspace's name: lowercase, spaces as dashes, anything else not allowed dropped. */
export function folderSlug(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/ /g, "-")
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, MAX);
  return s || "workspace";
}

/** `base`, else `base-2`, `base-3`… the first no other workspace uses (`exceptWorkspace`'s own doesn't count). */
export async function uniqueFolder(db: Db, base: string, exceptWorkspace = ""): Promise<string> {
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? "" : `-${n}`;
    const name = `${base.slice(0, MAX - suffix.length)}${suffix}`;
    if (!(await folderTaken(db, name, exceptWorkspace))) return name;
  }
}

/** Whether another workspace has the name as its folder. */
export async function folderTaken(db: Db, name: string, exceptWorkspace = ""): Promise<boolean> {
  return !!(await db
    .prepare("SELECT 1 FROM workspace_settings WHERE media_folder = ?1 AND workspace_id <> ?2")
    .bind(name, exceptWorkspace)
    .first());
}
