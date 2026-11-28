// The first workspace of a new instance, and accepting an invite.

import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { type FormEvent, useEffect, useState } from "react";
import type { State } from "../App";
import { api, withFreshCheck } from "../api";
import { Brand, Card, Field, Loading, SecretOnce } from "../ui";
import { AdminPicker, adminOf, errorText, ROLE_HELP } from "./common";
import { DeleteAccount } from "./Me";

// ---- No workspace yet

/** Signed in, in no workspace. An instance admin creates the first one (the first run: a name, a time zone and its
 *  admin: them, another account on the instance, or someone invited by email); anyone else waits for an invite. In
 *  place of the sidebar. */
export function FirstWorkspace({
  state,
  onDone,
  onSignOut,
}: {
  state: State;
  /** `invited`: its admin is someone else, so it waits on the Workspaces page. */
  onDone: (invited: boolean) => void;
  onSignOut: () => void;
}) {
  const zones = Intl.supportedValuesOf?.("timeZone") ?? [];
  const here = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const [name, setName] = useState("");
  const [tz, setTz] = useState(here);
  const [adminChoice, setAdminChoice] = useState("me");
  const [email, setEmail] = useState("");
  const [link, setLink] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    document.title = "Your first workspace · Bongsu dashboard";
  }, []);
  const signOut = async () => {
    await api("signout", {});
    onSignOut();
  };
  if (!state.instanceAdmin)
    return (
      <main className="centered">
        <Brand />
        <Card>
          <h1>You're not in a workspace yet</h1>
          <p className="muted">An admin of a workspace invites you to it: ask them for an invite link.</p>
          <div className="actions stacked">
            <button type="button" className="link" onClick={signOut}>
              Sign out
            </button>
          </div>
        </Card>
        <DeleteAccount email={state.user?.email ?? null} />
      </main>
    );
  if (link)
    return (
      <main className="centered">
        <Brand />
        <Card>
          <h1>Send them the invite</h1>
          <p className="muted">
            The workspace is ready. Its first admin joins with this link (it works once, for 7 days); meanwhile it waits
            on your Workspaces page, where Open lets you set it up yourself.
          </p>
          <SecretOnce
            title={`Invite link for ${email.trim().toLowerCase()}`}
            value={link}
            onDone={() => onDone(true)}
          />
        </Card>
      </main>
    );
  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return; // one workspace per click
    setBusy(true);
    setErr(null);
    try {
      // making someone an admin asks for a fresh passkey check
      const r = await withFreshCheck(() =>
        api<{ invite?: { url: string }; admin?: string }>("workspaces", {
          name,
          timezone: tz,
          admin: adminOf(adminChoice, email),
        }),
      );
      // their link, to copy, before going on; another account made its admin: it waits on the Workspaces page too
      if (r.invite) setLink(r.invite.url);
      else onDone(!!r.admin);
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="centered">
      <Brand />
      <Card>
        <h1>Create your first workspace</h1>
        <p className="muted">
          A workspace holds the accounts, the plan and the people who work on them. You can make more later.
        </p>
        <form onSubmit={create}>
          <Field label="Name" help="Who or what it's for: a brand, a client, a team.">
            {(p) => <input {...p} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required />}
          </Field>
          <Field label="Time zone" help="How the plan's times are shown and entered. Each person can pick their own.">
            {(p) => (
              <select {...p} value={tz} onChange={(e) => setTz(e.target.value)}>
                {(zones.includes(tz) ? zones : [tz, ...zones]).map((z) => (
                  <option key={z}>{z}</option>
                ))}
              </select>
            )}
          </Field>
          <AdminPicker
            myEmail={state.user?.email ?? null}
            choice={adminChoice}
            onChoice={setAdminChoice}
            email={email}
            onEmail={setEmail}
          />
          {err && (
            <p className="error" role="alert">
              {err}
            </p>
          )}
          <div className="actions stacked">
            <button className="primary" type="submit" aria-disabled={busy}>
              {busy ? "Creating…" : "Create the workspace"}
            </button>
            <button type="button" className="link" onClick={signOut}>
              Sign out
            </button>
          </div>
        </form>
      </Card>
    </main>
  );
}

// ---- Accepting an invite (/dashboard/invite/<token>), signed out

/** Joining a workspace from an invite link: a name and a new passkey, or the passkey of the account the invite was
 *  sent to. The page doesn't know (and the server doesn't say) whether that account exists: the person picks. */
export function AcceptInvite({ token, onDone }: { token: string; onDone: () => void }) {
  const [invite, setInvite] = useState<{ workspace: string; role: string } | null>(null);
  const [gone, setGone] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  const path = `invite/${encodeURIComponent(token)}`;
  useEffect(() => {
    document.title = "Join a workspace · Bongsu dashboard";
    api<{ workspace: string; role: string }>(path)
      .then(setInvite)
      .catch((e) => setGone(errorText(e)));
  }, [path]);
  const join = async (mode: "new" | "existing") => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      type Ceremony = { options: never; challengeId: string };
      const o = await api<{ register: Ceremony; signIn: Ceremony }>(`${path}/options`, { name });
      const c = mode === "new" ? o.register : o.signIn;
      const response =
        mode === "new"
          ? await startRegistration({ optionsJSON: c.options })
          : await startAuthentication({ optionsJSON: c.options });
      const r = await api<{ recoveryCodes?: string[] }>(`${path}/verify`, {
        mode,
        challengeId: c.challengeId,
        response,
        device: navigator.userAgent.includes("Mac") ? "Mac" : "this computer",
      });
      if (r.recoveryCodes) setCodes(r.recoveryCodes);
      else onDone();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  if (codes)
    return (
      <main className="centered">
        <Brand />
        <Card>
          <h1>You're in</h1>
          <p className="muted">
            If you ever lose every passkey, one of these codes signs you in (each works once). Keep them somewhere safe,
            away from this computer.
          </p>
          <SecretOnce title="Recovery codes" lines={codes} onDone={onDone} />
        </Card>
      </main>
    );
  return (
    <main className="centered">
      <Brand />
      <Card>
        {gone ? (
          <>
            <h1>This invite doesn't work</h1>
            <p className="muted">
              It was used already, revoked, or is older than 7 days. Ask the person who invited you for a new link.
            </p>
          </>
        ) : !invite ? (
          <Loading />
        ) : (
          <>
            <h1>Join {invite.workspace}</h1>
            <p className="muted">
              You're invited as {invite.role === "admin" ? "an" : "a"} {invite.role}. {ROLE_HELP[invite.role]}
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                join("new");
              }}
            >
              <h2>New to Bongsu</h2>
              <Field label="Your name">
                {(p) => <input {...p} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />}
              </Field>
              <p className="help">
                Your passkey (this device's fingerprint, face or PIN) signs you in from now on, with the email the
                invite was sent to; no password.
              </p>
              <div className="actions stacked">
                <button className="primary" type="submit" aria-disabled={busy}>
                  {busy ? "Waiting for the passkey…" : "Create my passkey and join"}
                </button>
              </div>
            </form>
            <h2>Already have a Bongsu account?</h2>
            <p className="muted">Sign in with its passkey: the account must have the email this invite was sent to.</p>
            <div className="actions stacked">
              <button type="button" onClick={() => join("existing")} aria-disabled={busy}>
                Sign in with my passkey and join
              </button>
            </div>
            {err && (
              <p className="error" role="alert">
                {err}
              </p>
            )}
          </>
        )}
      </Card>
    </main>
  );
}
