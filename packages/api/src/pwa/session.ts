// Sessions for the two apps: an HttpOnly, Secure, SameSite=Strict cookie with a random token; D1 keeps its sha256.
// Each app has its own cookie and its own rows (sessions.app), so signing in to one never signs into or out of the
// other: the PWA's (`bongsu_session`) lasts 30 days on the phone; the dashboard's (`bongsu_admin`) 12 hours.
import type { Db } from "@bongsu/core/db";
import { sha256Hex } from "@bongsu/core/formats/approved";

export type App = "pwa" | "dashboard";
export const COOKIE: Record<App, string> = { pwa: "bongsu_session", dashboard: "bongsu_admin" };
export const SESSION_S: Record<App, number> = { pwa: 30 * 86400, dashboard: 12 * 3600 };
export const SESSION_DAYS = 30;

export interface Session {
  userId: string;
  app: App;
  /** The last passkey check (sign-in or a fresh check), unix seconds. */
  verifiedAt: number;
  /** The workspace the session works in (sessions.workspace_id), null for the user's first (core/workspaces.ts
   *  sessionWorkspace checks it on every request). */
  workspaceId: string | null;
}

const b64url = (b: Uint8Array) =>
  btoa(String.fromCharCode(...b))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
export const randomToken = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));

export async function createSession(db: Db, nowS: number, o: { app?: App; userId?: string } = {}): Promise<string> {
  const app = o.app ?? "pwa";
  const token = randomToken();
  await db
    .prepare(
      "INSERT INTO sessions (token_hash, created_at, expires_at, user_id, app, verified_at) VALUES (?1, ?2, ?3, ?4, ?5, ?2)",
    )
    .bind(await sha256Hex(token), nowS, nowS + SESSION_S[app], o.userId ?? "owner", app)
    .run();
  await db.prepare("DELETE FROM sessions WHERE expires_at < ?1").bind(nowS).run();
  return token;
}

export function sessionCookie(token: string, maxAge?: number, app: App = "pwa"): string {
  return `${COOKIE[app]}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge ?? SESSION_S[app]}`;
}

export function readCookie(header: string | null | undefined, app: App = "pwa"): string | null {
  for (const part of (header ?? "").split(/;\s*/)) {
    const [k, v] = part.split("=");
    if (k === COOKIE[app] && v) return v;
  }
  return null;
}

/** The session behind a token, for that app; null when there's none (or it expired). */
export async function validSession(
  db: Db,
  token: string | null,
  nowS: number,
  app: App = "pwa",
): Promise<Session | null> {
  if (!token || !/^[A-Za-z0-9_-]{20,}$/.test(token)) return null;
  const row = await db
    .prepare(
      "SELECT expires_at, user_id, app, verified_at, created_at, workspace_id FROM sessions WHERE token_hash = ?1 AND app = ?2",
    )
    .bind(await sha256Hex(token), app)
    .first<{
      expires_at: number;
      user_id: string;
      app: App;
      verified_at: number | null;
      created_at: number;
      workspace_id: string | null;
    }>();
  if (!row || row.expires_at <= nowS) return null;
  return {
    userId: row.user_id,
    app: row.app,
    verifiedAt: row.verified_at ?? row.created_at,
    workspaceId: row.workspace_id ?? null,
  };
}

/** A fresh passkey check on this session. */
export async function markVerified(db: Db, token: string, nowS: number) {
  await db
    .prepare("UPDATE sessions SET verified_at = ?1 WHERE token_hash = ?2")
    .bind(nowS, await sha256Hex(token))
    .run();
}

/** The workspace this session works in from now on (the Workspaces page's "open", later the switcher). */
export async function setSessionWorkspace(db: Db, token: string, workspaceId: string): Promise<void> {
  await db
    .prepare("UPDATE sessions SET workspace_id = ?1 WHERE token_hash = ?2")
    .bind(workspaceId, await sha256Hex(token))
    .run();
}

export async function endSession(db: Db, token: string | null) {
  if (token)
    await db
      .prepare("DELETE FROM sessions WHERE token_hash = ?1")
      .bind(await sha256Hex(token))
      .run();
}
