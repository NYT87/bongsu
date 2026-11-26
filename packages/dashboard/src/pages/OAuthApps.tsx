// OAuth apps: the instance's own app credentials for each provider.

import { type FormEvent, useState } from "react";
import { api, when, withFreshCheck } from "../api";
import { GuideLink } from "../docs";
import { Card, Field, Loading, Page, Pill, useConfirm, useLoad, useToast } from "../ui";
import { errorText, type Props } from "./common";

// ---- OAuth apps

export interface OAuthApp {
  id: string;
  clientId: string | null;
  updatedAt: number | null;
  /** A workspace's list only: the instance has an app of this id too, which a workspace without its own uses. */
  instance?: boolean;
  providers: { provider: string; label: string; redirectUri: string }[];
}

const APP_GUIDE: Record<string, { title: string; idLabel: string; secretLabel: string; docs: string }> = {
  meta: {
    title: "Meta app (Instagram)",
    idLabel: "Instagram app ID",
    secretLabel: "Instagram app secret",
    docs: "site/docs/instagram-graph.md",
  },
  google: {
    title: "Google app (YouTube)",
    idLabel: "Client ID",
    secretLabel: "Client secret",
    docs: "site/docs/youtube.md",
  },
};

export function OAuthApps(_: Props) {
  const { data, error, reload } = useLoad<{ apps: OAuthApp[]; encryptionKeySet: boolean }>("oauth-apps");
  return (
    <Page
      title="OAuth apps"
      intro="Your own Meta and Google apps: Bongsu signs in to Instagram and YouTube with them. Make each app once, register the redirect URL shown here, then paste its id and secret."
    >
      {!data ? (
        <Loading error={error} retry={reload} />
      ) : (
        <>
          {!data.encryptionKeySet && (
            <p className="notice bad" role="alert">
              ENCRYPTION_KEY isn't set on the Worker: app secrets and tokens can't be stored until it is (see{" "}
              <GuideLink doc="deploy-cloudflare">the deploy guide</GuideLink>).
            </p>
          )}
          {data.apps.map((a) => (
            <AppCard key={a.id} app={a} onChange={reload} />
          ))}
        </>
      )}
    </Page>
  );
}

export function AppCard({
  app,
  onChange,
  base = "oauth-apps",
}: {
  app: OAuthApp;
  onChange: () => void;
  base?: string;
}) {
  const workspace = base !== "oauth-apps";
  const g = APP_GUIDE[app.id] ?? { title: app.id, idLabel: "Client ID", secretLabel: "Client secret", docs: "" };
  // a workspace with no app of its own, on an instance that has one: collapsed, the instance's app is in use
  const [editing, setEditing] = useState(!app.clientId && !(workspace && app.instance));
  const [clientId, setClientId] = useState(app.clientId ?? "");
  const [secret, setSecret] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const { confirm, dialog } = useConfirm();
  const toast = useToast();
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      await withFreshCheck(() => api(`${base}/${app.id}`, { clientId, clientSecret: secret }));
      toast({ ok: true, text: `${g.title} saved.` });
      setSecret("");
      setEditing(false);
      onChange();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card
      title={g.title}
      actions={
        app.clientId ? (
          <Pill status="ok" label="Set" />
        ) : workspace && app.instance ? (
          <Pill status="ok" label="Instance's" />
        ) : (
          <Pill status="waiting" label="Not set" />
        )
      }
    >
      <p className="muted small">
        Redirect URL{app.providers.length > 1 ? "s" : ""} to register in the app (
        {g.docs ? <GuideLink doc={g.docs}>the setup guide</GuideLink> : "its settings"} shows where):
      </p>
      {workspace && !app.clientId && !app.instance && <p className="small">The instance has none: add yours.</p>}
      <ul className="redirects">
        {app.providers.map((p) => (
          <li key={p.provider}>
            <code className="mono">{p.redirectUri}</code>
            <button
              type="button"
              className="link"
              onClick={async () => {
                await navigator.clipboard.writeText(p.redirectUri);
                setCopied(p.provider);
              }}
            >
              {copied === p.provider ? "Copied" : "Copy"}
            </button>
            {app.providers.length > 1 && <span className="muted small">{p.label}</span>}
          </li>
        ))}
      </ul>
      <span className="vh" aria-live="polite">
        {copied ? "Copied to the clipboard" : ""}
      </span>
      {editing ? (
        <form onSubmit={save}>
          <Field label={g.idLabel}>
            {(p) => (
              <input
                {...p}
                className="mono"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                required
              />
            )}
          </Field>
          <Field label={g.secretLabel} help="Stored encrypted; it isn't shown again." error={err}>
            {(p) => (
              <input
                {...p}
                type="password"
                className="mono"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                autoComplete="off"
                required
              />
            )}
          </Field>
          <div className="actions">
            {(app.clientId || (workspace && app.instance)) && (
              <button type="button" onClick={() => setEditing(false)}>
                Cancel
              </button>
            )}
            <button className="primary" type="submit" aria-disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
      ) : !app.clientId ? (
        <div className="row spread">
          <span className="small muted">Uses the instance's app.</span>
          <button type="button" onClick={() => setEditing(true)}>
            Add your own
          </button>
        </div>
      ) : (
        <div className="row spread">
          <span className="small">
            <span className="muted">{g.idLabel}:</span> <span className="mono">{app.clientId}</span>
            {app.updatedAt && <span className="muted"> · saved {when(app.updatedAt)}</span>}
          </span>
          <span className="row">
            <button type="button" onClick={() => setEditing(true)}>
              Replace
            </button>
            <button
              type="button"
              className="danger"
              onClick={() =>
                confirm({
                  title: `Remove the ${g.title}?`,
                  detail: workspace
                    ? `Connections already made keep working (they carry their own tokens); new ones and reconnects use ${app.instance ? "the instance's app" : "an app again, and the instance has none"}.`
                    : "Connections already made keep working (they carry their own tokens); new ones and reconnects need an app again.",
                  verb: "Remove",
                  run: async () => {
                    await withFreshCheck(() => api(`${base}/${app.id}/remove`, {}));
                    toast({ ok: true, text: `${g.title} removed.` });
                    setClientId("");
                    setEditing(!(workspace && app.instance));
                    onChange();
                  },
                })
              }
            >
              Remove
            </button>
          </span>
        </div>
      )}
      {dialog}
    </Card>
  );
}
