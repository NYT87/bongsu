// Settings: the workspace's general settings, icon, notifications, media and apps, and the scheduler.

import { type FormEvent, Fragment, useEffect, useState } from "react";
import { api, apiFile, NAVIGATED, STATE_STALE, when, withFreshCheck } from "../api";
import { GuideLink } from "../docs";
import { Card, Field, Loading, Page, Pill, useConfirm, useLoad, useToast } from "../ui";
import { count, errorText, HOURS, type Props, STORE_NAME } from "./common";
import { DriveForm, driveRoot, S3Form } from "./Media";
import { AppCard, type OAuthApp } from "./OAuthApps";

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

/** The Settings page's parts: the workspace's own settings, its media folder and stores, its OAuth apps. */
const SETTINGS_TABS = [
  ["", "General"],
  ["media", "Media"],
  ["apps", "OAuth apps"],
] as const;

const settingsTabOf = () => {
  const t = location.pathname.replace(/^\/dashboard\/?/, "").split("/")[1] ?? "";
  return SETTINGS_TABS.some(([k]) => k === t) ? t : "";
};

/** Settings, in parts: /dashboard/settings (General), /settings/media and /settings/apps. The router only reads the
 *  first path segment, so the part is read here; the Drive callback lands on /settings/media. */
export function Settings(props: Props) {
  const [tab, setTab] = useState(settingsTabOf);
  useEffect(() => {
    const f = () => setTab(settingsTabOf());
    addEventListener("popstate", f);
    addEventListener(NAVIGATED, f);
    return () => {
      removeEventListener("popstate", f);
      removeEventListener(NAVIGATED, f);
    };
  }, []);
  const open = (t: string) => {
    history.pushState(null, "", `/dashboard/settings${t ? `/${t}` : ""}`);
    setTab(t);
  };
  const intro =
    tab === "media"
      ? "Where this workspace's files live: its folder, and the stores it reads them from."
      : tab === "apps"
        ? "This workspace's own Meta and Google apps. Without them it uses the instance's."
        : "Defaults for the workspace. Times are stored in UTC; this zone is how they're shown.";
  return (
    <Page title="Settings" intro={intro}>
      <nav className="subnav" aria-label="Settings">
        {SETTINGS_TABS.map(([k, label]) => (
          <a
            key={k}
            href={`/dashboard/settings${k ? `/${k}` : ""}`}
            aria-current={k === tab ? "page" : undefined}
            onClick={(e) => {
              e.preventDefault();
              open(k);
            }}
          >
            {label}
          </a>
        ))}
      </nav>
      {tab === "media" ? (
        <WorkspaceMedia onApps={() => open("apps")} />
      ) : tab === "apps" ? (
        <WorkspaceApps />
      ) : (
        <GeneralSettings {...props} />
      )}
    </Page>
  );
}

function GeneralSettings(_: Props) {
  const { data, error, reload } = useLoad<{
    name: string;
    timezone: string;
    digestHour: number;
    dryRun: boolean;
    publicUrl: string;
    ntfy: { set: boolean; host: string | null };
    encryptionKeySet: boolean;
    iconUrl: string | null;
    server: { version: string; commit: string | null };
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
      dispatchEvent(new Event(STATE_STALE));
      reload();
    } catch (e) {
      setErr(errorText(e));
    }
  };
  return (
    <>
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
          <IconCard iconUrl={data.iconUrl} onChange={reload} />
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
          <Card title="Version">
            <dl className="facts">
              <dt>App</dt>
              <dd>
                {__APP_VERSION__.version} <code>{__APP_VERSION__.commit}</code>
              </dd>
              <dt>Server</dt>
              <dd>
                {data.server.version} <code>{data.server.commit ?? "unknown commit"}</code>
              </dd>
            </dl>
          </Card>
        </>
      )}
    </>
  );
}

