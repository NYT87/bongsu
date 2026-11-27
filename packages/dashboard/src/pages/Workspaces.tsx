// Workspaces: the instance's workspaces, made, renamed, archived and opened.

import { type FormEvent, useState } from "react";
import { api, switchWorkspace, when, withFreshCheck } from "../api";
import { Card, Field, Loading, Page, Pill, SecretOnce, useConfirm, useLoad, useToast } from "../ui";
import { errorText, type Props } from "./common";
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

/** After the session's workspace changed (opened, or just made), the whole dashboard reloads in it. */
const workIn = (section = "") => location.assign(`/dashboard/${section}`);

/** Every workspace of the instance: create, rename, add an admin, archive or restore, and open one to work in it. */
export function Workspaces(_: Props) {
  const toast = useToast();
  const { data, error, reload } = useLoad<{ workspaces: WorkspaceRow[] }>("workspaces");
  const { confirm, dialog } = useConfirm();
  // what the form above the table does: make one, rename one, or add an admin to one
  const [form, setForm] = useState<{ kind: "create" } | { kind: "rename" | "admin"; w: WorkspaceRow } | null>(null);
  const [name, setName] = useState("");
  // empty: the server names the folder after the workspace's id
  const [folder, setFolder] = useState("");
  const [tz, setTz] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  const [adminIsMe, setAdminIsMe] = useState(true);
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
    setAdminIsMe(true);
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !form) return;
    setBusy(true);
    setErr(null);
    try {
      const to = email.trim().toLowerCase();
      if (form.kind === "create") {
        const r = await withFreshCheck(() =>
          api<{ invite?: { url: string } }>("workspaces", {
            name,
            timezone: tz,
            // empty: the server picks, numbering it (demo-studio-2) when another workspace has the name's slug
            folder: folder.trim(),
            admin: adminIsMe ? "me" : to,
          }),
        );
        // with "me" as its admin, the session now works in it; one made for someone else waits in this list
        if (r.invite) setMade({ url: r.invite.url, email: to });
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
      reload();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const open = async (w: WorkspaceRow) => {
    setErr(null);
    try {
      await switchWorkspace(w.id);
      workIn();
    } catch (e) {
      setErr(errorText(e));
    }
  };
  return (
    <Page
      title="Workspaces"
      intro="Every workspace of this instance. Open one to work in it as its admin; archive one to stop it completely."
    >
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
      <Card
        title="All workspaces"
        actions={
          !form &&
          !made && (
            <button type="button" onClick={() => show({ kind: "create" })}>
              Create a workspace
            </button>
          )
        }
      >
        {form && (
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
                <Field
                  label="Time zone"
                  help="How its plan's times are shown and entered. Each person can pick their own."
                >
                  {(p) => (
                    <select {...p} value={tz} onChange={(e) => setTz(e.target.value)}>
                      {(zones.includes(tz) ? zones : [tz, ...zones]).map((z) => (
                        <option key={z}>{z}</option>
                      ))}
                    </select>
                  )}
                </Field>
                <fieldset>
                  <legend>Its first admin</legend>
                  <label className="check">
                    <input type="radio" name="admin" checked={adminIsMe} onChange={() => setAdminIsMe(true)} />
                    <span>Me</span>
                  </label>
                  <label className="check">
                    <input type="radio" name="admin" checked={!adminIsMe} onChange={() => setAdminIsMe(false)} />
                    <span>
                      Someone else <span className="muted">who gets an invite link</span>
                    </span>
                  </label>
                </fieldset>
              </>
            )}
            {(form.kind === "admin" || (form.kind === "create" && !adminIsMe)) && (
              <Field
                label={form.kind === "admin" ? `Email of ${form.w.name}'s new admin` : "Their email"}
                help="They get an invite link, to join as an admin."
              >
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
        )}
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
                      <div>{w.name}</div>
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
                      {w.archivedAt ? (
                        <Pill status="disabled" label={`Archived ${when(w.archivedAt)}`} />
                      ) : (
                        <Pill status="ok" label="Active" />
                      )}
                    </td>
                    <td className="right">
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
                                reload();
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
                                reload();
                              },
                            })
                          }
                        >
                          Archive
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <SchedulerCard />
      {dialog}
    </Page>
  );
}
