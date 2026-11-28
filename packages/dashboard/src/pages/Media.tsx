// Media: the instance's media stores (Drive, S3 and the like, a local folder).

import { type FormEvent, useEffect, useState } from "react";
import { api, when, withFreshCheck } from "../api";
import { GuideLink } from "../docs";
import { Card, Field, Loading, Page, Pill, useConfirm, useLoad, useToast } from "../ui";
import { count, errorText, type Props, STORE_NAME } from "./common";

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
      ? `each workspace's folder in ${driveRoot(s)?.name ?? "the top of the connected Drive"}`
      : "the server's media folder";

/** A Drive store's root folder, when it has one. */
export const driveRoot = (s: { settings: Record<string, unknown> }) =>
  s.settings.root as { id: string; name: string } | undefined;

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
                Each workspace gets its own folder in the root folder, made when you connect (its name is shown in the
                workspace's Settings → Media). Drop files in its inbox; Bongsu reads them and moves posted ones to its
                _posted folder. It connects with your Google app (the one YouTube uses), which needs this page's
                redirect URL: <GuideLink doc="site/docs/drive.md">the Drive guide</GuideLink>.
              </p>
              <DriveForm
                connected={has("drive")}
                root={driveRoot(data.stores.find((s) => s.kind === "drive") ?? { settings: {} })}
                googleApp={data.googleApp}
                onApps={() => go("admin/apps")}
                onSaved={() => {
                  toast({ ok: true, text: "The root folder is saved: each workspace's folder is in it now." });
                  reload();
                }}
              />
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
                The media folder of this server (MEDIA_DIR; /media in Docker). Copy files into each workspace's folder
                there (shown in its Settings → Media), under inbox.
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

export function S3Form({
  saved,
  onClose,
  onDone,
  path = "media-stores/s3",
}: {
  saved?: Pick<StoreInfo, "settings"> & { hasCredentials?: boolean };
  onClose: () => void;
  onDone: () => void;
  /** The save route: the instance's by default, a workspace's own (`settings/media/stores/s3`) on its Settings. */
  path?: string;
}) {
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
      await withFreshCheck(() => api(path, v));
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

/** Google Drive's root folder and its Connect button: a new Drive is connected with the root typed here; a connected
 *  one keeps its root on Connect again, and Save moves the workspaces' folders under another (they're made there). */
export function DriveForm({
  connected,
  root,
  googleApp,
  onApps,
  onSaved,
  path = "media-stores/drive",
}: {
  connected: boolean;
  root?: { id: string; name: string };
  googleApp: boolean;
  onApps: () => void;
  onSaved: () => void;
  /** The routes' base: the instance's by default, a workspace's own (`settings/media/stores/drive`) on its Settings. */
  path?: string;
}) {
  const [v, setV] = useState(root?.name ?? "");
  // which action is under way: its button says so until it's done (Connect until the browser leaves for Google)
  const [busy, setBusy] = useState<"save" | "connect" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const run = async (action: "save" | "connect", f: () => Promise<void>) => {
    if (busy) return;
    setBusy(action);
    setErr(null);
    try {
      await f();
      if (action === "save") setBusy(null);
    } catch (e) {
      setErr(errorText(e));
      setBusy(null);
    }
  };
  // required: without one the workspaces' folders would land at the top of My Drive. A Drive connected before root
  // folders (none saved) can still connect again as it is.
  const missing = !v.trim() && !(connected && !root);
  const MISSING = "Type the root folder first: a folder's name at the top of My Drive, or its link.";
  // connecting again keeps the saved root unless it was changed here
  const connect = () => {
    if (missing) return setErr(MISSING);
    return run("connect", async () => {
      const typed = !connected || v.trim() !== (root?.name ?? "") ? { root: v } : {};
      const r = await withFreshCheck(() => api<{ url: string }>(`${path}/start`, typed));
      location.assign(r.url);
    });
  };
  const save = (e: FormEvent) => {
    e.preventDefault();
    if (!v.trim()) return setErr(MISSING);
    if (v.trim() === (root?.name ?? "")) return;
    run("save", async () => {
      await withFreshCheck(() => api(`${path}/root`, { root: v }));
      onSaved();
    });
  };
  if (!googleApp)
    return (
      <div className="actions">
        <button type="button" onClick={onApps}>
          Add your Google app first
        </button>
      </div>
    );
  return (
    <form onSubmit={save} className="inset">
      <Field
        label="Root folder (required)"
        help="Make a folder in your Drive for Bongsu, then type its name (when it's at the top of My Drive) or paste its link: a Shared drive's link, or a folder's in one, works too. Each workspace's folder is made inside it."
        error={err}
      >
        {(p) => (
          <input
            {...p}
            className="mono"
            value={v}
            onChange={(e) => {
              setV(e.target.value);
              if (err === MISSING) setErr(null);
            }}
            required
            spellCheck={false}
          />
        )}
      </Field>
      <div className="actions">
        {connected && (
          <button type="submit" aria-disabled={!!busy || !v.trim() || v.trim() === (root?.name ?? "")}>
            {busy === "save" ? "Saving…" : "Save the root folder"}
          </button>
        )}
        <button
          type="button"
          className={connected ? "" : "primary"}
          onClick={connect}
          aria-disabled={!!busy || missing}
        >
          {busy === "connect" ? "Opening Google…" : connected ? "Connect again" : "Connect Google Drive"}
        </button>
      </div>
    </form>
  );
}
