// The Settings tab: you, notifications, time zone, connections, media stores and the version.

import { startAuthentication } from "@simplewebauthn/browser";
import { useEffect, useMemo, useState } from "react";
import { api, type NoteGroup, type NotifyPrefs, notifyPrefs, setNotifyPref } from "./api";
import { BRAND, ConfirmButton, cachePrune, type Me, Switch, useLoad, useShared } from "./common";
import { type Key, t } from "./i18n";

const b64ToBytes = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

/** This app's version, and whether the deployed one is newer (an installed PWA can run an older copy). */
function VersionInfo() {
  const [live, setLive] = useState<{ commit: string; built: string } | null>(null);
  useEffect(() => {
    fetch("/version.json", { cache: "no-store" })
      .then((r) => r.json())
      .then(setLive)
      .catch(() => {});
  }, []);
  const v = __APP_VERSION__;
  const behind = live && live.commit !== v.commit && live.built > v.built; // "YYYY-MM-DD HH:MM UTC" sorts as text
  return (
    <div className="card">
      <h2>{t("settings.version")}</h2>
      <p className="small">
        {t("settings.app")} <code>{v.commit}</code>
        {t("settings.built", { built: v.built })}
        {live && !behind && <span className="muted"> {t("settings.upToDate")}</span>}
      </p>
      {behind && (
        <p className="small warn">
          {t("settings.newer")}
          <code>{live.commit}</code>
          {t("settings.newerEnd", { built: live.built })}{" "}
          <button
            onClick={() =>
              navigator.serviceWorker
                ?.getRegistration()
                .then((r) => r?.update())
                .finally(() => location.reload())
            }
          >
            {t("settings.update")}
          </button>
        </p>
      )}
    </div>
  );
}

/** Where the media are read from: the stores set up in the dashboard, read-only here. */
function MediaStoresCard() {
  const { data } = useLoad<{
    stores: { id: string; kind: string; own: boolean; default: boolean; status: string; where: string | null }[];
  }>("media-stores");
  if (!data) return null;
  const name = (k: string) => (k === "drive" || k === "s3" || k === "local" ? t(`store.${k}`) : k);
  return (
    <div className="card">
      <h2>{t("settings.media")}</h2>
      {data.stores.length === 0 ? (
        <p className="small warn">{t("settings.mediaNone")}</p>
      ) : (
        <ul className="small">
          {data.stores.map((s) => (
            <li key={s.id}>
              {name(s.kind)}
              {s.where && <code> {s.where}</code>}
              {s.default && <span className="muted"> ({t("settings.mediaDefault")})</span>}
              {s.status !== "ok" && <span className="warn"> · {t("settings.mediaBroken")}</span>}
            </li>
          ))}
        </ul>
      )}
      <p className="muted small">{t("settings.mediaNote")}</p>
    </div>
  );
}

type Connections = {
  connections: { id: string; provider: string; label: string | null; status: string; accounts: string[] }[];
  providers: { provider: string; label: string; ready: boolean }[];
};

/** The workspace's Instagram and YouTube connections, for its admins and creators: Connect sends the browser to the
 *  provider with the instance's OAuth app, and the provider's way back lands here with `?connected=` or `?error=`. */
