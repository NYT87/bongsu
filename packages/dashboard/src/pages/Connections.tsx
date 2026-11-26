// Connections: the platforms' accounts, connected by OAuth or by pasting a token.

import { type FormEvent, useEffect, useState } from "react";
import { api, when, withFreshCheck } from "../api";
import { GuideLink } from "../docs";
import { Card, Field, Loading, Page, Pill, useConfirm, useLoad, useToast } from "../ui";
import { count, errorText, type Props } from "./common";

// ---- Connections

interface ConnectKind {
  provider: string;
  kind: "token" | "oauth2" | "composio";
  label: string;
  platform: string;
  app?: string;
  canPaste: boolean;
  pasteToken?: boolean;
  docs: string;
}

interface Connection {
  id: string;
  provider: string;
  label: string | null;
  status: string;
  expires_at: number | null;
  last_error: string | null;
  last_checked_at: number | null;
  accounts: string[];
}

const APP_NAME: Record<string, string> = { meta: "Meta app", google: "Google app", threads: "Threads app" };

/** Sends the browser to the provider's sign-in (after a passkey check when the last one is old). */
async function startConnect(provider: string, reconnect?: string) {
  const r = await withFreshCheck(() =>
    api<{ url: string }>(`connect/${encodeURIComponent(provider)}/start`, reconnect ? { reconnect } : {}),
  );
  location.assign(r.url);
}

const PROVIDER_NAME: Record<string, string> = { instagram: "Instagram", youtube: "YouTube", threads: "Threads" };

/** What the provider's redirect back says (…/connections?connected=… or ?error=…), as a toast, once. */
function useReturn() {
  const toast = useToast();
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    if (q.has("connected"))
      toast({
        ok: true,
        text: `${PROVIDER_NAME[q.get("connected") ?? ""] ?? q.get("connected")} connected: ${count(Number(q.get("accounts") ?? 1), "account")}.`,
      });
    else if (q.has("error")) toast({ ok: false, text: `Couldn't connect: ${q.get("error")}` });
    else return;
    history.replaceState(null, "", location.pathname);
  }, [toast]);
}