/** The workspace's icon: a square PNG, shown beside its name in the dashboard, the app and the switchers. */
function IconCard({ iconUrl, onChange }: { iconUrl: string | null; onChange: () => void }) {
  const toast = useToast();
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (call: () => Promise<unknown>, done: string) => {
    setErr(null);
    setBusy(true);
    try {
      await call();
      toast({ ok: true, text: done });
      dispatchEvent(new Event(STATE_STALE));
      onChange();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Icon">
      {iconUrl ? (
        <img className="icon-preview" src={iconUrl} alt="" width={64} height={64} />
      ) : (
        <p className="muted">No icon: the app's own is used.</p>
      )}
      <Field label={iconUrl ? "Replace the icon" : "Upload an icon"} help="A square PNG, up to 200 KB.">
        {(p) => (
          <input
            {...p}
            type="file"
            accept="image/png"
            disabled={busy}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) run(() => apiFile("settings/icon", file, "PUT"), "Icon saved.");
            }}
          />
        )}
      </Field>
      <div className="actions">
        {err && (
          <span className="error" role="alert">
            {err}
          </span>
        )}
        {iconUrl && (
          <button
            type="button"
            disabled={busy}
            onClick={() => run(() => api("settings/icon", undefined, "DELETE"), "Icon removed.")}
          >
            Remove
          </button>
        )}
      </div>
    </Card>
  );
}

// ---- Settings: the workspace's own media and OAuth apps

interface OwnStore {
  id: string;
  kind: "drive" | "s3";
  /** The workspace's own store (else the instance's, which it falls back to: read-only here). */
  own: boolean;
  default: boolean;
  status: string;
  lastError: string | null;
  lastCheckedAt: string | null;
  settings: Record<string, unknown>;
  waitingApprovals: number;
}

/** The workspace's media: its folder (where everything of it lives, in whichever store), and its own stores beside the
 *  instance's, which it uses until it makes its own default. */
