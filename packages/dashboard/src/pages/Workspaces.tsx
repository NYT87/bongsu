// Workspaces: the instance's workspaces, made, renamed, archived and opened; each one's detail page
// (/dashboard/admin/workspaces/<id>: its people, pending invites and connections); and the instance admins.

import { type FormEvent, useEffect, useState } from "react";
import { api, NAVIGATED, switchWorkspace, when, withFreshCheck } from "../api";
import { Card, Field, Loading, Page, Pill, SecretOnce, useConfirm, useLoad, useToast } from "../ui";
import { AdminPicker, adminOf, errorText, type Props } from "./common";
import { SchedulerCard } from "./Settings";

// ---- Workspaces (instance admins)

interface WorkspaceRow {
  id: string;
  name: string;
  members: number;
  accounts: number;
  createdAt: number;
  archivedAt: number | null;
}
/** What the actions need of a workspace: the list's rows and the detail page both have it. */
type WorkspaceRef = Pick<WorkspaceRow, "id" | "name" | "archivedAt">;

/** After the session's workspace changed (opened, or just made), the whole dashboard reloads in it. */
const workIn = (section = "") => location.assign(`/dashboard/${section}`);

/** The workspace a detail path names (/dashboard/admin/workspaces/<id>); "" for the list. The router reads only the
 *  section, so the rest of the path is read here, as Settings reads its tabs. */
const detailOf = () => decodeURIComponent(location.pathname.replace(/^\/dashboard\/?/, "").split("/")[2] ?? "");

/** The list, or one workspace's detail page when the path names one. */
export function Workspaces(props: Props) {
  const [id, setId] = useState(detailOf);
  useEffect(() => {
    const f = () => setId(detailOf());
    addEventListener("popstate", f);
    addEventListener(NAVIGATED, f);
    return () => {
      removeEventListener("popstate", f);
      removeEventListener(NAVIGATED, f);
    };
  }, []);
  const go = (next: string) => {
    history.pushState(null, "", `/dashboard/admin/workspaces${next ? `/${encodeURIComponent(next)}` : ""}`);
    setId(next);
  };
  return id ? <WorkspaceDetail {...props} id={id} back={() => go("")} /> : <WorkspaceList {...props} onOpen={go} />;
}

/** The actions on a workspace, shared by the list and the detail page: a form (make one, rename one, add an admin to
 *  one) with the invite link it makes, and the row of buttons (open, rename, add an admin, archive or restore).
 *  `after` reloads what the page shows. */