export function Connections({ go }: Props) {
  const toast = useToast();
  const { data, error, reload } = useLoad<{ connections: Connection[]; kinds: ConnectKind[]; appsReady: string[] }>(
    "connections",
  );
  useReturn();
  const [err, setErr] = useState<string | null>(null);
  const [paste, setPaste] = useState<ConnectKind | null>(null);
  const { confirm, dialog } = useConfirm();
  const kind = (p: string) => data?.kinds.find((k) => k.provider === p);
  /** A greyed-out Connect/Reconnect still answers a click (a tooltip never shows on a phone): it says why and goes
   *  where the fix is. */
  const needApp = (app?: string) => {
    toast({ ok: false, text: `Add your ${APP_NAME[app ?? ""] ?? "OAuth app"} first, then connect.` });
    go("apps");
  };
  const connect = async (provider: string, reconnect?: string) => {
    setErr(null);
    try {
      await startConnect(provider, reconnect);
    } catch (e) {
      setErr(errorText(e));
    }
  };
  return (
    <Page
      title="Connections"
      intro="How Bongsu reaches each platform: a login or token per provider. One connection can reach several accounts."
    >
      {err && (
        <p className="error" role="alert">
          {err}
        </p>
      )}
      {!data ? (
        <Loading error={error} retry={reload} />
      ) : (
        <>
          <Card title="Connected">
            {data.connections.length === 0 ? (
              <p className="empty">No connections yet: add one below.</p>
            ) : (
              <div className="table-wrap">
                <table className="stack">
                  <thead>
                    <tr>
                      <th>Connection</th>
                      <th>Status</th>
                      <th>Accounts</th>
                      <th>Expires</th>
                      <th className="right">
                        <span className="vh">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.connections.map((c) => {
                      const k = kind(c.provider);
                      return (
                        <tr key={c.id}>
                          <td>
                            <div>{c.label ?? c.id}</div>
                            <div className="muted small">{k?.label ?? c.provider}</div>
                            {c.last_error && <div className="error small">{c.last_error}</div>}
                          </td>
                          <td data-label="Status">
                            <Pill status={c.status} />
                          </td>
                          <td data-label="Accounts" className="small">
                            {c.accounts.join(", ") || <span className="muted">none</span>}
                          </td>
                          <td data-label="Expires" className="small nowrap">
                            {c.expires_at ? when(c.expires_at) : "—"}
                          </td>
                          <td className="right nowrap">
                            {k?.kind === "oauth2" && (
                              <button
                                type="button"
                                className="link"
                                aria-disabled={!data.appsReady.includes(k.app ?? "")}
                                title={
                                  data.appsReady.includes(k.app ?? "")
                                    ? undefined
                                    : `Add your ${APP_NAME[k.app ?? ""] ?? "OAuth app"} first`
                                }
                                onClick={() =>
                                  data.appsReady.includes(k.app ?? "") ? connect(c.provider, c.id) : needApp(k.app)
                                }
                              >
                                Reconnect
                              </button>
                            )}
                            <button
                              type="button"
                              className="link danger"
                              onClick={() =>
                                confirm({
                                  title: `Remove ${c.label ?? c.id}?`,
                                  detail:
                                    "Its accounts stay, with their plans, but nothing is published to them until they're connected again. Bongsu's access is revoked where the provider allows it.",
                                  verb: "Remove",
                                  run: async () => {
                                    await withFreshCheck(() =>
                                      api(`connections/${encodeURIComponent(c.id)}/remove`, {}),
                                    );
                                    toast({
                                      ok: true,
                                      text: `Removed ${c.label ?? c.id}: its accounts keep their plans.`,
                                    });
                                    reload();
                                  },
                                })
                              }
                            >
                              Remove
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
          <Card title="Add a connection">
            <ul className="connect-list">
              {data.kinds.map((k) => {
                const ready = !k.app || data.appsReady.includes(k.app);
                return (
                  <li key={k.provider}>
                    <div>
                      <strong>{k.label}</strong>
                      <div className="muted small">
                        {k.kind === "composio"
                          ? "Paste the connected-account id from Composio."
                          : k.kind === "token"
                            ? "Paste the handle and an app password."
                            : ready
                              ? "Sign in with the account and allow access."
                              : `Needs your ${APP_NAME[k.app ?? ""] ?? "OAuth app"}: `}
                        {!ready && (
                          <button type="button" className="link inline" onClick={() => go("apps")}>
                            add it
                          </button>
                        )}
                        <span aria-hidden="true"> · </span>
                        <GuideLink doc={k.docs}>Setup guide</GuideLink>
                      </div>
                    </div>
                    <div className="row">
                      {k.canPaste && (
                        <button type="button" onClick={() => setPaste(k)}>
                          {k.kind === "composio"
                            ? "Paste the id"
                            : k.kind === "token"
                              ? "Paste the app password"
                              : "Paste a token"}
                        </button>
                      )}
                      {k.kind === "oauth2" && (
                        <button
                          type="button"
                          className="primary"
                          aria-disabled={!ready}
                          onClick={() => (ready ? connect(k.provider) : needApp(k.app))}
                        >
                          Connect
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
            {paste && (
              <PasteForm
                kind={paste}
                onClose={() => setPaste(null)}
                onDone={(text) => {
                  setPaste(null);
                  toast({ ok: true, text });
                  reload();
                }}
              />
            )}
          </Card>
          {dialog}
        </>
      )}
    </Page>
  );
}

/** A long-lived token (Instagram) or a Composio connected-account id, checked with the provider before it's kept. */
function PasteForm({
  kind,
  onClose,
  onDone,
}: {
  kind: ConnectKind;
  onClose: () => void;
  onDone: (result: string) => void;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const composio = kind.kind === "composio";
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await withFreshCheck(() =>
        api<{ label: string; accounts: { id: string; created: boolean }[] }>(
          `connect/${encodeURIComponent(kind.provider)}/paste`,
          { value },
        ),
      );
      onDone(`Connected ${r.label}: ${r.accounts.map((a) => a.id + (a.created ? " (new)" : "")).join(", ")}.`);
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="inset">
      <Field
        label={
          composio
            ? "Connected-account id"
            : kind.kind === "token"
              ? `${kind.label}: handle:app-password`
              : `${kind.label}: long-lived token`
        }
        help={
          composio
            ? "From Composio's dashboard (ca_…). Only the id is kept; Composio holds the login."
            : kind.kind === "token"
              ? "Like demo_travel.bsky.social:aaaa-bbbb-cccc-dddd. Stored encrypted; Bongsu checks it weekly."
              : "Stored encrypted. Bongsu renews it before its 60 days run out."
        }
        error={err}
      >
        {(p) => (
          <input
            {...p}
            className="mono"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            required
          />
        )}
      </Field>
      <div className="actions">
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <button className="primary" type="submit" aria-disabled={busy}>
          {busy ? "Checking…" : "Connect"}
        </button>
      </div>
    </form>
  );
}