function WorkspaceMedia({ onApps }: { onApps: () => void }) {
  const toast = useToast();
  const { data, error, reload } = useLoad<{
    folder: string;
    stores: OwnStore[];
    offered: string[];
    googleApp: boolean;
    encryptionKeySet: boolean;
  }>("settings/media");
  const { confirm, dialog } = useConfirm();
  const [err, setErr] = useState<string | null>(null);
  const [form, setForm] = useState(false);
  const [folder, setFolder] = useState("");
  const [folderErr, setFolderErr] = useState<string | null>(null);
  // a rename touches each store (a Drive call or two): the button says it's under way until it's done
  const [folderBusy, setFolderBusy] = useState(false);
  useEffect(() => {
    if (data) setFolder(data.folder);
  }, [data]);
  // the Drive callback's landing: /dashboard/settings/media?connected=drive (or ?error=…)
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    if (q.has("connected")) toast({ ok: true, text: "Google Drive connected: it's this workspace's media store now." });
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
  const saveFolder = async (e: FormEvent) => {
    e.preventDefault();
    if (folderBusy || folder.trim() === data?.folder) return; // aria-disabled doesn't stop a submit
    setFolderErr(null);
    setFolderBusy(true);
    try {
      const r = await api<{ folder: string; renamed: string[]; made: string[] }>(
        "settings/media/folder",
        { folder: folder.trim() },
        "PUT",
      );
      const names = (kinds: string[]) => kinds.map((k) => STORE_NAME[k] ?? k).join(", ");
      toast({
        ok: true,
        text: [
          `The media folder is ${r.folder}.`,
          r.renamed.length ? `Renamed in ${names(r.renamed)}: its files stay in it.` : "",
          r.made.length ? `Made new in ${names(r.made)}: files in the old folder stay there.` : "",
        ]
          .filter(Boolean)
          .join(" "),
      });
      reload();
    } catch (e) {
      setFolderErr(errorText(e));
    } finally {
      setFolderBusy(false);
    }
  };
  const own = (k: string) => data?.stores.find((s) => s.kind === k && s.own);
  const where = (s: OwnStore) =>
    !s.own
      ? "set up by the instance's admins"
      : s.kind === "s3"
        ? `${String(s.settings.bucket ?? "")}${s.settings.prefix ? `/${String(s.settings.prefix)}` : ""} · ${String(s.settings.endpoint ?? "")}`
        : `${data?.folder ?? ""}/ in the connected Drive`;
  return (
    <>
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
          <Card title="Media folder">
            <form onSubmit={saveFolder}>
              <Field
                label="Folder"
                help="The one folder of the store this workspace's files live in: its inbox, uploads and posted files. A new name renames the folder in Google Drive and on the server's disk, files and all; a bucket gets a new folder and its files stay in the old one. The name must not be used by a folder already there."
                error={folderErr}
              >
                {(p) => (
                  <input
                    {...p}
                    className="mono"
                    value={folder}
                    onChange={(e) => setFolder(e.target.value)}
                    maxLength={60}
                    spellCheck={false}
                    required
                  />
                )}
              </Field>
              <div className="actions">
                <button className="primary" type="submit" aria-disabled={folderBusy || folder.trim() === data.folder}>
                  {folderBusy ? "Renaming…" : "Save"}
                </button>
              </div>
            </form>
          </Card>
          <Card title="Stores">
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
                      <tr key={s.id}>
                        <td>
                          <div>
                            {STORE_NAME[s.kind]}{" "}
                            <span className="muted small">{s.own ? "(yours)" : "(the instance's)"}</span>{" "}
                            {s.default && <span className="muted small">(default)</span>}
                          </div>
                          <div className="muted small">{where(s)}</div>
                          {s.lastError && <div className="error small">{s.lastError}</div>}
                        </td>
                        <td data-label="Status">
                          <Pill status={s.status} />
                        </td>
                        <td data-label="Checked" className="small nowrap">
                          {s.lastCheckedAt ? when(Date.parse(s.lastCheckedAt) / 1000) : "—"}
                        </td>
                        <td className="right nowrap">
                          {s.own ? (
                            <>
                              <button
                                type="button"
                                className="link"
                                onClick={() =>
                                  act(async () => {
                                    const r = await withFreshCheck(() =>
                                      api<{ ok: boolean; error: string | null }>(
                                        `settings/media/stores/${s.kind}/test`,
                                        s.kind === "s3" ? s.settings : {},
                                      ),
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
                                      () => api(`settings/media/stores/${s.kind}/default`, {}),
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
                                      await withFreshCheck(() => api(`settings/media/stores/${s.kind}/remove`, {}));
                                      toast({ ok: true, text: `Removed ${STORE_NAME[s.kind]}.` });
                                      reload();
                                    },
                                  })
                                }
                              >
                                Remove
                              </button>
                            </>
                          ) : (
                            !s.default && (
                              <button
                                type="button"
                                className="link"
                                onClick={() =>
                                  act(
                                    () => api("settings/media/default-instance", {}),
                                    "The instance's store is the default now.",
                                  )
                                }
                              >
                                Make default
                              </button>
                            )
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
          {data.offered.includes("drive") && (
            <Card title={own("drive") ? "Google Drive: connect again" : "Add Google Drive"}>
              <p className="muted">
                Bongsu makes {data.folder} in the root folder you choose, with its inbox. Drop files in {data.folder}
                /inbox; Bongsu reads them and moves posted ones to {data.folder}/_posted. It connects with a Google app
                (this workspace's, else the instance's), which needs the redirect URL shown on its OAuth apps tab:{" "}
                <GuideLink doc="site/docs/drive.md">the Drive guide</GuideLink>.
              </p>
              <DriveForm
                path="settings/media/stores/drive"
                connected={!!own("drive")}
                root={own("drive") ? driveRoot(own("drive")!) : undefined}
                googleApp={data.googleApp}
                onApps={onApps}
                onSaved={() => {
                  toast({ ok: true, text: `The root folder is saved: ${data.folder} is in it now.` });
                  reload();
                }}
              />
            </Card>
          )}
          {data.offered.includes("s3") && (
            <Card title={own("s3") ? "S3-compatible bucket: change it" : "Add an S3-compatible bucket"}>
              <p className="muted">
                AWS S3, Cloudflare R2, Backblaze B2, MinIO and others. Instagram fetches the files straight from the
                bucket and the app uploads straight to it: <GuideLink doc="site/docs/s3.md">the bucket guide</GuideLink>{" "}
                has the keys to make and the CORS rule uploads need.
              </p>
              {form ? (
                <S3Form
                  path="settings/media/stores/s3"
                  saved={own("s3") ? { settings: own("s3")?.settings ?? {}, hasCredentials: true } : undefined}
                  onClose={() => setForm(false)}
                  onDone={() => {
                    setForm(false);
                    toast({ ok: true, text: "The bucket is saved: it answered, reading and writing." });
                    reload();
                  }}
                />
              ) : (
                <div className="actions">
                  <button type="button" className={own("s3") ? "" : "primary"} onClick={() => setForm(true)}>
                    {own("s3") ? "Change the bucket" : "Add a bucket"}
                  </button>
                </div>
              )}
            </Card>
          )}
        </>
      )}
      {dialog}
    </>
  );
}

