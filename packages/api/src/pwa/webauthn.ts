// Passkeys (sign-in to the PWA and the dashboard, a fresh assertion for every approval), with @simplewebauthn/server.
// Each belongs to a user (passkeys.user_id); the PWA's single owner is the user "owner".
// The verify functions are injectable so tests can stand in for a real authenticator.
import type { Db } from "@bongsu/core/db";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { randomToken } from "./session";

export interface Verifiers {
  registration: typeof verifyRegistrationResponse;
  authentication: typeof verifyAuthenticationResponse;
}
export const realVerifiers: Verifiers = {
  registration: verifyRegistrationResponse,
  authentication: verifyAuthenticationResponse,
};

const CHALLENGE_TTL_S = 300;
const fromB64url = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const toB64url = (b: Uint8Array) =>
  btoa(String.fromCharCode(...b))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

interface PasskeyRow {
  id: string;
  public_key: string;
  counter: number;
  transports: string | null;
  user_id: string;
}

async function saveChallenge(db: Db, challenge: string, purpose: string, data: unknown, nowS: number): Promise<string> {
  const id = randomToken(16);
  await db
    .prepare("INSERT INTO challenges (id, challenge, purpose, data, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)")
    .bind(id, challenge, purpose, data === undefined ? null : JSON.stringify(data), nowS + CHALLENGE_TTL_S)
    .run();
  await db.prepare("DELETE FROM challenges WHERE expires_at < ?1").bind(nowS).run();
  return id;
}

/** Takes (deletes) a challenge: each one can be answered once. */
export async function takeChallenge(
  db: Db,
  id: string,
  purpose: string,
  nowS: number,
): Promise<{ challenge: string; data: unknown } | null> {
  const row = await db
    .prepare("DELETE FROM challenges WHERE id = ?1 AND purpose = ?2 AND expires_at >= ?3 RETURNING challenge, data")
    .bind(id, purpose, nowS)
    .first<{ challenge: string; data: string | null }>();
  return row ? { challenge: row.challenge, data: row.data ? JSON.parse(row.data) : null } : null;
}

/** Who a new passkey is for (the owner by default; a dashboard user by email). */
export interface PasskeyUser {
  id: string;
  name?: string | null;
  email?: string | null;
}

export async function registrationOptions(
  db: Db,
  rpID: string,
  nowS: number,
  data?: unknown,
  user: PasskeyUser = { id: "owner" },
) {
  const existing = await db
    .prepare("SELECT id, transports FROM passkeys WHERE user_id = ?1")
    .bind(user.id)
    .all<{ id: string; transports: string | null }>();
  const options = await generateRegistrationOptions({
    rpName: "Bongsu",
    rpID,
    userName: user.email ?? user.id,
    userDisplayName: user.name ?? (user.id === "owner" ? "Owner" : user.id),
    attestationType: "none",
    userID: Uint8Array.from(new TextEncoder().encode(`bongsu-${user.id}`)),
    excludeCredentials: existing.results.map((r) => ({
      id: r.id,
      transports: r.transports ? JSON.parse(r.transports) : undefined,
    })),
    authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
  });
  return { options, challengeId: await saveChallenge(db, options.challenge, "setup", data, nowS) };
}

/** Verifies a new passkey; `claim(data)` runs first with the challenge's bound data (e.g. to use up the setup code)
 *  and can veto. */
export async function verifyRegistration(
  db: Db,
  v: Verifiers,
  rpID: string,
  origin: string,
  challengeId: string,
  response: unknown,
  name: string,
  nowS: number,
  claim: (data: unknown) => Promise<boolean> = async () => true,
  userId = "owner",
): Promise<boolean> {
  const ch = await takeChallenge(db, challengeId, "setup", nowS);
  if (!ch) return false;
  const r = await v.registration({
    response: response as never,
    expectedChallenge: ch.challenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    requireUserVerification: true,
  });
  if (!r.verified || !(await claim(ch.data))) return false;
  const c = r.registrationInfo.credential;
  // a setup code made in the dashboard names its user in the challenge's data
  const owner = (ch.data as { userId?: string } | null)?.userId ?? userId;
  await db
    .prepare(
      "INSERT INTO passkeys (id, public_key, counter, transports, name, created_at, user_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
    )
    .bind(
      c.id,
      toB64url(c.publicKey),
      c.counter,
      c.transports ? JSON.stringify(c.transports) : null,
      name.slice(0, 60),
      nowS,
      owner,
    )
    .run();
  return true;
}

export async function authenticationOptions(
  db: Db,
  rpID: string,
  purpose: "login" | "approve",
  data: unknown,
  nowS: number,
  userId?: string,
) {
  // a user's own passkeys (the dashboard signs in by email); every passkey for the PWA's single owner
  const keys = await db
    .prepare("SELECT id, transports FROM passkeys WHERE CAST(?1 AS TEXT) IS NULL OR user_id = ?1")
    .bind(userId ?? null)
    .all<{ id: string; transports: string | null }>();
  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: "required",
    allowCredentials: keys.results.map((r) => ({
      id: r.id,
      transports: r.transports ? JSON.parse(r.transports) : undefined,
    })),
  });
  return { options, challengeId: await saveChallenge(db, options.challenge, purpose, data, nowS) };
}

/** Verifies an assertion against a stored passkey; returns the challenge's bound data, or null. `userId`, when given,
 *  is whose passkey it must be: a signed-in user's action (approve, resume, a release move) can only be confirmed with
 *  their own passkey, not another member's registered on the same device. */
export async function verifyAuthentication(
  db: Db,
  v: Verifiers,
  rpID: string,
  origin: string,
  challengeId: string,
  purpose: "login" | "approve",
  response: { id?: string },
  nowS: number,
  userId?: string,
): Promise<{ data: unknown; userId: string } | null> {
  const ch = await takeChallenge(db, challengeId, purpose, nowS);
  if (!ch || !response?.id) return null;
  const key = await db
    .prepare("SELECT id, public_key, counter, transports, user_id FROM passkeys WHERE id = ?1")
    .bind(response.id)
    .first<PasskeyRow>();
  if (!key || (userId !== undefined && key.user_id !== userId)) return null;
  const r = await v.authentication({
    response: response as never,
    expectedChallenge: ch.challenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    requireUserVerification: true,
    credential: {
      id: key.id,
      publicKey: fromB64url(key.public_key),
      counter: key.counter,
      transports: key.transports ? JSON.parse(key.transports) : undefined,
    },
  });
  if (!r.verified) return null;
  await db
    .prepare("UPDATE passkeys SET counter = ?1, last_used_at = ?2 WHERE id = ?3")
    .bind(r.authenticationInfo.newCounter, nowS, key.id)
    .run();
  return { data: ch.data, userId: key.user_id };
}
