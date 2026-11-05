// A workspace's icon: one PNG per workspace, checked here and kept in the database as base64 (the same on SQLite and
// Postgres). It is served publicly at /icon/<sha256>.png: the URL says nothing about the workspace and changes with
// the icon. SVG and WebP are refused: SVG can carry scripts, WebP needs a parser.

import type { Db } from "./db";

export class IconError extends Error {}

/** The most an icon may weigh (the dashboard refuses a bigger body before reading it as a PNG). */
export const ICON_MAX_BYTES = 204_800;
const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const IHDR = [0x49, 0x48, 0x44, 0x52];
const MIN_PX = 192;
const MAX_PX = 1024;

const u32 = (b: Uint8Array, at: number) => new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(at);

/** Throws an IconError saying why the bytes can't be an icon; else the icon's width (it is square). */
export function checkIcon(bytes: Uint8Array): { width: number } {
  if (bytes.length > ICON_MAX_BYTES) throw new IconError("the icon is over 200 KB");
  const isPng =
    bytes.length >= 24 && SIGNATURE.every((v, i) => bytes[i] === v) && IHDR.every((v, i) => bytes[12 + i] === v);
  if (!isPng) throw new IconError("the icon must be a PNG");
  const width = u32(bytes, 16);
  const height = u32(bytes, 20);
  if (width !== height) throw new IconError(`the icon must be square (it's ${width}×${height})`);
  if (width < MIN_PX || width > MAX_PX)
    throw new IconError(`the icon must be ${MIN_PX} to ${MAX_PX} pixels wide (it's ${width})`);
  return { width };
}

/** base64 without Buffer; chunked so 200 KB doesn't overflow the call stack. */
function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(text: string): Uint8Array {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function hashOf(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Checks and stores the workspace's icon (replacing the old one); returns the hash its URL is built from. */
export async function setIcon(db: Db, workspaceId: string, bytes: Uint8Array, nowS: number): Promise<string> {
  checkIcon(bytes);
  const hash = await hashOf(bytes);
  await db
    .prepare(
      `INSERT INTO workspace_icons (workspace_id, png, hash, updated_at) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (workspace_id) DO UPDATE SET png = excluded.png, hash = excluded.hash, updated_at = excluded.updated_at`,
    )
    .bind(workspaceId, toBase64(bytes), hash, nowS)
    .run();
  return hash;
}

/** Whether the workspace had an icon. */
export async function removeIcon(db: Db, workspaceId: string): Promise<boolean> {
  const gone = await db
    .prepare("DELETE FROM workspace_icons WHERE workspace_id = ?1 RETURNING workspace_id")
    .bind(workspaceId)
    .first();
  return !!gone;
}

/** The icon hash of each of the workspaces that has one. */
export async function iconHashes(db: Db, workspaceIds: string[]): Promise<Map<string, string>> {
  if (!workspaceIds.length) return new Map();
  const marks = workspaceIds.map((_, i) => `?${i + 1}`).join(", ");
  const { results } = await db
    .prepare(`SELECT workspace_id, hash FROM workspace_icons WHERE workspace_id IN (${marks})`)
    .bind(...workspaceIds)
    .all<{ workspace_id: string; hash: string }>();
  return new Map(results.map((r) => [r.workspace_id, r.hash]));
}

/** The PNG with this hash (any workspace's: equal bytes are equal), or null. */
export async function iconByHash(db: Db, hash: string): Promise<Uint8Array | null> {
  const row = await db
    .prepare("SELECT png FROM workspace_icons WHERE hash = ?1 LIMIT 1")
    .bind(hash)
    .first<{ png: string }>();
  return row ? fromBase64(row.png) : null;
}

/** The icon's absolute URL (pushes need it absolute), or null without an icon. */
export function iconUrl(publicUrl: string, hash: string | undefined | null): string | null {
  return hash ? `${publicUrl}/icon/${hash}.png` : null;
}

/** `workspace` and `workspaces` with each one's `iconUrl` (null without one), from one query for all of them. */
export async function withIconUrls<W extends { id: string }, L extends { id: string }>(
  db: Db,
  publicUrl: string,
  workspace: W | null,
  workspaces: L[],
) {
  const ids = [...new Set([...(workspace ? [workspace.id] : []), ...workspaces.map((w) => w.id)])];
  const hashes = await iconHashes(db, ids);
  const add = <T extends { id: string }>(w: T) => ({ ...w, iconUrl: iconUrl(publicUrl, hashes.get(w.id)) });
  return { workspace: workspace && add(workspace), workspaces: workspaces.map(add) };
}
