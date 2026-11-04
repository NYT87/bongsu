// Accepting an invite (core/invites.ts), signed out, the same in both apps: the dashboard's for admins and editors,
// the app's for creators. Nothing here says whether the invite's email already has an account: the options always
// carry both ceremonies (a new passkey for a fresh user id, and a sign-in that offers no particular passkey), and
// the person says which is theirs. Every unusable invite gets the same 404.

import type { Env } from "@bongsu/core/env";
import { sha256Hex } from "@bongsu/core/formats/approved";
import { acceptInvite, InviteError, inviteFor } from "@bongsu/core/invites";
import { createUser, newUserId } from "@bongsu/core/people";
import type { Role } from "@bongsu/core/roles";
import {
  authenticationOptions,
  registrationOptions,
  type Verifiers,
  verifyAuthentication,
  verifyRegistration,
} from "./webauthn";

/** The one answer for an invite that can't be used, whatever the reason. */
export const NO_INVITE = { error: "this invite link doesn't work any more: ask for a new one" };
/** A new passkey that couldn't join: also the answer when the email has an account already (which isn't said). */
export const NEW_FAILED = {
  error:
    "the passkey couldn't be created for this invite: if you already have a Bongsu account, sign in with it instead",
};
/** A sign-in that couldn't join: a passkey not of the invite's email, or no account with it (which isn't said). */
export const SIGNIN_FAILED = { error: "sign-in failed: use the passkey of the account this invite was sent to" };

export class AcceptError extends Error {
  constructor(
    public status: 400 | 401 | 404,
    public answer: { error: string },
  ) {
    super(answer.error);
  }
}

interface Data {
  invite: string;
  userId?: string;
  name?: string | null;
}

/** The roles each app takes: creators finish in the app, admins and editors in the dashboard. */
export const APP_ROLES: readonly Role[] = ["creator"];
export const DASHBOARD_ROLES: readonly Role[] = ["admin", "editor"];

/** The invite behind a link, while it can be used, or the one 404. `only`: the roles this app takes (APP_ROLES,
 *  DASHBOARD_ROLES); another's invite is refused the same way, so the answer says nothing more. */
async function usable(env: Env, token: string, nowS: number, only: readonly Role[]) {
  const i = await inviteFor(env.DB, token, nowS);
  if (!i || !only.includes(i.role)) throw new AcceptError(404, NO_INVITE);
  return i;
}

/** Who the invite is for, as the page shows it. */
export async function invitePreview(
  env: Env,
  token: string,
  nowS: number,
  only: readonly Role[],
): Promise<{ workspace: string; role: Role }> {
  const i = await usable(env, token, nowS, only);
  return { workspace: i.workspaceName, role: i.role };
}

/** Both ceremonies' options, the same shape for every email. */
export async function inviteOptions(env: Env, token: string, name: unknown, nowS: number, only: readonly Role[]) {
  const i = await usable(env, token, nowS, only);
  const invite = await sha256Hex(token);
  const display =
    String(name ?? "")
      .trim()
      .slice(0, 80) || null;
  // a fresh id even when the email has an account (then this ceremony fails at verify): nothing of theirs is listed
  const id = newUserId();
  const register = await registrationOptions(
    env.DB,
    env.RP_ID,
    nowS,
    { invite, userId: id, name: display } satisfies Data,
    { id, email: i.email, name: display },
  );
  // "\u0000" is no one's id: no passkey listed, the browser offers the person's own for this site
  const signIn = await authenticationOptions(env.DB, env.RP_ID, "login", { invite } satisfies Data, nowS, "\u0000");
  return { register, signIn };
}

/** Joins with a new passkey ("new": a new user with the invite's email) or the person's own ("existing": their
 *  account must have that email). */
export async function inviteVerify(
  env: Env,
  verifiers: Verifiers,
  origin: string,
  token: string,
  b: Record<string, unknown>,
  nowS: number,
  only: readonly Role[],
): Promise<{ userId: string; workspaceId: string; role: Role; isNew: boolean }> {
  const i = await usable(env, token, nowS, only);
  const invite = await sha256Hex(token);
  const challengeId = String(b.challengeId ?? "");
  if (b.mode === "existing") {
    const r = await verifyAuthentication(
      env.DB,
      verifiers,
      env.RP_ID,
      origin,
      challengeId,
      "login",
      b.response as { id?: string },
      nowS,
    );
    const user =
      r && (r.data as Data | null)?.invite === invite
        ? await env.DB.prepare("SELECT email FROM users WHERE id = ?1").bind(r.userId).first<{ email: string | null }>()
        : null;
    if (!r || user?.email !== i.email) throw new AcceptError(401, SIGNIN_FAILED);
    try {
      return { userId: r.userId, ...(await acceptInvite(env.DB, token, r.userId, nowS)), isNew: false };
    } catch (e) {
      if (e instanceof InviteError) throw new AcceptError(404, NO_INVITE);
      throw e;
    }
  }
  let joined: { userId: string; workspaceId: string; role: Role } | null = null;
  const ok = await verifyRegistration(
    env.DB,
    verifiers,
    env.RP_ID,
    origin,
    challengeId,
    b.response,
    String(b.device ?? "passkey").slice(0, 60),
    nowS,
    async (data) => {
      const d = data as Data | null;
      if (d?.invite !== invite || !d.userId) return false;
      // the email has an account: they sign in with it instead (said the same way as any other failure)
      if (await env.DB.prepare("SELECT 1 FROM users WHERE email = ?1").bind(i.email).first()) return false;
      // the user before the passkey, which names them, and the membership, which needs them. Two acceptances racing
      // past the check above: the second one's user breaks the unique email, refused like any other failure
      try {
        await createUser(env.DB, { id: d.userId, email: i.email, name: d.name ?? null }, nowS);
      } catch (e) {
        if (await env.DB.prepare("SELECT 1 FROM users WHERE email = ?1").bind(i.email).first()) return false;
        throw e;
      }
      try {
        joined = { userId: d.userId, ...(await acceptInvite(env.DB, token, d.userId, nowS)) };
      } catch (e) {
        await env.DB.prepare("DELETE FROM users WHERE id = ?1").bind(d.userId).run();
        if (e instanceof InviteError) return false;
        throw e;
      }
      return true;
    },
  );
  const j = joined as { userId: string; workspaceId: string; role: Role } | null;
  if (!ok || !j) throw new AcceptError(400, NEW_FAILED);
  return { ...j, isNew: true };
}