/** The workspace's own Meta and Google apps (else the instance's are used), with the redirect URLs to register. */
function WorkspaceApps() {
  const { data, error, reload } = useLoad<{ apps: OAuthApp[]; encryptionKeySet: boolean }>("settings/oauth-apps");
  if (!data) return <Loading error={error} retry={reload} />;
  return (
    <>
      {!data.encryptionKeySet && (
        <p className="notice bad" role="alert">
          ENCRYPTION_KEY isn't set on the Worker: app secrets and tokens can't be stored until it is (see{" "}
          <GuideLink doc="deploy-cloudflare">the deploy guide</GuideLink>).
        </p>
      )}
      {data.apps.map((a) => (
        <AppCard key={a.id} app={a} onChange={reload} base="settings/oauth-apps" />
      ))}
    </>
  );
}

interface Recorded {
  value: number;
  at: string;
}

type RunName = "instagram" | "shorts" | "upkeep";

interface SchedulerInfo {
  /** null until the scheduler has run once: the schedules are the cron side's variables, recorded by its runs. */
  runs:
    | {
        name: RunName;
        expr: string;
        variable: string;
        source: "default" | "variable";
        error: string | null;
        next: string | null;
        shared: RunName[];
      }[]
    | null;
  limits: {
    /** `shared`: every recorded run shared its minute, so this is a part of the limit, not the limit itself. */
    runSubrequests: { value: number | "unlimited"; invalid: string | null; shared: boolean } | null;
    jobsPerTick: Recorded | null;
    inboxWorkspacesPerRun: Recorded | null;
  };
  last: Record<RunName, { at: string; used: number; limit: number | "unlimited"; stopped: string[] } | null>;
  schedulesOff: boolean;
  variables: { runSubrequests: string; jobsPerTick: string; inboxWorkspacesPerRun: string };
}

const RUN_NAME: Record<string, string> = {
  instagram: "Instagram posts and comments",
  shorts: "YouTube Shorts comments",
  upkeep: "Upkeep: inbox, results, metrics, comments, connections",
};

const at = (iso: string) => when(Date.parse(iso) / 1000);

const runList = (names: string[]) => names.map((n) => RUN_NAME[n] ?? n).join(" and ");

/** What the scheduler runs, when, and how much it may do per run: read-only, from what the runs recorded themselves
 *  (the schedules and limits are variables of the cron Worker or process, which this page can't read). */
