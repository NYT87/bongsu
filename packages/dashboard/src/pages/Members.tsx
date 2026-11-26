// Members: the workspace's people, their roles and invites.

import { type FormEvent, useState } from "react";
import { api, manages, STATE_STALE, when, withFreshCheck } from "../api";
import { Card, Field, Loading, Page, SecretOnce, useConfirm, useLoad, useToast } from "../ui";
import { errorText, type Props, ROLE_HELP } from "./common";

// ---- Members

interface Member {
  userId: string;
  email: string | null;
  /** The name shown in this workspace. */
  name: string | null;
  /** The per-workspace value behind it, null when unset. */
  displayName: string | null;
  role: string;
  /** Only in an instance admin's list: whether this member is one too. */
  instanceAdmin?: boolean;
}

interface Invite {
  id: string;
  email: string;
  role: string;
  expiresAt: number;
}

const ROLES = ["admin", "editor", "creator"] as const;

const roleName = (r: string) => r.charAt(0).toUpperCase() + r.slice(1);

export function Members({ state }: Props) {
  const toast = useToast();
  const { data, error, reload } = useLoad<{ members: Member[]; invites: Invite[] }>("members");
  const [inviting, setInviting] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<string>("editor");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<{ url: string; email: string; mailed: boolean } | null>(null);
  const { confirm, dialog } = useConfirm();
  const invite = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await withFreshCheck(() => api<{ url: string; mailed: boolean }>("invites", { email, role }));
      setMade({ ...r, email: email.trim().toLowerCase() });
      setInviting(false);
      setEmail("");
      reload();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const changeRole = async (m: Member, next: string) => {
    setErr(null);
    try {
      await withFreshCheck(() => api(`members/${encodeURIComponent(m.userId)}`, { role: next }));
      toast({ ok: true, text: `${m.name ?? m.email ?? m.userId} is now ${next === "admin" ? "an" : "a"} ${next}.` });
    } catch (e) {
      setErr(errorText(e));
    }
    reload();
  };
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [nameErr, setNameErr] = useState<string | null>(null);
  const saveName = async (e: FormEvent, m: Member) => {
    e.preventDefault();
    setNameErr(null);
    try {
      await api(`members/${encodeURIComponent(m.userId)}/name`, { name: draft });
      setEditing(null);
      if (m.userId === me) dispatchEvent(new Event(STATE_STALE)); // the sidebar shows this name too
      reload();
    } catch (error) {
      setNameErr(errorText(error));
    }
  };
  const me = state.user?.id;
  return (
    <Page
      title="Members"
      intro="The people who work in this workspace, and their roles. An invite is a link that works once, for 7 days."
    >
      {made && (
        <Card>
          <SecretOnce title={`Invite link for ${made.email}`} value={made.url} onDone={() => setMade(null)} />
          <p className="muted small">
            {made.mailed ? "It was emailed to them too." : "Send it to them yourself: email isn't set up here."}
          </p>
        </Card>
      )}
      {err && (
        <p className="error" role="alert">
          {err}
        </p>
      )}
      <Card
        title="People"
        actions={
          !inviting &&
          !made && (
            <button type="button" onClick={() => setInviting(true)}>
              Invite someone
            </button>
          )
        }
      >
        {inviting && (
          <form onSubmit={invite} className="inset">
            <Field label="Their email" help="The invite is for this email: it's how they sign in.">
              {(p) => <input {...p} type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />}
            </Field>
            <Field label="Role" help={ROLE_HELP[role]}>
              {(p) => (
                <select {...p} value={role} onChange={(e) => setRole(e.target.value)}>
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {roleName(r)}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <div className="actions">
              <button type="button" onClick={() => setInviting(false)}>
                Cancel
              </button>
              <button className="primary" type="submit" aria-disabled={busy}>
                {busy ? "Making the link…" : "Make the invite link"}
              </button>
            </div>
          </form>
        )}
        {!data ? (
          <Loading error={error} retry={reload} />
        ) : (
          <div className="table-wrap">
            <table className="stack">
              <thead>
                <tr>
                  <th>Person</th>
                  <th>Role</th>
                  <th className="right">
                    <span className="vh">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.members.map((m) => (
                  <tr key={m.userId}>
                    <td>
                      <div>
                        {m.name ?? m.email ?? m.userId}
                        {m.userId === me && <span className="muted"> (you)</span>}
                      </div>
                      {m.name && m.email && <div className="muted small">{m.email}</div>}
                      {editing === m.userId && (
                        <form onSubmit={(e) => saveName(e, m)} className="inset">
                          <Field label="Name in this workspace" help="Leave it empty to use their own name.">
                            {(p) => (
                              <input
                                {...p}
                                value={draft}
                                onChange={(e) => setDraft(e.target.value)}
                                placeholder="Shown here as …"
                                maxLength={60}
                              />
                            )}
                          </Field>
                          <div className="actions">
                            {nameErr && (
                              <span className="error" role="alert">
                                {nameErr}
                              </span>
                            )}
                            <button type="button" onClick={() => setEditing(null)}>
                              Cancel
                            </button>
                            <button className="primary" type="submit">
                              Save
                            </button>
                          </div>
                        </form>
                      )}
                    </td>
                    <td data-label="Role">
                      <select
                        aria-label={`Role of ${m.name ?? m.email ?? m.userId}`}
                        value={m.role}
                        onChange={(e) => changeRole(m, e.target.value)}
                      >
                        {ROLES.map((r) => (
                          <option key={r} value={r}>
                            {roleName(r)}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="right">
                      {manages(state) && editing !== m.userId && (
                        <>
                          <button
                            type="button"
                            className="link"
                            onClick={() => {
                              setEditing(m.userId);
                              setDraft(m.displayName ?? "");
                              setNameErr(null);
                            }}
                          >
                            Edit name
                          </button>{" "}
                        </>
                      )}
                      {state.instanceAdmin && m.instanceAdmin !== undefined && (
                        <button
                          type="button"
                          className="link"
                          onClick={() =>
                            confirm({
                              title: m.instanceAdmin
                                ? `Remove ${m.name ?? m.email ?? m.userId} as an instance admin?`
                                : `Make ${m.name ?? m.email ?? m.userId} an instance admin?`,
                              detail: m.instanceAdmin
                                ? "They keep their role in this workspace, but no longer see the instance's workspaces, media stores and OAuth apps."
                                : "They'll manage the whole instance: every workspace (as its admin), the media stores, the OAuth apps and who the instance admins are.",
                              verb: m.instanceAdmin ? "Remove instance admin" : "Make instance admin",
                              run: async () => {
                                await withFreshCheck(() =>
                                  api("instance-admins", { userId: m.userId, on: !m.instanceAdmin }),
                                );
                                toast({
                                  ok: true,
                                  text: `${m.name ?? m.email ?? m.userId} ${m.instanceAdmin ? "is no longer" : "is now"} an instance admin.`,
                                });
                                // their own: the sidebar's Instance group goes with it
                                if (m.userId === me && m.instanceAdmin) location.reload();
                                else reload();
                              },
                            })
                          }
                        >
                          {m.instanceAdmin ? "Remove instance admin" : "Make instance admin"}
                        </button>
                      )}{" "}
                      <button
                        type="button"
                        className="link danger"
                        onClick={() =>
                          confirm({
                            title: `Remove ${m.name ?? m.email ?? m.userId}?`,
                            detail:
                              "They leave this workspace at once: signed out of it, their CLI tokens for it revoked and their devices no longer notified. They can be invited again.",
                            verb: "Remove",
                            run: async () => {
                              await withFreshCheck(() => api(`members/${encodeURIComponent(m.userId)}/remove`, {}));
                              toast({ ok: true, text: `${m.name ?? m.email ?? m.userId} removed.` });
                              reload();
                            },
                          })
                        }
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {data && data.invites.length > 0 && (
        <Card title="Pending invites">
          <div className="table-wrap">
            <table className="stack">
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Role</th>
                  <th>Expires</th>
                  <th className="right">
                    <span className="vh">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.invites.map((i) => (
                  <tr key={i.id}>
                    <td>{i.email}</td>
                    <td data-label="Role">{roleName(i.role)}</td>
                    <td data-label="Expires" className="small">
                      {when(i.expiresAt)}
                    </td>
                    <td className="right">
                      <button
                        type="button"
                        className="link danger"
                        onClick={() =>
                          confirm({
                            title: `Revoke the invite for ${i.email}?`,
                            detail: "Its link stops working at once. You can invite them again.",
                            verb: "Revoke",
                            run: async () => {
                              await withFreshCheck(() => api(`invites/${encodeURIComponent(i.id)}/revoke`, {}));
                              toast({ ok: true, text: `Invite for ${i.email} revoked.` });
                              reload();
                            },
                          })
                        }
                      >
                        Revoke
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      {dialog}
    </Page>
  );
}