function useWorkspaceActions(state: Props["state"], after: () => void) {
  const toast = useToast();
  const { confirm, dialog } = useConfirm();
  const [form, setForm] = useState<{ kind: "create" } | { kind: "rename" | "admin"; w: WorkspaceRef } | null>(null);
  const [name, setName] = useState("");
  // empty: the server names the folder after the workspace's id
  const [folder, setFolder] = useState("");
  const [tz, setTz] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  // "me", an account's email, or someone new (common.tsx)
  const [adminChoice, setAdminChoice] = useState("me");
  const [email, setEmail] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // an invite link to copy: a new workspace's first admin, or an admin added
  const [made, setMade] = useState<{ url: string; email: string } | null>(null);
  const zones = Intl.supportedValuesOf?.("timeZone") ?? [];
  const show = (f: typeof form) => {
    setForm(f);
    setErr(null);
    setName(f && f.kind === "rename" ? f.w.name : "");
    setFolder("");
    setEmail("");
    setAdminChoice("me");
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !form) return;
    setBusy(true);
    setErr(null);
    try {
      const to = email.trim().toLowerCase();
      if (form.kind === "create") {
        const admin = adminOf(adminChoice, email);
        const r = await withFreshCheck(() =>
          api<{ invite?: { url: string }; admin?: string }>("workspaces", {
            name,
            timezone: tz,
            // empty: the server picks, numbering it (demo-studio-2) when another workspace has the name's slug
            folder: folder.trim(),
            admin,
          }),
        );
        // with "me" as its admin, the session now works in it; one made for someone else waits in this list
        if (r.invite) setMade({ url: r.invite.url, email: admin });
        else if (r.admin) toast({ ok: true, text: `${name.trim()} is ready: ${admin} is its admin.` });
        else workIn("start");
      } else if (form.kind === "rename") {
        await api(`workspaces/${encodeURIComponent(form.w.id)}`, { name });
        toast({ ok: true, text: `Renamed to ${name.trim()}.` });
      } else {
        const r = await withFreshCheck(() =>
          api<{ url: string }>(`workspaces/${encodeURIComponent(form.w.id)}/admins`, { email: to }),
        );
        setMade({ url: r.url, email: to });
      }
      setForm(null);
      after();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const open = async (w: WorkspaceRef) => {
    setErr(null);
    try {
      await switchWorkspace(w.id);
      workIn();
    } catch (e) {
      setErr(errorText(e));
    }
  };
  const formEl = form && (
    <form onSubmit={submit} className="inset">
      {form.kind !== "admin" && (
        <Field
          label={form.kind === "create" ? "Name" : `New name for ${form.w.name}`}
          help="Who or what it's for: a brand, a client, a team."
        >
          {(p) => <input {...p} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required />}
        </Field>
      )}
      {form.kind === "create" && (
        <>
          <Field
            label="Media folder"
            help="The one folder of the media store its files live in, made for you. Leave it empty to name it after the workspace's id, which a rename never changes. It can't be one another workspace uses."
          >
            {(p) => (
              <input
                {...p}
                className="mono"
                value={folder}
                onChange={(e) => setFolder(e.target.value)}
                placeholder="the workspace's id"
                maxLength={60}
                spellCheck={false}
              />
            )}
          </Field>
          <Field label="Time zone" help="How its plan's times are shown and entered. Each person can pick their own.">
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
        </>
      )}
      {form.kind === "admin" && (
        <Field label={`Email of ${form.w.name}'s new admin`} help="They get an invite link, to join as an admin.">
          {(p) => <input {...p} type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />}
        </Field>
      )}
      {err && (
        <p className="error" role="alert">
          {err}
        </p>
      )}
      <div className="actions">
        <button type="button" onClick={() => show(null)}>
          Cancel
        </button>
        <button className="primary" type="submit" aria-disabled={busy}>
          {form.kind === "create"
            ? busy
              ? "Creating…"
              : "Create the workspace"
            : form.kind === "rename"
              ? "Rename"
              : busy
                ? "Making the link…"
                : "Make the invite link"}
        </button>
      </div>
    </form>
  );
  /** The invite link a form made, and an error that isn't the form's (opening a workspace). */
  const notices = (
    <>
      {made && (
        <Card>
          <SecretOnce title={`Invite link for ${made.email}`} value={made.url} onDone={() => setMade(null)} />
          <p className="muted small">They join as an admin with it: it works once, for 7 days.</p>
        </Card>
      )}
      {err && !form && (
        <p className="error" role="alert">
          {err}
        </p>
      )}
      {dialog}
    </>
  );
  const buttons = (w: WorkspaceRef) => (
    <>
      {!w.archivedAt && (
        <button type="button" className="link" onClick={() => open(w)}>
          Open
        </button>
      )}
      <button type="button" className="link" onClick={() => show({ kind: "rename", w })}>
        Rename
      </button>
      {!w.archivedAt && (
        <button type="button" className="link" onClick={() => show({ kind: "admin", w })}>
          Add an admin
        </button>
      )}
      {w.archivedAt ? (
        <button
          type="button"
          className="link"
          onClick={() =>
            confirm({
              title: `Restore ${w.name}?`,
              detail:
                "It comes back as it was: its approved posts publish again (late ones within the catch-up window), its agent keys work and its members can open it.",
              verb: "Restore",
              run: async () => {
                await withFreshCheck(() => api(`workspaces/${encodeURIComponent(w.id)}/restore`, {}));
                toast({ ok: true, text: `${w.name} restored.` });
                after();
              },
            })
          }
        >
          Restore
        </button>
      ) : (
        <button
          type="button"
          className="link danger"
          onClick={() =>
            confirm({
              title: `Archive ${w.name}?`,
              detail:
                "It stops completely: nothing in it publishes, its agent keys and CLI tokens stop working and its members can't open it. Its data stays; restoring brings it back as it was.",
              verb: "Archive",
              run: async () => {
                await withFreshCheck(() => api(`workspaces/${encodeURIComponent(w.id)}/archive`, {}));
                toast({ ok: true, text: `${w.name} archived.` });
                after();
              },
            })
          }
        >
          Archive
        </button>
      )}
    </>
  );
  return { show, formOpen: !!form, made: !!made, formEl, notices, buttons };
}

/** Every workspace of the instance: create, rename, add an admin, archive or restore, and open one to work in it; its
 *  name opens its detail page. */
function WorkspaceList({ state, onOpen }: Props & { onOpen: (id: string) => void }) {
  const { data, error, reload } = useLoad<{ workspaces: WorkspaceRow[] }>("workspaces");
  const a = useWorkspaceActions(state, reload);
  return (
    <Page
      title="Workspaces"
      intro="Every workspace of this instance. Open one to work in it as its admin; archive one to stop it completely."
    >
      {a.notices}
      <Card
        title="All workspaces"
        actions={
          !a.formOpen &&
          !a.made && (
            <button type="button" onClick={() => a.show({ kind: "create" })}>
              Create a workspace
            </button>
          )
        }
      >
        {a.formEl}
        {!data ? (
          <Loading error={error} retry={reload} />
        ) : (
          <div className="table-wrap">
            <table className="stack">
              <thead>
                <tr>
                  <th>Workspace</th>
                  <th className="right">Members</th>
                  <th className="right">Accounts</th>
                  <th>Created</th>
                  <th>Status</th>
                  <th className="right">
                    <span className="vh">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.workspaces.map((w) => (
                  <tr key={w.id}>
                    <td>
                      <a
                        href={`/dashboard/admin/workspaces/${encodeURIComponent(w.id)}`}
                        onClick={(e) => {
                          e.preventDefault();
                          onOpen(w.id);
                        }}
                      >
                        {w.name}
                      </a>
                      <div className="muted small mono">{w.id}</div>
                    </td>
                    <td data-label="Members" className="right">
                      {w.members}
                    </td>
                    <td data-label="Accounts" className="right">
                      {w.accounts}
                    </td>
                    <td data-label="Created" className="small">
                      {when(w.createdAt)}
                    </td>
                    <td data-label="Status">
                      <StatusPill archivedAt={w.archivedAt} />
                    </td>
                    <td className="right">{a.buttons(w)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <InstanceAdmins me={state.user?.id ?? null} />
      <SchedulerCard />
    </Page>
  );
}

const StatusPill = ({ archivedAt }: { archivedAt: number | null }) =>
  archivedAt ? <Pill status="disabled" label={`Archived ${when(archivedAt)}`} /> : <Pill status="ok" label="Active" />;

interface Detail {
  workspace: { id: string; name: string; mediaFolder: string; createdAt: number; archivedAt: number | null };
  members: { userId: string; email: string | null; name: string | null; role: string }[];
  invites: { id: string; email: string; role: string; expiresAt: number; copyable: boolean }[];
  connections: { id: string; provider: string; label: string | null; status: string }[];
  accounts: { id: string; platform: string; handle: string; status: string; connection: string | null }[];
}

const roleName = (r: string) => r.charAt(0).toUpperCase() + r.slice(1);

/** One workspace for an instance admin (#140): its facts and actions, its people with pending invites in the same
 *  list (Copy link, Revoke), and its connections and accounts, read-only. */
function WorkspaceDetail({ state, id, back }: Props & { id: string; back: () => void }) {
  const toast = useToast();
  const { data, error, reload } = useLoad<Detail>(`workspaces/${encodeURIComponent(id)}`);
  const a = useWorkspaceActions(state, reload);
  const { confirm, dialog } = useConfirm();
  const [link, setLink] = useState<{ url: string; email: string } | null>(null);
  const w = data?.workspace;
  const invitePath = (inviteId: string, what: "link" | "revoke") =>
    `workspaces/${encodeURIComponent(id)}/invites/${encodeURIComponent(inviteId)}/${what}`;
  const copy = async (i: Detail["invites"][number]) => {
    try {
      const r = await withFreshCheck(() => api<{ url: string }>(invitePath(i.id, "link"), {}));
      setLink({ url: r.url, email: i.email });
    } catch (e) {
      toast({ ok: false, text: errorText(e) });
    }
  };
  return (
    <Page title={w?.name ?? "Workspace"} intro="Its people, pending invites and connections.">
      <p>
        <a
          href="/dashboard/admin/workspaces"
          onClick={(e) => {
            e.preventDefault();
            back();
          }}
        >
          ← All workspaces
        </a>
      </p>
      {a.notices}
      {link && (
        <Card>
          <SecretOnce title={`Invite link for ${link.email}`} value={link.url} onDone={() => setLink(null)} />
        </Card>
      )}
      {!data || !w ? (
        <Loading error={error} retry={reload} />
      ) : (
        <>
          <Card title="Workspace">
            {a.formEl}
            <dl className="facts">
              <dt>Id</dt>
              <dd className="mono">{w.id}</dd>
              <dt>Media folder</dt>
              <dd className="mono">{w.mediaFolder}</dd>
              <dt>Created</dt>
              <dd>{when(w.createdAt)}</dd>
              <dt>Status</dt>
              <dd>
                <StatusPill archivedAt={w.archivedAt} />
              </dd>
            </dl>
            <div className="actions">{a.buttons(w)}</div>
          </Card>
          <Card title="People">
            {data.members.length + data.invites.length === 0 ? (
              <p className="empty">No one yet: Add an admin above.</p>
            ) : (
              <div className="table-wrap">
                <table className="stack">
                  <thead>
                    <tr>
                      <th>Person</th>
                      <th>Role</th>
                      <th>Status</th>
                      <th className="right">
                        <span className="vh">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.members.map((m) => (
                      <tr key={m.userId}>
                        <td>
                          {m.name ?? m.email ?? m.userId}
                          {m.name && m.email && <div className="muted small">{m.email}</div>}
                        </td>
                        <td data-label="Role">{roleName(m.role)}</td>
                        <td data-label="Status">Member</td>
                        <td />
                      </tr>
                    ))}
                    {data.invites.map((i) => (
                      <tr key={i.id}>
                        <td>{i.email}</td>
                        <td data-label="Role">{roleName(i.role)}</td>
                        <td data-label="Status">
                          <Pill status="waiting" label={`Invited, until ${when(i.expiresAt)}`} />
                        </td>
                        <td className="right">
                          {i.copyable && (
                            <button type="button" className="link" onClick={() => copy(i)}>
                              Copy link
                            </button>
                          )}
                          <button
                            type="button"
                            className="link danger"
                            onClick={() =>
                              confirm({
                                title: `Revoke the invite for ${i.email}?`,
                                detail: "Its link stops working at once. You can invite them again.",
                                verb: "Revoke",
                                run: async () => {
                                  await withFreshCheck(() => api(invitePath(i.id, "revoke"), {}));
                                  toast({ ok: true, text: `The invite for ${i.email} is revoked.` });
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
            )}
            <p className="muted small">Instance admins aren't listed: they can act in every workspace.</p>
          </Card>
          <Card title="Connected accounts">
            {data.connections.length + data.accounts.length === 0 ? (
              <p className="empty">Nothing connected yet.</p>
            ) : (
              <div className="table-wrap">
                <table className="stack">
                  <thead>
                    <tr>
                      <th>Account</th>
                      <th>Platform</th>
                      <th>Connection</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.accounts.map((x) => {
                      const c = data.connections.find((k) => k.id === x.connection);
                      return (
                        <tr key={x.id}>
                          <td>{x.handle}</td>
                          <td data-label="Platform">{x.platform}</td>
                          <td data-label="Connection">{c ? (c.label ?? c.provider) : "none"}</td>
                          <td data-label="Status">
                            <Pill status={c && c.status !== "ok" ? c.status : x.status} />
                          </td>
                        </tr>
                      );
                    })}
                    {data.connections
                      .filter((c) => !data.accounts.some((x) => x.connection === c.id))
                      .map((c) => (
                        <tr key={c.id}>
                          <td className="muted">no account yet</td>
                          <td data-label="Platform">{c.provider}</td>
                          <td data-label="Connection">{c.label ?? c.provider}</td>
                          <td data-label="Status">
                            <Pill status={c.status} />
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}
      {dialog}
    </Page>
  );
}

interface UserRow {
  id: string;
  email: string | null;
  name: string | null;
  instanceAdmin: boolean;
}

/** Who runs the instance: they aren't listed among a workspace's members (#139), so they're made and removed here. The
 *  last one stays (the server refuses, 409). */
function InstanceAdmins({ me }: { me: string | null }) {
  const toast = useToast();
  const { data, error, reload } = useLoad<{ users: UserRow[] }>("users");
  const { confirm, dialog } = useConfirm();
  const [pick, setPick] = useState("");
  const label = (u: UserRow) => (u.name && u.email ? `${u.name} (${u.email})` : (u.name ?? u.email ?? u.id));
  const set = (u: UserRow, on: boolean) =>
    confirm({
      title: on ? `Make ${label(u)} an instance admin?` : `Remove ${label(u)} as an instance admin?`,
      detail: on
        ? "They'll manage the whole instance: every workspace (as its admin), the media stores, the OAuth apps and who the instance admins are."
        : "They keep their memberships, but no longer see the instance's workspaces, media stores and OAuth apps.",
      verb: on ? "Make instance admin" : "Remove instance admin",
      run: async () => {
        await withFreshCheck(() => api("instance-admins", { userId: u.id, on }));
        toast({ ok: true, text: `${label(u)} ${on ? "is now" : "is no longer"} an instance admin.` });
        // their own: the sidebar's Instance group goes with it
        if (!on && u.id === me) return location.reload();
        setPick("");
        reload();
      },
    });
  const admins = data?.users.filter((u) => u.instanceAdmin) ?? [];
  const others = data?.users.filter((u) => !u.instanceAdmin) ?? [];
  return (
    <Card title="Instance admins">
      <p className="muted small">
        They run the instance and can act in every workspace, without being listed among its members.
      </p>
      {!data ? (
        <Loading error={error} retry={reload} />
      ) : (
        <>
          <div className="table-wrap">
            <table className="stack">
              <thead>
                <tr>
                  <th>Person</th>
                  <th className="right">
                    <span className="vh">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {admins.map((u) => (
                  <tr key={u.id}>
                    <td>
                      {label(u)}
                      {u.id === me && <span className="muted"> (you)</span>}
                    </td>
                    <td className="right">
                      <button type="button" className="link danger" onClick={() => set(u, false)}>
                        Remove instance admin
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {others.length > 0 && (
            <div className="row">
              <Field label="Make someone an instance admin">
                {(p) => (
                  <select {...p} value={pick} onChange={(e) => setPick(e.target.value)}>
                    <option value="">Choose a person</option>
                    {others.map((u) => (
                      <option key={u.id} value={u.id}>
                        {label(u)}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <button
                type="button"
                disabled={!pick}
                onClick={() => {
                  const u = others.find((x) => x.id === pick);
                  if (u) set(u, true);
                }}
              >
                Make instance admin
              </button>
            </div>
          )}
        </>
      )}
      {dialog}
    </Card>
  );
}