export function SchedulerCard() {
  const { data, error, reload } = useLoad<SchedulerInfo>("scheduler");
  const limit = (r: Recorded | null, variable: string, what: string) => (
    <>
      <dt>{what}</dt>
      <dd>
        {r ? (
          <>
            <strong>{r.value}</strong> <span className="muted small">as of {at(r.at)} · set by </span>
            <code>{variable}</code>
          </>
        ) : (
          <span className="muted">
            not run yet <span className="small">(set by </span>
            <code className="small">{variable}</code>
            <span className="small">)</span>
          </span>
        )}
      </dd>
    </>
  );
  const calls = data?.limits.runSubrequests;
  return (
    <Card title="Scheduler">
      {!data ? (
        <Loading error={error} retry={reload} />
      ) : (
        <>
          {data.schedulesOff && (
            <p className="banner" role="status">
              The schedules are off (<code>SCHEDULES=off</code>): this server only serves, nothing is published, scanned
              or polled on its own.
            </p>
          )}
          <p className="muted small">
            Each run handles a limited number of calls, so a busy instance catches up over the next runs. The
            expressions are in UTC, the times in yours. Read-only: the schedules and limits are set where the scheduler
            runs.
          </p>
          <dl className="facts">
            {data.runs ? (
              data.runs.map((r) => {
                const last = data.last[r.name];
                return (
                  <Fragment key={r.name}>
                    <dt>{RUN_NAME[r.name] ?? r.name}</dt>
                    <dd>
                      <div>
                        <code>{r.expr}</code>{" "}
                        <span className="muted small">
                          · {r.source === "variable" ? "set by " : "default, "}
                          <code>{r.variable}</code>
                          {r.source === "default" && " not set"}
                        </span>
                      </div>
                      {r.error ? (
                        <p className="error" role="alert">
                          <code>{r.variable}</code> is invalid: {r.error}. This run is skipped until it's fixed.
                        </p>
                      ) : (
                        <div className="small">next {r.next ? at(r.next) : "never"}</div>
                      )}
                      {r.shared.length > 0 && (
                        <div>
                          <span className="pill warn">
                            Shares a minute with {runList(r.shared)}: they share one invocation's CPU and its calls
                          </span>
                        </div>
                      )}
                      <div className="muted small">
                        {last ? (
                          <>
                            last run {at(last.at)}: {last.used} of {last.limit} calls
                            {last.stopped.length > 0 && `; stopped on its share: ${last.stopped.join(", ")}`}
                          </>
                        ) : (
                          "not run yet"
                        )}
                      </div>
                    </dd>
                  </Fragment>
                );
              })
            ) : (
              <>
                <dt>Runs</dt>
                <dd className="muted">not recorded yet: they show here after the scheduler's first run</dd>
              </>
            )}
            <dt>Calls per run</dt>
            <dd>
              {calls ? (
                <>
                  {/* whether it is the default or set can't be told from what the runs record */}
                  <strong>{calls.value}</strong>{" "}
                  <span className="muted small">
                    {calls.shared ? "in the latest run, its part of a shared minute" : "in the latest run"} · set with{" "}
                  </span>
                  <code>{data.variables.runSubrequests}</code>
                  {calls.invalid !== null && (
                    <p className="error" role="alert">
                      <code>{data.variables.runSubrequests}</code> is invalid (<code>{calls.invalid}</code>): the
                      default is used.
                    </p>
                  )}
                </>
              ) : (
                <span className="muted">
                  not run yet <span className="small">(set by </span>
                  <code className="small">{data.variables.runSubrequests}</code>
                  <span className="small">)</span>
                </span>
              )}
            </dd>
            {limit(data.limits.jobsPerTick, data.variables.jobsPerTick, "Jobs per run")}
            {limit(data.limits.inboxWorkspacesPerRun, data.variables.inboxWorkspacesPerRun, "Workspaces per inbox run")}
          </dl>
        </>
      )}
    </Card>
  );
}
