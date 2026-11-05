// The dashboard's sections (DESIGN.md, Layout). Each gets the instance state and `go` to move to another section.
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import type { State } from "./App";
import { api, manages, switchWorkspace, when, withFreshCheck } from "./api";
import { GuideLink } from "./docs";
import { Brand, Card, Field, Loading, Page, Pill, QrCode, SecretOnce, useConfirm, useLoad, useToast } from "./ui";

interface Props {
  state: State;
  go: (section: string) => void;
}

const errorText = (e: unknown) => (e as Error).message;

// ---- Overview

interface Overview {
  dryRun: boolean;
  accounts: number;
  connections: Record<string, number>;
  keys: number;
  passkeys: number;
  recoveryCodesLeft: number;
  waitingApproval: number;
  setup: Setup;
}
interface Setup {
  timezone: boolean;
  oauthApp: boolean;
  mediaStore: boolean;
  connection: boolean;
  device: boolean;
}
const setupDone = (s: Setup) => Object.values(s).filter(Boolean).length;
const SETUP_STEPS = 5;

export function Overview({ state, go }: Props) {
  const { data, error, reload } = useLoad<Overview>("overview");
  // an editor sees the numbers; setting up and the connections are the admins' (an editor can't open those pages)
  const admin = manages(state);
  const conns = data ? Object.values(data.connections).reduce((a, b) => a + b, 0) : 0;
  const broken = (data?.connections.broken ?? 0) + (data?.connections.expiring ?? 0);
  return (
    <Page title="Overview" intro="What this instance publishes with, and what needs you.">
      {!data ? (
        <Loading error={error} retry={reload} />
      ) : (
        <div className="overview">
          {admin && setupDone(data.setup) < SETUP_STEPS && (
            <div className="banner setup" role="status">
              <span>
                <strong>Finish setting up:</strong> {setupDone(data.setup)} of {SETUP_STEPS} done.
              </span>
              <button type="button" className="primary" onClick={() => go("start")}>
                Continue
              </button>
            </div>
          )}
          <div className="grid stats">
            <Stat label="Accounts" value={data.accounts} onClick={() => go("accounts")} />
            <Stat
              label="Connections"
              value={conns}
              note={broken ? `${broken} need attention` : undefined}
              onClick={admin ? () => go("connections") : undefined}
            />
            <Stat label="Waiting for approval" value={data.waitingApproval} note="Approve in the Bongsu app" />
            <Stat label="Agent keys" value={data.keys} onClick={() => go("keys")} />
          </div>
          <Card title="Needs you">
            <ul className="todo">
              {admin && conns === 0 && (
                <Todo
                  text="Connect an account to publish to."
                  action="Connect an account"
                  onClick={() => go("connections")}
                />
              )}
              {admin && broken > 0 && (
                <Todo
                  text={`${broken} connection(s) are expiring or broken.`}
                  action="Reconnect"
                  onClick={() => go("connections")}
                />
              )}
              {data.passkeys < 2 && (
                <Todo
                  text="Add a second passkey or another device, so losing one doesn't lock you out."
                  action="Add a passkey"
                  onClick={() => go("devices")}
                />
              )}
              {data.recoveryCodesLeft < 3 && (
                <Todo
                  text={
                    data.recoveryCodesLeft
                      ? `Only ${data.recoveryCodesLeft} recovery codes left: make new ones.`
                      : "No recovery codes left: make new ones."
                  }
                  action="Make new codes"
                  onClick={() => go("devices")}
                />
              )}
              {/* Dry run isn't repeated here: the banner above every page says it. */}
              {(!admin || (conns > 0 && !broken)) && data.passkeys >= 2 && data.recoveryCodesLeft >= 3 && (
                <li className="muted">Nothing: all good.</li>
              )}
            </ul>
          </Card>
        </div>
      )}
    </Page>
  );
}

function Stat({ label, value, note, onClick }: { label: string; value: number; note?: string; onClick?: () => void }) {
  // The label row is the same in every card (with or without "View"), so the numbers line up.
  const inner = (
    <>
      <div className="stat-head">
        <span className="muted small">{label}</span>
        {onClick && (
          <span className="go" aria-hidden="true">
            View
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              aria-hidden="true"
            >
              <path d="m9 6 6 6-6 6" />
            </svg>
          </span>
        )}
      </div>
      <div className="stat">{value}</div>
      {note && <div className="small muted">{note}</div>}
    </>
  );
  return onClick ? (
    <button type="button" className="card stat-card" onClick={onClick}>
      {inner}
    </button>
  ) : (
    <div className="card stat-card">{inner}</div>
  );
}

const Todo = ({ text, action, onClick }: { text: string; action?: string; onClick?: () => void }) => (
  <li>
    {text}{" "}
    {onClick && (
      <button type="button" className="link" onClick={onClick}>
        {action}
      </button>
    )}
  </li>
);

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

const APP_NAME: Record<string, string> = { meta: "Meta app", google: "Google app" };

/** Sends the browser to the provider's sign-in (after a passkey check when the last one is old). */
async function startConnect(provider: string, reconnect?: string) {
  const r = await withFreshCheck(() =>
    api<{ url: string }>(`connect/${encodeURIComponent(provider)}/start`, reconnect ? { reconnect } : {}),
  );
  location.assign(r.url);
}

