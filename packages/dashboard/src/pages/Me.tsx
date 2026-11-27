// The person's own page, from their name at the bottom of the sidebar: their name, and the workspaces they belong to
// with their role in each, and a way to leave each one.

import { type FormEvent, useEffect, useState } from "react";
import { api, STATE_STALE } from "../api";
import { Card, Field, Loading, Page, useConfirm, useLoad, useToast } from "../ui";
import { errorText, type Props, ROLE_HELP } from "./common";

interface MeAnswer {
  email: string | null;
  name: string | null;
  workspaces: { id: string; name: string; role: string }[];
}

const roleName = (r: string) => r.charAt(0).toUpperCase() + r.slice(1);

export function Me({ state }: Props) {
  const toast = useToast();
  const { data, error, reload } = useLoad<MeAnswer>("me");
  const { confirm, dialog } = useConfirm();
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (data) setName(data.name ?? "");
  }, [data]);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    try {
      await api("me/name", { name });
      toast({ ok: true, text: "Your name is saved." });
      dispatchEvent(new Event(STATE_STALE));
      reload();
    } catch (e) {
      setErr(errorText(e));
    }
  };
  const leave = (w: MeAnswer["workspaces"][number]) =>
    confirm({
      title: `Leave ${w.name}?`,
      detail:
        "You stop working in it at once, in the dashboard and the app: its pages, its notifications and your CLI tokens for it. An admin can invite you again.",
      verb: "Leave",
      // a refusal (the last admin) shows in the dialog
      run: async () => {
        await api(`me/workspaces/${encodeURIComponent(w.id)}/leave`, {});
        // leaving the one this session works in: the dashboard reloads in the next one, or none
        if (w.id === state.workspace?.id) return location.assign("/dashboard/");
        toast({ ok: true, text: `You left ${w.name}.` });
        dispatchEvent(new Event(STATE_STALE));
        reload();
      },
    });
  return (
    <Page title="You" intro="Your name, and the workspaces you belong to.">
      {!data ? (
        <Loading error={error} retry={reload} />
      ) : (
        <>
          <Card title="Your name">
            <form onSubmit={save}>
              <Field label="Name" help={`Shown to the people you work with. You sign in as ${data.email ?? "you"}.`}>
                {(p) => <input {...p} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />}
              </Field>
              <div className="actions">
                {err && (
                  <span className="error" role="alert">
                    {err}
                  </span>
                )}
                <button className="primary" type="submit">
                  Save
                </button>
              </div>
            </form>
          </Card>
          <Card title="Your workspaces">
            {data.workspaces.length === 0 ? (
              <p className="empty">You don't belong to any workspace.</p>
            ) : (
              <div className="table-wrap">
                <table className="stack">
                  <thead>
                    <tr>
                      <th>Workspace</th>
                      <th>Your role</th>
                      <th className="right">
                        <span className="vh">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.workspaces.map((w) => (
                      <tr key={w.id}>
                        <td>
                          {w.name}
                          {w.id === state.workspace?.id && <span className="muted small"> (working in it now)</span>}
                        </td>
                        <td data-label="Your role" title={ROLE_HELP[w.role]}>
                          {roleName(w.role)}
                        </td>
                        <td className="right">
                          <button type="button" className="link danger" onClick={() => leave(w)}>
                            Leave
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="muted small">A workspace's last admin can't leave: make someone else admin first.</p>
          </Card>
        </>
      )}
      {dialog}
    </Page>
  );
}
