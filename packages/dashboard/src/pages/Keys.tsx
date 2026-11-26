// Keys: agent keys and the person's own CLI tokens.

import { type FormEvent, useState } from "react";
import { api, manages, when, withFreshCheck } from "../api";
import { Card, Field, Loading, Page, Pill, SecretOnce, useConfirm, useLoad, useToast } from "../ui";
import { errorText, type Props } from "./common";

// ---- Agent keys

interface Key {
  id: string;
  name: string;
  scopes: string[];
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

const SCOPE_HELP: Record<string, string> = {
  read: "read the plan, jobs and notifications",
  draft: "propose drafts",
  plan: "add, reschedule, hold and remove plan items",
  pause: "pause publishing",
  reschedule: "move a YouTube release date (not given by default)",
  metrics: "upload metrics samples collected elsewhere (not given by default)",
  approve: "approve posts",
  resume: "resume publishing",
};

export function Keys({ state }: Props) {
  // an editor has only their own CLI tokens here; the workspace's agent keys are its admins'
  if (!manages(state))
    return (
      <Page title="Keys & tokens" intro="Your CLI tokens act as you, with your role's rights.">
        <CliTokens />
      </Page>
    );
  return <AgentKeys />;
}

function AgentKeys() {
  const toast = useToast();
  const { data, error, reload } = useLoad<{ scopes: string[]; keys: Key[] }>("keys");
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>(["read"]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<{ key: string; name: string } | null>(null);
  const { confirm, dialog } = useConfirm();
  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await withFreshCheck(() => api<{ key: string; name: string }>("keys", { name, scopes }));
      setMade(r);
      setCreating(false);
      setName("");
      setScopes(["read"]);
      reload();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Page
      title="Keys & tokens"
      intro="Agent keys let agents and scripts plan with Bongsu (the agent API and MCP); they can't approve or resume. Your CLI tokens act as you."
    >
      {made && (
        <Card>
          <SecretOnce title={`Key for ${made.name}`} value={made.key} onDone={() => setMade(null)} />
        </Card>
      )}
      <Card
        title="Agent keys"
        actions={
          !creating &&
          !made && (
            <button type="button" className="primary" onClick={() => setCreating(true)}>
              Create a key
            </button>
          )
        }
      >
        {creating && data && (
          <form onSubmit={create} className="inset">
            <Field label="Name" help="Who uses it: the agent or the machine.">
              {(p) => <input {...p} value={name} onChange={(e) => setName(e.target.value)} required autoFocus />}
            </Field>
            <fieldset>
              <legend>What it can do</legend>
              {data.scopes.map((s) => (
                <label key={s} className="check">
                  <input
                    type="checkbox"
                    checked={scopes.includes(s)}
                    onChange={(e) => setScopes(e.target.checked ? [...scopes, s] : scopes.filter((x) => x !== s))}
                  />
                  <span>
                    <strong>{s}</strong> <span className="muted">{SCOPE_HELP[s] ?? ""}</span>
                  </span>
                </label>
              ))}
            </fieldset>
            {err && (
              <p className="error" role="alert">
                {err}
              </p>
            )}
            <div className="actions">
              <button type="button" onClick={() => setCreating(false)}>
                Cancel
              </button>
              <button className="primary" type="submit" aria-disabled={busy || !scopes.length}>
                {busy ? "Creating…" : "Create the key"}
              </button>
            </div>
          </form>
        )}
        {!data ? (
          <Loading error={error} retry={reload} />
        ) : data.keys.length === 0 ? (
          <p className="empty">No keys yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="stack">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Scopes</th>
                  <th>Last used</th>
                  <th className="right">
                    <span className="vh">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.keys.map((k) => (
                  <tr key={k.id} className={k.revoked_at ? "muted" : undefined}>
                    <td>
                      <div>{k.name}</div>
                      <div className="muted small">Created {when(k.created_at)}</div>
                    </td>
                    <td data-label="Scopes" className="small">
                      {k.scopes.join(", ")}
                    </td>
                    <td data-label="Last used" className="small">
                      {when(k.last_used_at)}
                    </td>
                    <td className="right">
                      {k.revoked_at ? (
                        <Pill status="revoked" />
                      ) : (
                        <button
                          type="button"
                          className="link danger"
                          onClick={() =>
                            confirm({
                              title: `Revoke "${k.name}"?`,
                              detail: "Whatever uses it stops working at once. This can't be undone.",
                              verb: "Revoke",
                              run: async () => {
                                await withFreshCheck(() => api(`keys/${encodeURIComponent(k.id)}/revoke`, {}));
                                toast({ ok: true, text: `Key "${k.name}" revoked.` });
                                reload();
                              },
                            })
                          }
                        >
                          Revoke
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
      <CliTokens />
      {dialog}
    </Page>
  );
}

interface Token {
  id: string;
  name: string;
  created_at: number;
  last_used_at: number | null;
  expires_at: number;
  revoked_at: number | null;
}

/** The signed-in person's tokens for the bongsu CLI: they act as that person, with their role's rights. */
function CliTokens() {
  const toast = useToast();
  const { data, error, reload } = useLoad<{ rights: string[]; days: number[]; tokens: Token[] }>("tokens");
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [days, setDays] = useState(90);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<{ token: string; name: string } | null>(null);
  const { confirm, dialog } = useConfirm();
  const now = Date.now() / 1000;
  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await withFreshCheck(() => api<{ token: string; name: string }>("tokens", { name, days }));
      setMade(r);
      setCreating(false);
      setName("");
      reload();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {made && (
        <Card>
          <SecretOnce title={`CLI token for ${made.name}`} value={made.token} onDone={() => setMade(null)} />
        </Card>
      )}
      <Card
        title="Your CLI tokens"
        actions={
          !creating &&
          !made && (
            <button type="button" onClick={() => setCreating(true)}>
              Create a token
            </button>
          )
        }
      >
        <p className="muted">
          For the <span className="mono">bongsu</span> command line on your computer. A token acts as you, with your
          rights here{data?.rights.length ? `: ${data.rights.join(", ")}` : ""}. Keep it like a password; revoke it when
          the computer goes.
        </p>
        {creating && data && (
          <form onSubmit={create} className="inset">
            <Field label="Name" help="The computer it's for.">
              {(p) => <input {...p} value={name} onChange={(e) => setName(e.target.value)} required />}
            </Field>
            <Field label="Lasts">
              {(p) => (
                <select {...p} value={days} onChange={(e) => setDays(Number(e.target.value))}>
                  {data.days.map((d) => (
                    <option key={d} value={d}>
                      {d} days
                    </option>
                  ))}
                </select>
              )}
            </Field>
            {err && (
              <p className="error" role="alert">
                {err}
              </p>
            )}
            <div className="actions">
              <button type="button" onClick={() => setCreating(false)}>
                Cancel
              </button>
              <button className="primary" type="submit" aria-disabled={busy}>
                {busy ? "Creating…" : "Create the token"}
              </button>
            </div>
          </form>
        )}
        {!data ? (
          <Loading error={error} retry={reload} />
        ) : data.tokens.length === 0 ? (
          <p className="empty">No tokens yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="stack">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Expires</th>
                  <th>Last used</th>
                  <th className="right">
                    <span className="vh">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.tokens.map((t) => (
                  <tr key={t.id} className={t.revoked_at || t.expires_at <= now ? "muted" : undefined}>
                    <td>
                      <div>{t.name}</div>
                      <div className="muted small">Created {when(t.created_at)}</div>
                    </td>
                    <td data-label="Expires" className="small">
                      {when(t.expires_at)}
                    </td>
                    <td data-label="Last used" className="small">
                      {when(t.last_used_at)}
                    </td>
                    <td className="right">
                      {t.revoked_at ? (
                        <Pill status="revoked" />
                      ) : t.expires_at <= now ? (
                        <Pill status="disabled" label="Expired" />
                      ) : (
                        <button
                          type="button"
                          className="link danger"
                          onClick={() =>
                            confirm({
                              title: `Revoke "${t.name}"?`,
                              detail: "The CLI using it stops working at once. This can't be undone.",
                              verb: "Revoke",
                              run: async () => {
                                await withFreshCheck(() => api(`tokens/${encodeURIComponent(t.id)}/revoke`, {}));
                                toast({ ok: true, text: `Token "${t.name}" revoked.` });
                                reload();
                              },
                            })
                          }
                        >
                          Revoke
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
      {dialog}
    </>
  );
}