const PROVIDER_NAME: Record<string, string> = { instagram: "Instagram", youtube: "YouTube" };
const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

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
                          {k.kind === "composio" ? "Paste the id" : "Paste a token"}
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
        label={composio ? "Connected-account id" : `${kind.label}: long-lived token`}
        help={
          composio
            ? "From Composio's dashboard (ca_…). Only the id is kept; Composio holds the login."
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

// ---- Media stores

interface StoreInfo {
  kind: "drive" | "s3" | "local";
  default: boolean;
  settings: Record<string, unknown>;
  hasCredentials: boolean;
  status: string;
  lastError: string | null;
  lastCheckedAt: string | null;
  waitingApprovals: number;
}
const STORE_NAME: Record<string, string> = {
  drive: "Google Drive",
  s3: "S3-compatible bucket",
  local: "This server's disk",
};
/** What the S3 form's presets fill in (the endpoint's <placeholders> are the owner's to replace). */
const S3_PRESETS: Record<string, { label: string; endpoint: string; region: string; pathStyle: boolean }> = {
  aws: { label: "AWS S3", endpoint: "https://s3.eu-west-1.amazonaws.com", region: "eu-west-1", pathStyle: false },
  r2: {
    label: "Cloudflare R2",
    endpoint: "https://<account id>.r2.cloudflarestorage.com",
    region: "auto",
    pathStyle: true,
  },
  b2: {
    label: "Backblaze B2",
    endpoint: "https://s3.us-west-004.backblazeb2.com",
    region: "us-west-004",
    pathStyle: false,
  },
  other: { label: "MinIO or other", endpoint: "https://", region: "us-east-1", pathStyle: true },
};
const storeWhere = (s: StoreInfo) =>
  s.kind === "s3"
    ? `${String(s.settings.bucket ?? "")}${s.settings.prefix ? `/${String(s.settings.prefix)}` : ""} · ${String(s.settings.endpoint ?? "")}`
    : s.kind === "drive"
      ? "UPLOADS/ in the connected Drive"
      : "the server's media folder";

/** Where the media live: the stores side by side, one default; Drive with its button, a bucket with a form. */
export function Media({ go }: Props) {
  const toast = useToast();
  const { data, error, reload } = useLoad<{
    stores: StoreInfo[];
    offered: string[];
    googleApp: boolean;
    encryptionKeySet: boolean;
  }>("media-stores");
  const { confirm, dialog } = useConfirm();
  const [err, setErr] = useState<string | null>(null);
  const [form, setForm] = useState(false);
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    if (q.has("connected")) toast({ ok: true, text: "Google Drive connected: it's a media store now." });
    else if (q.has("error")) toast({ ok: false, text: `Couldn't connect Google Drive: ${q.get("error")}` });
    else return;
    history.replaceState(null, "", location.pathname);
  }, [toast]);
  const act = async (run: () => Promise<unknown>, done: string) => {
    setErr(null);
    try {
      await run();
      toast({ ok: true, text: done });
      reload();
    } catch (e) {
      setErr(errorText(e));
    }
  };
  const connectDrive = async () => {
    setErr(null);
    try {
      const r = await withFreshCheck(() => api<{ url: string }>("media-stores/drive/start", {}));
      location.assign(r.url);
    } catch (e) {
      setErr(errorText(e));
    }
  };
  const has = (k: string) => !!data?.stores.some((s) => s.kind === k);
  return (
    <Page
      title="Media"
      intro="Where your Reels and photos live: Bongsu only keeps references to them. Set up one store or several; each file is read from the store it's in, and uploads from the app go to the one you pick."
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
          {!data.encryptionKeySet && (
            <p className="banner" role="status">
              Set the ENCRYPTION_KEY secret first: a store's keys and grants are stored encrypted with it.
            </p>
          )}
          <Card title="Your stores">
            {data.stores.length === 0 ? (
              <p className="empty">No media store yet: add one below. Nothing with media can be approved until then.</p>
            ) : (
              <div className="table-wrap">
                <table className="stack">
                  <thead>
                    <tr>
                      <th>Store</th>
                      <th>Status</th>
                      <th>Checked</th>
                      <th className="right">
                        <span className="vh">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.stores.map((s) => (
                      <tr key={s.kind}>
                        <td>
                          <div>
                            {STORE_NAME[s.kind]} {s.default && <span className="muted small">(default)</span>}
                          </div>
                          <div className="muted small">{storeWhere(s)}</div>
                          {s.lastError && <div className="error small">{s.lastError}</div>}
                        </td>
                        <td data-label="Status">
                          <Pill status={s.status} />
                        </td>
                        <td data-label="Checked" className="small nowrap">
                          {s.lastCheckedAt ? when(Date.parse(s.lastCheckedAt) / 1000) : "—"}
                        </td>
                        <td className="right nowrap">
                          <button
                            type="button"
                            className="link"
                            onClick={() =>
                              act(async () => {
                                const r = await api<{ ok: boolean; error: string | null }>(
                                  `media-stores/${s.kind}/test`,
                                  s.kind === "s3" ? s.settings : {},
                                );
                                if (!r.ok) throw new Error(`${STORE_NAME[s.kind]} didn't answer: ${r.error}`);
                              }, `${STORE_NAME[s.kind]} answers: it can read and write.`)
                            }
                          >
                            Test
                          </button>
                          {!s.default && (
                            <button
                              type="button"
                              className="link"
                              onClick={() =>
                                act(
                                  () => api(`media-stores/${s.kind}/default`, {}),
                                  `${STORE_NAME[s.kind]} is the default now.`,
                                )
                              }
                            >
                              Make default
                            </button>
                          )}
                          <button
                            type="button"
                            className="link danger"
                            onClick={() =>
                              confirm({
                                title: `Remove ${STORE_NAME[s.kind]}?`,
                                detail: `Its files stay where they are, but Bongsu can't read them any more${
                                  s.waitingApprovals
                                    ? `: ${count(s.waitingApprovals, "waiting approval")} will need approving again`
                                    : ""
                                }.`,
                                verb: "Remove",
                                run: async () => {
                                  await withFreshCheck(() => api(`media-stores/${s.kind}/remove`, {}));
                                  toast({ ok: true, text: `Removed ${STORE_NAME[s.kind]}.` });
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
          {data.offered.includes("drive") && (
            <Card title={has("drive") ? "Google Drive: connect again" : "Add Google Drive"}>
              <p className="muted">
                Drop files in a folder named UPLOADS in your Drive; Bongsu reads them and moves posted ones to
                UPLOADS/_posted. It connects with your Google app (the one YouTube uses), which needs this page's
                redirect URL: <GuideLink doc="site/docs/drive.md">the Drive guide</GuideLink>.
              </p>
              <div className="actions">
                {data.googleApp ? (
                  <button type="button" className={has("drive") ? "" : "primary"} onClick={connectDrive}>
                    {has("drive") ? "Connect again" : "Connect Google Drive"}
                  </button>
                ) : (
                  <button type="button" onClick={() => go("apps")}>
                    Add your Google app first
                  </button>
                )}
              </div>
            </Card>
          )}
          <Card title={has("s3") ? "S3-compatible bucket: change it" : "Add an S3-compatible bucket"}>
            <p className="muted">
              AWS S3, Cloudflare R2, Backblaze B2, MinIO and others. Instagram fetches the files straight from the
              bucket and the app uploads straight to it: <GuideLink doc="site/docs/s3.md">the bucket guide</GuideLink>{" "}
              has the keys to make and the CORS rule uploads need.
            </p>
            {form ? (
              <S3Form
                saved={data.stores.find((s) => s.kind === "s3")}
                onClose={() => setForm(false)}
                onDone={() => {
                  setForm(false);
                  toast({ ok: true, text: "The bucket is saved: it answered, reading and writing." });
                  reload();
                }}
              />
            ) : (
              <div className="actions">
                <button type="button" className={data.stores.length ? "" : "primary"} onClick={() => setForm(true)}>
                  {has("s3") ? "Change the bucket" : "Add a bucket"}
                </button>
              </div>
            )}
          </Card>
          {data.offered.includes("local") && !has("local") && (
            <Card title="Add this server's disk">
              <p className="muted">
                The media folder of this server (MEDIA_DIR; /media in Docker). Copy files into UPLOADS/inbox there.
              </p>
              <div className="actions">
                <button
                  type="button"
                  onClick={() =>
                    act(
                      () => withFreshCheck(() => api("media-stores/local", {})),
                      "This server's disk is a media store now.",
                    )
                  }
                >
                  Use this server's disk
                </button>
              </div>
            </Card>
          )}
        </>
      )}
      {dialog}
    </Page>
  );
}

function S3Form({ saved, onClose, onDone }: { saved?: StoreInfo; onClose: () => void; onDone: () => void }) {
  const init = (k: string, d: string) => String(saved?.settings[k] ?? d);
  const [v, setV] = useState({
    endpoint: init("endpoint", S3_PRESETS.aws.endpoint),
    region: init("region", S3_PRESETS.aws.region),
    bucket: init("bucket", ""),
    prefix: init("prefix", ""),
    pathStyle: saved ? !!saved.settings.pathStyle : S3_PRESETS.aws.pathStyle,
    accessKeyId: "",
    secretAccessKey: "",
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV({ ...v, [k]: e.target.value });
  const preset = (id: string) => {
    const p = S3_PRESETS[id];
    if (p) setV({ ...v, endpoint: p.endpoint, region: p.region, pathStyle: p.pathStyle });
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      await withFreshCheck(() => api("media-stores/s3", v));
      onDone();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="inset">
      <Field label="Service" help="Fills in the endpoint and region; replace what's in <brackets>.">
        {(p) => (
          <select {...p} defaultValue="" onChange={(e) => preset(e.target.value)}>
            <option value="" disabled>
              Pick one…
            </option>
            {Object.entries(S3_PRESETS).map(([id, x]) => (
              <option key={id} value={id}>
                {x.label}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field label="Endpoint">
        {(p) => (
          <input {...p} className="mono" value={v.endpoint} onChange={set("endpoint")} required spellCheck={false} />
        )}
      </Field>
      <Field label="Region">
        {(p) => <input {...p} className="mono" value={v.region} onChange={set("region")} required spellCheck={false} />}
      </Field>
      <Field label="Bucket">
        {(p) => <input {...p} className="mono" value={v.bucket} onChange={set("bucket")} required spellCheck={false} />}
      </Field>
      <Field label="Folder in the bucket" help="Optional: Bongsu keeps everything under it (bongsu/).">
        {(p) => <input {...p} className="mono" value={v.prefix} onChange={set("prefix")} spellCheck={false} />}
      </Field>
      <label className="check">
        <input type="checkbox" checked={v.pathStyle} onChange={(e) => setV({ ...v, pathStyle: e.target.checked })} />{" "}
        Path-style addresses (endpoint/bucket/key: MinIO and most self-hosted services)
      </label>
      <Field
        label="Access key id"
        help={saved?.hasCredentials ? "Leave both empty to keep the saved keys." : "A key for this bucket only."}
      >
        {(p) => (
          <input
            {...p}
            className="mono"
            value={v.accessKeyId}
            onChange={set("accessKeyId")}
            autoComplete="off"
            spellCheck={false}
          />
        )}
      </Field>
      <Field label="Secret access key" help="Stored encrypted; never shown again." error={err}>
        {(p) => (
          <input
            {...p}
            className="mono"
            type="password"
            value={v.secretAccessKey}
            onChange={set("secretAccessKey")}
            autoComplete="off"
          />
        )}
      </Field>
      <div className="actions">
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <button className="primary" type="submit" aria-disabled={busy}>
          {busy ? "Testing…" : "Test and save"}
        </button>
      </div>
    </form>
  );
}

// ---- OAuth apps

interface OAuthApp {
  id: string;
  clientId: string | null;
  updatedAt: number | null;
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

function AppCard({ app, onChange }: { app: OAuthApp; onChange: () => void }) {
  const g = APP_GUIDE[app.id] ?? { title: app.id, idLabel: "Client ID", secretLabel: "Client secret", docs: "" };
  const [editing, setEditing] = useState(!app.clientId);
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
      await withFreshCheck(() => api(`oauth-apps/${app.id}`, { clientId, clientSecret: secret }));
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
      actions={app.clientId ? <Pill status="ok" label="Set" /> : <Pill status="waiting" label="Not set" />}
    >
      <p className="muted small">
        Redirect URL{app.providers.length > 1 ? "s" : ""} to register in the app (
        {g.docs ? <GuideLink doc={g.docs}>the setup guide</GuideLink> : "its settings"} shows where):
      </p>
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
            {app.clientId && (
              <button type="button" onClick={() => setEditing(false)}>
                Cancel
              </button>
            )}
            <button className="primary" type="submit" aria-disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
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
                  detail:
                    "Connections already made keep working (they carry their own tokens); new ones and reconnects need an app again.",
                  verb: "Remove",
                  run: async () => {
                    await withFreshCheck(() => api(`oauth-apps/${app.id}/remove`, {}));
                    toast({ ok: true, text: `${g.title} removed.` });
                    setClientId("");
                    setEditing(true);
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

// ---- Accounts

interface Account {
  id: string;
  platform: string;
  handle: string;
  name: string;
  status: string;
  connection: { id: string; provider: string; label: string | null; status: string } | null;
  trialReels: { capable: boolean; on: boolean } | null;
  captionRules: (LintRules & { defaults: LintRules }) | null;
}
/** The caption check's rules (core's formats/caption-lint.ts): what the dashboard lets the owner tune per account. */
interface LintRules {
  hashtagMax: number;
  foldChars: number;
  languageChecks: boolean;
}
interface PlatformInfo {
  id: string;
  name: string;
  accountNoun: string;
  formats: { format: string; plural: string }[];
  features: { comments: boolean };
}

/** One account's caption rules: a number field left empty means the platform's default (shown as the placeholder).
 *  Each change saves its own field only (an emptied field as null, back to the default), so two quick edits can't
 *  overwrite each other. */
function CaptionRulesCell({
  rules,
  save,
}: {
  rules: LintRules & { defaults: LintRules };
  save: (change: { [K in keyof LintRules]?: LintRules[K] | null }) => Promise<boolean>;
}) {
  const { defaults } = rules;
  const shown = (k: "hashtagMax" | "foldChars") => (rules[k] === defaults[k] ? "" : String(rules[k]));
  const [draft, setDraft] = useState({ hashtagMax: shown("hashtagMax"), foldChars: shown("foldChars") });
  const number = (k: "hashtagMax" | "foldChars", label: string, min: number, max: number) => (
    <label>
      <span>{label}</span>
      <input
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        placeholder={String(defaults[k])}
        value={draft[k]}
        onChange={(e) => setDraft({ ...draft, [k]: e.target.value })}
        onBlur={async () => {
          const v = draft[k].trim();
          if (v === shown(k)) return;
          if (!(await save({ [k]: v === "" ? null : Number(v) }))) setDraft({ ...draft, [k]: shown(k) });
        }}
      />
    </label>
  );
  return (
    <div className="rules">
      {number("hashtagMax", "Hashtags max", 0, 30)}
      {number("foldChars", "First line chars", 50, 500)}
      <label className="check">
        <input
          type="checkbox"
          checked={rules.languageChecks}
          onChange={(e) => save({ languageChecks: e.target.checked })}
        />
        Language checks
      </label>
    </div>
  );
}

export function Accounts(_: Props) {
  const toast = useToast();
  const { data, error, reload } = useLoad<{ accounts: Account[]; platforms: PlatformInfo[] }>("accounts");
  const [err, setErr] = useState<string | null>(null);
  const { confirm, dialog } = useConfirm();
  const update = async (id: string, change: Record<string, unknown>) => {
    setErr(null);
    try {
      await api(`accounts/${encodeURIComponent(id)}`, change);
      reload();
      return true;
    } catch (e) {
      setErr(errorText(e));
      return false;
    }
  };
  const platformName = (id: string) => data?.platforms.find((p) => p.id === id)?.name ?? id;
  /** What Bongsu can do with an account: its platform's formats, plus Trial Reels once the account qualifies. */
  const capabilities = (a: Account) => {
    const p = data?.platforms.find((x) => x.id === a.platform);
    const can = p?.formats.map((f) => f.plural) ?? [];
    if (a.trialReels?.capable) can.push("Trial Reels");
    if (!can.length && p?.features.comments) can.push("Comments on posts made elsewhere");
    return can.join(", ") || "—";
  };
  return (
    <Page title="Accounts" intro="The accounts Bongsu publishes to, and their defaults.">
      {!data ? (
        <Loading error={error} retry={reload} />
      ) : (
        <Card>
          {err && (
            <p className="error" role="alert">
              {err}
            </p>
          )}
          {data.accounts.length === 0 ? (
            <p className="empty">No accounts yet: they appear when you add a connection.</p>
          ) : (
            <div className="table-wrap">
              <table className="stack">
                <thead>
                  <tr>
                    <th>Account</th>
                    <th>Publishes</th>
                    <th>Connection</th>
                    <th>Trial Reels by default</th>
                    <th>Caption checks</th>
                    <th>Status</th>
                    <th className="right">
                      <span className="vh">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.accounts.map((a) => (
                    <tr key={a.id}>
                      <td>
                        <div>{a.name}</div>
                        <div className="muted small">
                          {platformName(a.platform)} · @{a.handle}
                        </div>
                      </td>
                      <td data-label="Publishes" className="small">
                        {capabilities(a)}
                      </td>
                      <td data-label="Connection" className="small">
                        {a.connection ? (
                          <>
                            {a.connection.label ?? a.connection.provider} <Pill status={a.connection.status} />
                          </>
                        ) : (
                          <span className="muted">none</span>
                        )}
                      </td>
                      <td data-label="Trial Reels">
                        {a.trialReels ? (
                          <label className="check">
                            <input
                              type="checkbox"
                              checked={a.trialReels.on}
                              disabled={!a.trialReels.capable}
                              onChange={(e) => update(a.id, { trialReels: e.target.checked })}
                            />
                            {a.trialReels.capable ? (a.trialReels.on ? "On" : "Off") : "Not available yet"}
                          </label>
                        ) : (
                          <span className="muted small">—</span>
                        )}
                      </td>
                      <td data-label="Caption checks">
                        {a.captionRules ? (
                          <CaptionRulesCell
                            key={`${a.id}:${a.captionRules.hashtagMax}:${a.captionRules.foldChars}`}
                            rules={a.captionRules}
                            save={(captionRules) => update(a.id, { captionRules })}
                          />
                        ) : (
                          <span className="muted small">—</span>
                        )}
                      </td>
                      <td data-label="Status">
                        <Pill status={a.status} />
                      </td>
                      <td className="right">
                        <button
                          type="button"
                          className="link"
                          onClick={() => {
                            const name = window.prompt("Display name", a.name);
                            if (name !== null) update(a.id, { name });
                          }}
                        >
                          Rename
                        </button>
                        {a.status === "active" ? (
                          <button
                            type="button"
                            className="link danger"
                            onClick={() =>
                              confirm({
                                title: `Disable ${a.name}?`,
                                detail: "Nothing is published to it until you enable it again. Its plan stays.",
                                verb: "Disable",
                                run: async () => {
                                  await api(`accounts/${encodeURIComponent(a.id)}`, { status: "disabled" });
                                  toast({ ok: true, text: `${a.name} disabled: nothing is published to it.` });
                                  reload();
                                },
                              })
                            }
                          >
                            Disable
                          </button>
                        ) : (
                          <>
                            <button
                              type="button"
                              className="link"
                              onClick={() =>
                                update(a.id, { status: "active" }).then(
                                  (ok) => ok && toast({ ok: true, text: `${a.name} enabled.` }),
                                )
                              }
                            >
                              Enable
                            </button>
                            <button
                              type="button"
                              className="link danger"
                              onClick={() =>
                                confirm({
                                  title: `Remove ${a.name}?`,
                                  detail:
                                    "It leaves Bongsu: only possible with nothing left to publish to it. What was published stays in the history.",
                                  verb: "Remove",
                                  run: async () => {
                                    await withFreshCheck(() => api(`accounts/${encodeURIComponent(a.id)}/remove`, {}));
                                    toast({ ok: true, text: `${a.name} removed.` });
                                    reload();
                                  },
                                })
                              }
                            >
                              Remove
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {dialog}
        </Card>
      )}
    </Page>
  );
}

// ---- Videos

interface VideoRow {
  id: string;
  title: string;
  short: boolean;
  status: "public" | "scheduled" | "private" | "unlisted";
  when: string | null;
  url: string;
}
interface VideoList {
  channels: { id: string; name: string; videos: VideoRow[] }[];
  warnings: string[];
}

export function Videos(_: Props) {
  const toast = useToast();
  const [path, setPath] = useState("videos");
  const { data, error, reload } = useLoad<VideoList>(path);
  const [editing, setEditing] = useState<string | null>(null);
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // "Check YouTube now" reads past the hour's cache; the next plain load goes back to it
  const check = () => (path === "videos?refresh=1" ? reload() : setPath("videos?refresh=1"));
  const start = (v: VideoRow) => {
    setEditing(v.id);
    setErr(null);
    const [d, t] = (v.when ?? "").split(" ");
    setDate(d ?? "");
    setTime(t ?? "");
  };
  const save = async (v: VideoRow) => {
    setBusy(true);
    setErr(null);
    try {
      const r = await withFreshCheck(() =>
        api<{ due: string }>(`videos/${encodeURIComponent(v.id)}/release`, { date, time }),
      );
      toast({ ok: true, text: `Moved to ${r.due}.` });
      setEditing(null);
      // a plain load again: it ends "Check YouTube now"'s read past the cache
      if (path === "videos") reload();
      else setPath("videos");
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Page title="Videos" intro="Each YouTube channel's uploads. A scheduled video's release date can move from here.">
      {!data ? (
        <Loading error={error} retry={reload} />
      ) : (
        <>
          <div className="actions">
            <button type="button" onClick={check}>
              Check YouTube now
            </button>
          </div>
          {data.warnings.map((w) => (
            <p key={w} className="error" role="alert">
              {w}
            </p>
          ))}
          {data.channels.length === 0 && (
            <Card>
              <p className="empty">No YouTube channel connected yet.</p>
            </Card>
          )}
          {data.channels.map((ch) => (
            <Card key={ch.id} title={ch.name}>
              {ch.videos.length === 0 ? (
                <p className="empty">No uploads found.</p>
              ) : (
                <div className="table-wrap">
                  <table className="stack">
                    <thead>
                      <tr>
                        <th>Title</th>
                        <th>Kind</th>
                        <th>State</th>
                        <th>When</th>
                        <th className="right">
                          <span className="vh">Actions</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {ch.videos.map((v) => (
                        <tr key={v.id}>
                          <td>
                            <a href={v.url} target="_blank" rel="noreferrer">
                              {v.title}
                            </a>
                          </td>
                          <td data-label="Kind">{v.short ? "Short" : "Video"}</td>
                          <td data-label="State">
                            <Pill status={v.status} />
                          </td>
                          <td data-label="When">{v.when ?? "—"}</td>
                          <td className="right">
                            {v.status !== "scheduled" ? null : editing === v.id ? (
                              <form
                                className="row"
                                onSubmit={(e) => {
                                  e.preventDefault();
                                  save(v);
                                }}
                              >
                                <Field label="Date">
                                  {(p) => (
                                    <input
                                      {...p}
                                      type="date"
                                      required
                                      value={date}
                                      onChange={(e) => setDate(e.target.value)}
                                    />
                                  )}
                                </Field>
                                <Field label="Time">
                                  {(p) => (
                                    <input
                                      {...p}
                                      type="time"
                                      required
                                      value={time}
                                      onChange={(e) => setTime(e.target.value)}
                                    />
                                  )}
                                </Field>
                                <button className="primary" type="submit" aria-disabled={busy}>
                                  Save
                                </button>
                                <button type="button" className="link" onClick={() => setEditing(null)}>
                                  Cancel
                                </button>
                                {err && (
                                  <p className="error" role="alert">
                                    {err}
                                  </p>
                                )}
                              </form>
                            ) : (
                              <button type="button" className="link" onClick={() => start(v)}>
                                Change date
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
          ))}
        </>
      )}
    </Page>
  );
}

// ---- Devices & passkeys

interface Passkeys {
  passkeys: { id: string; short: string; name: string | null; created_at: number; last_used_at: number | null }[];
  devices: { device: string | null; created_at: number }[];
}
interface DeviceCode {
  id: string;
  code: string;
  link: string;
  expiresAt: number;
}

export function Devices(_: Props) {
  const toast = useToast();
  const { data, error, reload } = useLoad<Passkeys>("passkeys");
  const [err, setErr] = useState<string | null>(null);
  const [device, setDevice] = useState<DeviceCode | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const { confirm, dialog } = useConfirm();
  const run = async (fn: () => Promise<void>) => {
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(errorText(e));
    }
  };
  const addPasskey = () =>
    run(async () => {
      const name = window.prompt("Name this passkey (e.g. the computer or key)", "Laptop");
      if (name === null) return;
      await withFreshCheck(async () => {
        const o = await api<{ options: never; challengeId: string }>("passkeys/options", {});
        const response = await startRegistration({ optionsJSON: o.options });
        await api("passkeys/verify", { challengeId: o.challengeId, response, name });
      });
      toast({ ok: true, text: `Passkey "${name}" added.` });
      reload();
    });
  return (
    <Page
      title="Devices & passkeys"
      intro="Your devices approve posts in the Bongsu app; your passkeys sign you in here and in the app."
    >
      {err && (
        <p className="error" role="alert">
          {err}
        </p>
      )}
      <Card
        title="Add a device"
        actions={
          !device && (
            <button
              type="button"
              className="primary"
              onClick={() => run(async () => setDevice(await withFreshCheck(() => api<DeviceCode>("devices", {}))))}
            >
              Add a device
            </button>
          )
        }
      >
        {device ? (
          <DeviceSetup
            device={device}
            onDone={() => {
              setDevice(null);
              reload();
            }}
          />
        ) : (
          <p className="muted">
            Shows a QR code: scan it with the device's camera (a phone or tablet), then it creates its own passkey and
            gets the app.
          </p>
        )}
      </Card>
      <Card
        title="Passkeys"
        actions={
          <button type="button" onClick={addPasskey}>
            Add a passkey here
          </button>
        }
      >
        {!data ? (
          <Loading error={error} retry={reload} />
        ) : (
          <div className="table-wrap">
            <table className="stack">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Added</th>
                  <th>Last used</th>
                  <th className="right">
                    <span className="vh">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.passkeys.map((k) => (
                  <tr key={k.id}>
                    <td>
                      {k.name ?? "passkey"} <span className="muted small mono">{k.short}</span>
                    </td>
                    <td data-label="Added" className="small">
                      {when(k.created_at)}
                    </td>
                    <td data-label="Last used" className="small">
                      {when(k.last_used_at)}
                    </td>
                    <td className="right">
                      <button
                        type="button"
                        className="link"
                        onClick={() => {
                          const name = window.prompt("Rename the passkey", k.name ?? "");
                          if (name)
                            run(async () => {
                              await api(`passkeys/${encodeURIComponent(k.id)}/rename`, { name });
                              reload();
                            });
                        }}
                      >
                        Rename
                      </button>
                      <button
                        type="button"
                        className="link danger"
                        aria-disabled={data.passkeys.length <= 1}
                        title={data.passkeys.length <= 1 ? "Your only passkey: add another one first" : undefined}
                        onClick={() =>
                          data.passkeys.length <= 1
                            ? toast({
                                ok: false,
                                text: "That's your only passkey: add another one (or another device) before removing it.",
                              })
                            : confirm({
                                title: `Remove "${k.name ?? "passkey"}"?`,
                                detail:
                                  "That device can't sign in with it any more (the Bongsu app there stops working too).",
                                verb: "Remove",
                                run: async () => {
                                  await withFreshCheck(() => api(`passkeys/${encodeURIComponent(k.id)}/revoke`, {}));
                                  toast({ ok: true, text: `Passkey "${k.name ?? k.short}" removed.` });
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
        {data && data.devices.length > 0 && (
          <p className="muted small">
            Devices getting notifications: {data.devices.map((d) => d.device ?? "a device").join(", ")}.
          </p>
        )}
      </Card>
      <Card
        title="Recovery codes"
        actions={
          !codes && (
            <button
              type="button"
              onClick={() =>
                confirm({
                  title: "Make new recovery codes?",
                  detail: "The codes you have now stop working.",
                  verb: "Make new codes",
                  run: async () => {
                    const r = await withFreshCheck(() => api<{ recoveryCodes: string[] }>("recovery-codes", {}));
                    setCodes(r.recoveryCodes);
                  },
                })
              }
            >
              Make new codes
            </button>
          )
        }
      >
        {codes ? (
          <SecretOnce title="Your new recovery codes" lines={codes} onDone={() => setCodes(null)} />
        ) : (
          <p className="muted">Each signs you in once when every passkey is lost.</p>
        )}
      </Card>
      {dialog}
    </Page>
  );
}

/** The QR code and the code itself; polls until the device has used it (or it expires). */
function DeviceSetup({ device, onDone }: { device: DeviceCode; onDone: () => void }) {
  const [status, setStatus] = useState<"waiting" | "used" | "expired">("waiting");
  useEffect(() => {
    if (status !== "waiting") return;
    const t = setInterval(() => {
      api<{ used: boolean; expired: boolean }>(`devices/${device.id}`)
        .then((r) => setStatus(r.used ? "used" : r.expired ? "expired" : "waiting"))
        .catch(() => {});
    }, 3000);
    return () => clearInterval(t);
  }, [device.id, status]);
  if (status === "used")
    return (
      <div role="status">
        <p>
          <Pill status="ok" label="Connected" /> The device has its passkey.
        </p>
        <button type="button" className="primary" onClick={onDone}>
          Done
        </button>
      </div>
    );
  if (status === "expired")
    return (
      <div role="status">
        <p className="error">The code expired before the device used it.</p>
        <button type="button" onClick={onDone}>
          Close
        </button>
      </div>
    );
  return (
    <div className="device-setup">
      <QrCode text={device.link} label="QR code that opens the Bongsu app on the device" />
      <div>
        <ol>
          <li>Open the device's camera and point it at the code.</li>
          <li>Open the link, then create the passkey when asked.</li>
          <li>Add the app to the home screen to get notifications.</li>
        </ol>
        <p className="muted small">
          Or open <span className="mono">{device.link.split("/#")[0]}</span> on the device and enter{" "}
          <span className="mono">{device.code}</span>. It works once, until {when(device.expiresAt)}.
        </p>
        <p className="small" aria-live="polite">
          <Pill status="waiting" label="Waiting for the device…" />
        </p>
        <button type="button" className="link" onClick={onDone}>
          Cancel
        </button>
      </div>
    </div>
  );
}

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

// ---- Members

interface Member {
  userId: string;
  email: string | null;
  name: string | null;
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
const ROLE_HELP: Record<string, string> = {
  admin: "Admin: everything in the workspace, including its people, connections and settings.",
  editor: "Editor: the plan and the texts, in the dashboard and the app; can't approve.",
  creator: "Creator: the plan, the texts and approving, in the Bongsu app.",
};
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

// ---- Audit

interface Entry {
  id: number;
  at: number;
  actor: string;
  action: string;
  target: string | null;
  detail: string | null;
  /** The person who acted (name, else email), when a person did. */
  who: string | null;
}

export function Audit({ state }: Props) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState(true);
  // the workspace's log, or (instance admins only) the instance's: new workspaces, media stores, OAuth apps, instance
  // admins. In no workspace, only the instance's.
  const [instance, setInstance] = useState(state.noWorkspace);
  const load = (before?: number) => {
    const q = new URLSearchParams({
      ...(before ? { before: String(before) } : {}),
      ...(instance ? { instance: "1" } : {}),
    }).toString();
    return api<{ entries: Entry[] }>(`audit${q ? `?${q}` : ""}`)
      .then((r) => {
        setEntries((old) => (before ? [...(old ?? []), ...r.entries] : r.entries));
        setMore(r.entries.length === 50);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: reloads when the log shown changes
  useEffect(() => {
    setEntries(null);
    load();
  }, [instance]);
  return (
    <Page
      title="Audit"
      intro={
        instance
          ? "Every change to this instance: who, what, when."
          : "Every change to this workspace: who, what, when."
      }
    >
      <Card
        actions={
          state.instanceAdmin &&
          !state.noWorkspace && (
            <select
              aria-label="Which log"
              value={instance ? "instance" : "workspace"}
              onChange={(e) => setInstance(e.target.value === "instance")}
            >
              <option value="workspace">This workspace</option>
              <option value="instance">The instance</option>
            </select>
          )
        }
      >
        {!entries ? (
          <Loading error={error} retry={() => load()} />
        ) : entries.length === 0 ? (
          <p className="empty">Nothing yet.</p>
        ) : (
          <>
            <div className="table-wrap">
              <table className="stack">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Who</th>
                    <th>What</th>
                    <th>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((e) => (
                    <tr key={e.id}>
                      <td data-label="When" className="small nowrap">
                        {when(e.at)}
                      </td>
                      <td data-label="Who" className="small">
                        {e.who ?? e.actor}
                      </td>
                      <td data-label="What">
                        {e.action.replaceAll("_", " ")}
                        {e.target && <div className="muted small mono">{e.target}</div>}
                      </td>
                      <td data-label="Detail" className="small mono muted">
                        {e.detail && e.detail !== "{}" ? e.detail : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {more && (
              <div className="actions">
                <button type="button" onClick={() => load(entries[entries.length - 1]?.id)}>
                  Load older
                </button>
              </div>
            )}
          </>
        )}
      </Card>
    </Page>
  );
}

// ---- Get started (after sign-up)

/** The hours of the day, for the digest hour pickers. */
const HOURS = Array.from({ length: 24 }, (_, h) => h);

/** The first run, step by step: each step's state comes from the data (overview's `setup`), so the page is right
 *  whatever was done elsewhere, and there's nothing to dismiss. */

// One numbered step of Get started. At module level: defined inside the page, it would be a new component on every
// render and remount its fields (losing focus while typing).
function Step({ n, title, done, children }: { n: number; title: string; done: boolean; children: ReactNode }) {
  return (
    <Card
      title={`${n}. ${title}`}
      actions={done ? <Pill status="ok" label="Done" /> : <Pill status="waiting" label="To do" />}
    >
      {children}
    </Card>
  );
}

/** A Get started step that's the instance's (OAuth apps, media stores): its instance admin's to set up, for every
 *  workspace, so a workspace's admin has nothing to open there. */
const InstanceStep = () => (
  <p className="muted small">Your instance admin sets this up, for every workspace: ask them if it's still to do.</p>
);

export function GetStarted({ state, go }: Props) {
  const { data, error, reload } = useLoad<Overview>("overview");
  const settings = useLoad<{ timezone: string; digestHour: number }>("settings");
  const toast = useToast();
  const [tz, setTz] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [hour, setHour] = useState(8);
  // Once chosen, the form shows the saved zone; before that, this browser's as a suggestion.
  useEffect(() => {
    if (data?.setup.timezone && settings.data) {
      setTz(settings.data.timezone);
      setHour(settings.data.digestHour);
    }
  }, [data?.setup.timezone, settings.data]);
  const [err, setErr] = useState<string | null>(null);
  const zones = Intl.supportedValuesOf?.("timeZone") ?? [];
  const saveZone = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    try {
      await api("settings", { timezone: tz, digestHour: hour });
      toast({ ok: true, text: `Time zone set: ${tz}.` });
      reload();
    } catch (e) {
      setErr(errorText(e));
    }
  };
  return (
    <Page
      title="Get started"
      intro="Five steps from here to your first approved post. Each one can also be done later from its own page."
    >
      {!data ? (
        <Loading error={error} retry={reload} />
      ) : (
        <>
          <Step n={1} title="Your time zone" done={data.setup.timezone}>
            <p className="muted">
              Times in the dashboard, the app and the daily digest use it. Each person can pick their own later.
            </p>
            <form onSubmit={saveZone} className="inline-form">
              <Field label="Time zone">
                {(p) => (
                  <select {...p} value={tz} onChange={(e) => setTz(e.target.value)}>
                    {(zones.includes(tz) ? zones : [tz, ...zones]).map((z) => (
                      <option key={z}>{z}</option>
                    ))}
                  </select>
                )}
              </Field>
              <Field label="Daily digest">
                {(p) => (
                  <select {...p} value={hour} onChange={(e) => setHour(Number(e.target.value))}>
                    {HOURS.map((h) => (
                      <option key={h} value={h}>
                        {String(h).padStart(2, "0")}:00
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <div className="actions">
                {err && (
                  <span className="error" role="alert">
                    {err}
                  </span>
                )}
                <button className={data.setup.timezone ? "" : "primary"} type="submit">
                  {data.setup.timezone ? "Save again" : "Save"}
                </button>
              </div>
            </form>
          </Step>
          <Step n={2} title="Your OAuth apps" done={data.setup.oauthApp}>
            <p className="muted">
              Bongsu talks to Instagram and YouTube through apps you own: paste a Meta app for Instagram and a Google
              app for YouTube (the page shows the exact redirect URLs to register). Connecting through Composio needs
              neither.
            </p>
            {state.instanceAdmin ? (
              <div className="actions">
                <button type="button" className={data.setup.oauthApp ? "" : "primary"} onClick={() => go("apps")}>
                  Open OAuth apps
                </button>
              </div>
            ) : (
              <InstanceStep />
            )}
          </Step>
          <Step n={3} title="Where your media live" done={data.setup.mediaStore}>
            <p className="muted">
              Your Reels and photos stay in a store you control: Google Drive, an S3-compatible bucket (AWS, R2, B2,
              MinIO) or, with Docker, this server's disk. Bongsu reads them from there and publishes them.
            </p>
            {state.instanceAdmin ? (
              <div className="actions">
                <button
                  type="button"
                  className={data.setup.oauthApp && !data.setup.mediaStore ? "primary" : ""}
                  onClick={() => go("media")}
                >
                  Open Media
                </button>
              </div>
            ) : (
              <InstanceStep />
            )}
          </Step>
          <Step n={4} title="Connect an account" done={data.setup.connection}>
            <p className="muted">An Instagram account or a YouTube channel to publish to.</p>
            <div className="actions">
              <button
                type="button"
                className={data.setup.mediaStore && !data.setup.connection ? "primary" : ""}
                onClick={() => go("connections")}
              >
                Open Connections
              </button>
            </div>
          </Step>
          <Step n={5} title="Add the device you approve on" done={data.setup.device}>
            <p className="muted">
              Approving happens in the Bongsu app, with a passkey: add your phone (or another device) and turn on its
              notifications.
            </p>
            <div className="actions">
              <button
                type="button"
                className={data.setup.connection && !data.setup.device ? "primary" : ""}
                onClick={() => go("devices")}
              >
                Open Devices &amp; passkeys
              </button>
            </div>
          </Step>
          <Card title="Then: dry run, and going live">
            <p className="muted">
              {data.dryRun
                ? "This instance is in dry run: every step runs and notifies you, but nothing is published. Try a post end to end, then go live from Settings."
                : "This instance is live: approved posts are published at their time."}
            </p>
            <div className="actions">
              <button type="button" onClick={() => go("settings")}>
                Open Settings
              </button>
              <button type="button" className="link" onClick={() => go("")}>
                Go to the overview
              </button>
            </div>
          </Card>
        </>
      )}
    </Page>
  );
}

// ---- Settings

/** The workspace's ntfy topic: its notifications are also posted there. The page never sees the whole address. */
function NtfyCard({
  ntfy,
  encryptionKeySet,
  onChange,
}: {
  ntfy: { set: boolean; host: string | null };
  encryptionKeySet: boolean;
  onChange: () => void;
}) {
  const toast = useToast();
  const { confirm, dialog } = useConfirm();
  const [url, setUrl] = useState("");
  const [editing, setEditing] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    try {
      await withFreshCheck(() => api("settings/ntfy", { url }));
      toast({ ok: true, text: "The ntfy topic is set: this workspace's notifications go there too." });
      setUrl("");
      setEditing(false);
      onChange();
    } catch (e) {
      setErr(errorText(e));
    }
  };
  const test = async () => {
    try {
      await api("settings/ntfy/test", {});
      toast({ ok: true, text: "Sent: check the topic." });
    } catch (e) {
      toast({ ok: false, text: errorText(e) });
    }
  };
  return (
    <Card title="Notifications (ntfy)">
      <p className="muted">
        Optional: this workspace's notifications also go to an{" "}
        <a href="https://ntfy.sh" target="_blank" rel="noopener noreferrer">
          ntfy
        </a>{" "}
        topic, on ntfy.sh or your own server. Anyone who knows a topic's address can read it, so pick a long, random
        name; it's stored encrypted and not shown again. Each workspace has its own.
      </p>
      {!encryptionKeySet ? (
        <p className="banner" role="status">
          Set the ENCRYPTION_KEY secret first: the topic is stored encrypted with it.
        </p>
      ) : ntfy.set && !editing ? (
        <div className="actions">
          <span>
            Posting to a topic on <code>{ntfy.host}</code>.
          </span>
          <button type="button" onClick={test}>
            Send a test
          </button>
          <button type="button" onClick={() => setEditing(true)}>
            Replace
          </button>
          <button
            type="button"
            className="link danger"
            onClick={() =>
              confirm({
                title: "Stop posting to the ntfy topic?",
                detail: "The app's notifications keep working.",
                verb: "Remove",
                run: async () => {
                  await withFreshCheck(() => api("settings/ntfy", { url: null }));
                  toast({ ok: true, text: "The ntfy topic is removed." });
                  onChange();
                },
              })
            }
          >
            Remove
          </button>
        </div>
      ) : (
        <form onSubmit={save} className="inline-form">
          <Field
            label="Topic address"
            help="https://ntfy.sh/<topic>, or your server's; a protected topic's token as ?auth=…"
            error={err}
          >
            {(p) => (
              <input
                {...p}
                className="mono"
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://ntfy.sh/"
                autoComplete="off"
                spellCheck={false}
                required
              />
            )}
          </Field>
          <div className="actions">
            {editing && (
              <button type="button" onClick={() => setEditing(false)}>
                Cancel
              </button>
            )}
            <button className="primary" type="submit">
              Save
            </button>
          </div>
        </form>
      )}
      {dialog}
    </Card>
  );
}

export function Settings(_: Props) {
  const { data, error, reload } = useLoad<{
    name: string;
    timezone: string;
    digestHour: number;
    dryRun: boolean;
    publicUrl: string;
    ntfy: { set: boolean; host: string | null };
    encryptionKeySet: boolean;
  }>("settings");
  const [name, setName] = useState("");
  const [tz, setTz] = useState("");
  const [hour, setHour] = useState(8);
  const [err, setErr] = useState<string | null>(null);
  const toast = useToast();
  useEffect(() => {
    if (data) {
      setName(data.name);
      setTz(data.timezone);
      setHour(data.digestHour);
    }
  }, [data]);
  const zones = Intl.supportedValuesOf?.("timeZone") ?? [];
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    try {
      await api("settings", { name, timezone: tz, digestHour: hour });
      toast({ ok: true, text: "Settings saved." });
      reload();
    } catch (e) {
      setErr(errorText(e));
    }
  };
  return (
    <Page title="Settings" intro="Defaults for the workspace. Times are stored in UTC; this zone is how they're shown.">
      {!data ? (
        <Loading error={error} retry={reload} />
      ) : (
        <>
          <Card title="Workspace">
            <form onSubmit={save}>
              <Field label="Name" help="Who or what the workspace is for. Everyone in it sees this name.">
                {(p) => <input {...p} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required />}
              </Field>
              <Field label="Time zone" help="Each person can pick their own in the Bongsu app; this is the default.">
                {(p) => (
                  <select {...p} value={tz} onChange={(e) => setTz(e.target.value)}>
                    {(zones.includes(tz) ? zones : [tz, ...zones]).map((z) => (
                      <option key={z}>{z}</option>
                    ))}
                  </select>
                )}
              </Field>
              <Field label="Daily digest" help="When the day's summary arrives, in the zone above.">
                {(p) => (
                  <select {...p} value={hour} onChange={(e) => setHour(Number(e.target.value))}>
                    {HOURS.map((h) => (
                      <option key={h} value={h}>
                        {String(h).padStart(2, "0")}:00
                      </option>
                    ))}
                  </select>
                )}
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
          <NtfyCard ntfy={data.ntfy} encryptionKeySet={data.encryptionKeySet} onChange={reload} />
          <Card title="Instance">
            <dl className="facts">
              <dt>Address</dt>
              <dd className="mono">{data.publicUrl}</dd>
              <dt>Publishing</dt>
              <dd>
                {data.dryRun ? (
                  <>
                    <Pill status="waiting" label="Dry run" /> set <code>DRY_RUN = "0"</code> in the wrangler files and
                    deploy to go live.
                  </>
                ) : (
                  <Pill status="ok" label="Live" />
                )}
              </dd>
            </dl>
          </Card>
        </>
      )}
    </Page>
  );
}

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
          api<{ invite?: { url: string } }>("workspaces", { name, timezone: tz, admin: adminIsMe ? "me" : to }),
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
      {dialog}
    </Page>
  );
}

// ---- No workspace yet

/** Signed in, in no workspace. An instance admin creates the first one (the first run: a name, a time zone and its
 *  first admin, them or someone invited by email); anyone else waits for an invite. In place of the sidebar. */
export function FirstWorkspace({
  state,
  onDone,
  onSignOut,
}: {
  state: State;
  /** `invited`: its first admin is someone else, so it waits on the Workspaces page. */
  onDone: (invited: boolean) => void;
  onSignOut: () => void;
}) {
  const zones = Intl.supportedValuesOf?.("timeZone") ?? [];
  const here = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const [name, setName] = useState("");
  const [tz, setTz] = useState(here);
  const [adminIsMe, setAdminIsMe] = useState(true);
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
        api<{ invite?: { url: string } }>("workspaces", {
          name,
          timezone: tz,
          admin: adminIsMe ? "me" : email.trim().toLowerCase(),
        }),
      );
      // their link, to copy, before going on
      if (r.invite) setLink(r.invite.url);
      else onDone(false);
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
          {!adminIsMe && (
            <Field label="Their email">
              {(p) => <input {...p} type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />}
            </Field>
          )}
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