function ConnectCard() {
  const { data } = useLoad<Connections>("connections");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  useEffect(() => {
    const q = new URLSearchParams(location.hash.split("?")[1] ?? "");
    const connected = q.get("connected");
    const error = q.get("error");
    if (connected === null && error === null) return;
    if (connected !== null)
      setMsg({ text: t("settings.connected", { label: connected, n: Number(q.get("accounts") ?? 0) }), ok: true });
    else {
      const hint = q.get("hint") === "browser" ? ` ${t("settings.connectBrowserHint")}` : "";
      setMsg({ text: t("settings.connectFailed", { error: error ?? "" }) + hint, ok: false });
    }
    // a reload shouldn't say it again
    history.replaceState(history.state, "", "#/settings");
  }, []);
  const start = async (provider: string, reconnect?: string) => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api<{ url: string }>(`connect/${provider}/start`, reconnect ? { reconnect } : {});
      location.href = r.url;
    } catch (e) {
      setMsg({ text: (e as Error).message, ok: false });
      setBusy(false);
    }
  };
  if (!data) return null;
  const ready = (p: string) => data.providers.some((x) => x.provider === p && x.ready);
  return (
    <div className="card">
      <h2>{t("settings.accounts")}</h2>
      <p className="muted small">{t("settings.accountsNote")}</p>
      {data.connections.length === 0 ? (
        <p className="small muted">{t("settings.connectNone")}</p>
      ) : (
        <ul className="small">
          {data.connections.map((c) => (
            <li key={c.id}>
              {c.label ?? c.provider}
              {c.status !== "ok" && <span className="warn"> · {t("settings.connectBroken")}</span>}{" "}
              {ready(c.provider) && (
                <button className="link-button" disabled={busy} onClick={() => start(c.provider, c.id)}>
                  {t("settings.reconnect")}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="row">
        {data.providers
          .filter((p) => p.ready)
          .map((p) => (
            <button key={p.provider} disabled={busy} onClick={() => start(p.provider)}>
              {t("settings.connect", { label: p.label })}
            </button>
          ))}
      </div>
      {data.providers
        .filter((p) => !p.ready)
        .map((p) => (
          <p key={p.provider} className="small muted">
            {t("settings.connectNoApp", { label: p.label })}
          </p>
        ))}
      {msg && (
        <p className={`notice small ${msg.ok ? "ok" : "bad"}`} role="status">
          {msg.text}
        </p>
      )}
    </div>
  );
}

/** The zone the app shows and takes times in: the user's own or the workspace's. Plans are stored in UTC, so changing
 *  it moves nothing; the app reloads to show every time in the new zone. */
function TimeZoneCard({ me }: { me: Me }) {
  const zones = useMemo((): string[] => {
    try {
      return Intl.supportedValuesOf("timeZone");
    } catch {
      return [] as string[];
    }
  }, []);
  const current = me.timezone ?? "UTC";
  const ws = me.workspaceTimezone ?? current;
  const device = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [pick, setPick] = useState(current);
  const [error, setError] = useState<string | null>(null);
  const save = (tz: string | null) =>
    api("me/timezone", { timezone: tz })
      .then(() => location.reload())
      .catch((e: Error) => setError(e.message));
  return (
    <div className="card">
      <h2>{t("settings.zone")}</h2>
      <p className="muted small">
        {t("settings.zoneShown")} <strong>{current}</strong>
        {current === ws ? ` ${t("settings.zoneWorkspace")}` : ""}. {t("settings.zoneNote")}
      </p>
      <div className="row">
        <select value={pick} onChange={(e) => setPick(e.target.value)} aria-label={t("settings.zone")}>
          {(zones.includes(pick) ? zones : [pick, ...zones]).map((z) => (
            <option key={z} value={z}>
              {z}
            </option>
          ))}
        </select>
        <button type="button" onClick={() => save(pick)} disabled={pick === current}>
          {t("settings.zoneUse")}
        </button>
      </div>
      <div className="row">
        {device && device !== current && (
          <button type="button" onClick={() => save(device)}>
            {t("settings.zoneDevice", { zone: device })}
          </button>
        )}
        {current !== ws && (
          <button type="button" onClick={() => save(null)}>
            {t("settings.zoneBack", { zone: ws })}
          </button>
        )}
      </div>
      {error && (
        <p className="notice small bad" role="status">
          {error}
        </p>
      )}
    </div>
  );
}

const GROUP_TEXT: Record<NoteGroup, [Key, Key]> = {
  needs_you: ["notify.needs_you", "notify.needs_youNote"],
  problems: ["notify.problems", "notify.problemsNote"],
  published: ["notify.published", "notify.publishedNote"],
  inbox: ["notify.inbox", "notify.inboxNote"],
  digest: ["notify.digest", "notify.digestNote"],
};

/** The person's five notification groups in this workspace (core/notify-prefs.ts), under the device's own switch:
 *  what this workspace sends to their devices. Someone who isn't a member here (an instance admin visiting) gets
 *  nothing from it, and the server says so instead of the switches. */
function NotifyGroups({ me }: { me: Me }) {
  const [prefs, setPrefs] = useState<NotifyPrefs | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<NoteGroup | null>(null);
  useEffect(() => {
    notifyPrefs()
      .then(setPrefs)
      .catch((e: Error) => setErr(e.message));
  }, []);
  const set = (grp: NoteGroup, enabled: boolean) => {
    setBusy(grp);
    setErr(null);
    setNotifyPref(grp, enabled)
      .then(setPrefs)
      .catch((e: Error) => setErr(e.message))
      .finally(() => setBusy(null));
  };
  return (
    <div className="groups">
      <h3>{t("settings.groups", { name: me.workspace?.name ?? "" })}</h3>
      {prefs?.groups.map(({ grp, enabled, isDefault }) => (
        <div key={grp} className="group">
          <Switch on={enabled} disabled={busy !== null} onChange={(on) => set(grp, on)} label={t(GROUP_TEXT[grp][0])} />
          <p className="muted small">
            {t(GROUP_TEXT[grp][1])}
            {isDefault && ` · ${t("settings.groupDefault")}`}
          </p>
        </div>
      ))}
      {!prefs && !err && <p className="muted small">{t("common.loading")}</p>}
      {err && (
        <p className={`notice small ${prefs ? "bad" : ""}`} role="status">
          {err}
        </p>
      )}
      {(me.workspaces?.length ?? 0) > 1 && <p className="muted small">{t("settings.groupsOther")}</p>}
    </div>
  );
}

/** How to unblock notifications once the browser remembers "Block" (it won't ask again by itself). */
function unblockHelp(): string {
  const brave = "brave" in navigator;
  const installed = matchMedia("(display-mode: standalone)").matches;
  const steps = installed ? t("settings.unblockAndroid", { name: BRAND.name }) : t("settings.unblockBrowser");
  return t("settings.unblockHelp", { steps, brave: brave ? ` ${t("settings.unblockBrave")}` : "" });
}

/** Your name everywhere, and the name this workspace shows for you (empty clears either). Each field saves alone. */
export function YouCard({ me, onRefresh }: { me: Me; onRefresh: () => void }) {
  const you = me.you;
  const [name, setName] = useState(you?.name ?? "");
  const [shown, setShown] = useState(you?.displayName ?? "");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ field: string; text: string; ok: boolean } | null>(null);
  useEffect(() => {
    setName(you?.name ?? "");
    setShown(you?.displayName ?? "");
  }, [you?.name, you?.displayName]);
  if (!you) return null;
  const save = async (field: "name" | "display-name", value: string) => {
    setBusy(field);
    setMsg(null);
    try {
      await api(`me/${field}`, { name: value.trim() });
      setMsg({ field, text: t("you.saved"), ok: true });
      onRefresh();
    } catch (e) {
      setMsg({ field, text: (e as Error).message, ok: false });
    }
    setBusy(null);
  };
  const field = (id: "name" | "display-name", label: string, value: string, set: (v: string) => void, hint: string) => (
    <div className="form">
      <label>
        {label}
        <input
          value={value}
          maxLength={60}
          placeholder={hint}
          onChange={(e) => set(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && save(id, value)}
        />
      </label>
      <button type="button" disabled={busy !== null} onClick={() => save(id, value)}>
        {busy === id ? t("common.saving") : t("you.save")}
      </button>
      {msg?.field === id && (
        <p className={`notice small ${msg.ok ? "ok" : "bad"}`} role={msg.ok ? "status" : "alert"}>
          {msg.text}
        </p>
      )}
    </div>
  );
  return (
    <div className="card">
      <h2>{t("you.title")}</h2>
      {field("name", t("you.name"), name, setName, "")}
      {field(
        "display-name",
        t("you.shownIn", { workspace: me.workspace?.name ?? "" }),
        shown,
        setShown,
        you.name ?? you.emailName ?? "",
      )}
    </div>
  );
}

export function SettingsPage({ me, onSignOut }: { me: Me; onSignOut: () => void }) {
  const { status, refresh } = useShared();
  const [msg, setMsg] = useState<{ card: string; text: string; ok: boolean } | null>(null);
  const [pushOn, setPushOn] = useState<boolean | null>(null);
  useEffect(() => {
    if (!("PushManager" in window) || !("Notification" in window)) {
      setPushOn(false);
      return;
    }
    if (Notification.permission !== "granted") {
      setPushOn(false);
      return;
    }
    navigator.serviceWorker
      ?.getRegistration()
      .then((r) => r?.pushManager.getSubscription())
      .then((sub) => setPushOn(!!sub))
      .catch(() => setPushOn(false));
  }, []);
  const say = (card: string, p: Promise<unknown>, ok: string) =>
    p
      .then(() => {
        setMsg({ card, text: ok, ok: true });
        refresh();
      })
      .catch((e: Error) => setMsg({ card, text: e.message, ok: false }));
  const note = (card: string) =>
    msg?.card === card && (
      <p className={`notice small ${msg.ok ? "ok" : "bad"}`} role="status">
        {msg.text}
      </p>
    );
  const enablePush = async () => {
    try {
      if (!("PushManager" in window)) throw new Error(t("settings.pushUnsupported"));
      const perm = await Notification.requestPermission();
      if (perm === "default") throw new Error(t("settings.pushDismissed"));
      if (perm !== "granted") throw new Error(unblockHelp());
      const reg = await navigator.serviceWorker.ready;
      const sub =
        (await reg.pushManager.getSubscription()) ??
        (await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: b64ToBytes(me.vapidPublicKey),
        }));
      await api("push/subscribe", {
        ...sub.toJSON(),
        device: navigator.userAgent.includes("Android") ? "Android" : "browser",
      });
      setPushOn(true);
      setMsg({ card: "push", text: t("settings.pushEnabled"), ok: true });
    } catch (e) {
      setMsg({ card: "push", text: (e as Error).message, ok: false });
    }
  };
  return (
    <section>
      <YouCard me={me} onRefresh={onSignOut} />
      <div className="card">
        <h2>{t("settings.publishing")}</h2>
        {status.data?.paused ? (
          <>
            <p className="small">{t("settings.pausedNote")}</p>
            <button
              className="primary"
              onClick={() =>
                say(
                  "pub",
                  (async () => {
                    const o = await api<{ options: never; challengeId: string }>("resume/options", {});
                    const response = await startAuthentication({ optionsJSON: o.options });
                    await api("resume/verify", { challengeId: o.challengeId, response });
                  })(),
                  t("settings.resumed"),
                )
              }
            >
              {t("settings.resumeWithPasskey")}
            </button>
          </>
        ) : (
          <>
            <p className="small muted">{t("settings.pauseNote")}</p>
            <ConfirmButton
              full
              label={t("settings.pauseLabel")}
              confirm={t("settings.pauseConfirm")}
              detail={t("settings.pauseDetail")}
              onConfirm={() => say("pub", api("pause", { reason: "paused from the app" }), t("settings.pausedNote"))}
            />
          </>
        )}
        {note("pub")}
      </div>
      <div className="card">
        <div className="row">
          <h2>{t("settings.notifications")}</h2>
          {pushOn !== null && (
            <span className={`pill ${pushOn ? "ok" : ""}`}>
              {pushOn ? t("settings.pushOn") : t("settings.pushOff")}
            </span>
          )}
        </div>
        <p className="muted small">{t("settings.pushNote")}</p>
        <div className="row">
          {!pushOn && <button onClick={enablePush}>{t("settings.pushEnable")}</button>}
          <button onClick={() => say("push", api("push/test", {}), t("settings.pushTestSent"))}>
            {t("settings.pushTest")}
          </button>
        </div>
        {note("push")}
        <NotifyGroups me={me} />
      </div>
      {me.connects && <ConnectCard />}
      <TimeZoneCard me={me} />
      <MediaStoresCard />
      <VersionInfo />
      <div className="card">
        <h2>{t("settings.thisDevice")}</h2>
        <button
          onClick={() =>
            api("logout", {}).then(() => {
              cachePrune(true);
              onSignOut();
            })
          }
        >
          {t("settings.signOut")}
        </button>
      </div>
    </section>
  );
}
