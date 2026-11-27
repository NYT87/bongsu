// The owner's app: see what's scheduled, approve with a passkey, get push notifications. The shell (signed in or
// not, the tabs, the workspace picker); each screen is in its own file, what they share in common.tsx.

import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { api, HttpError, type QueueItem, switchWorkspace } from "./api";
import { CalendarPage } from "./Calendar";
import { CommentsPage } from "./Comments";
import {
  BRAND,
  cachePrune,
  type DraftsAnswer,
  dueDate,
  dueTime,
  ICON,
  keyTitle,
  LegalLinks,
  type Me,
  MeCtx,
  needs,
  type PlatformInfo,
  type Shared,
  SharedCtx,
  type Status,
  setLastList,
  setPlatforms,
  setZone,
  useHash,
  useLoad,
  zoneClock,
  zoneToday,
} from "./common";
import { DraftsPage } from "./Drafts";
import { ItemPage, type ItemView } from "./Item";
import { type Key, setLocale, t } from "./i18n";
import { QueuePage } from "./Queue";
import { SettingsPage } from "./Settings";
import { ChannelPage, StatsPage } from "./Stats";
import { TodayPage } from "./Today";
import { VideoPage } from "./Video";
import { takeWorkspaceParam } from "./workspace-link";

function useSharedState(): Shared {
  const status = useLoad<Status>("status");
  const queue = useLoad<{ items: QueueItem[] }>("queue?days=7");
  const drafts = useLoad<DraftsAnswer>("drafts");
  const items = queue.data?.items ?? [];
  const today = zoneToday();
  const now = `${today} ${zoneClock(Date.now())}`;
  // Overdue: its time has passed (today included) and it hasn't gone out; held items are listed on their own.
  const overdue = items.filter((i) => {
    const d = dueDate(i.due);
    return !i.hold && !!d && `${d} ${dueTime(i.due) ?? "23:59"}` < now;
  });
  const attention = items.filter((i) => needs(i) && !overdue.includes(i));
  const held = items.filter((i) => i.hold);
  const unseen = useLoad<{ n: number }>("comments/unseen");
  const refresh = () => {
    status.reload();
    queue.reload();
    drafts.reload();
    unseen.reload();
  };
  return { status, attention, overdue, held, queue, drafts, unseen, refresh };
}

/** The app's mark at 32 px: the small mark drawn for that size (public/favicon.svg, from mark-small.svg). */
const LOGO = <img src="/favicon.svg" width={32} height={32} alt="" />;

const TABS = [
  ["#/", "tabs.today", ICON.home],
  ["#/calendar", "tabs.calendar", ICON.calendar],
  ["#/queue", "tabs.queue", ICON.queue],
  ["#/drafts", "tabs.drafts", ICON.drafts],
  ["#/stats", "tabs.stats", ICON.stats],
] as const satisfies readonly (readonly [string, Key, ReactNode])[];

/** Load `me`, first moving the session to `w` when that's another workspace (a push link's); a 403 there answers
 *  `gone` with the session where it was. */
async function loadMe(w: string | null): Promise<{ me: Me; gone: boolean }> {
  let me = await api<Me>("me");
  if (!w || !me.signedIn || me.workspace?.id === w) return { me, gone: false };
  try {
    await switchWorkspace(w);
  } catch (e) {
    if (e instanceof HttpError && e.status === 403) return { me, gone: true };
    throw e;
  }
  cachePrune(true); // the day's cache is the other workspace's
  me = await api<Me>("me");
  return { me, gone: false };
}

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  // a push link into a workspace the person can no longer open: said once, instead of routing to its page
  const [gone, setGone] = useState(false);
  // A push link's workspace (?w=, core/notify.ts withWorkspace), taken off the address before the first route. It waits
  // here until it's used: signed out, the person signs in first and then lands in that workspace.
  const pending = useRef<string | null>(null);
  if (pending.current === null && location.search) {
    const { w, cleaned } = takeWorkspaceParam(location);
    if (w) {
      pending.current = w;
      history.replaceState(history.state, "", cleaned);
    }
  }
  const hash = useHash();
  const refreshMe = useCallback(() => {
    Promise.all([
      loadMe(pending.current),
      api<{ platforms: PlatformInfo[] }>("platforms").catch(() => ({ platforms: [] })),
    ])
      .then(([{ me: m, gone }, p]) => {
        if (m.signedIn) pending.current = null;
        setZone(m.timezone);
        setLocale(m.locale);
        setPlatforms(p.platforms);
        setGone(gone);
        setMe(m);
      })
      .catch(() => setMe(null));
  }, []);
  useEffect(refreshMe, [refreshMe]);
  useEffect(() => cachePrune(), []);
  if (!me)
    return (
      <main className="center">
        <p className="muted">{t("common.loading")}</p>
      </main>
    );
  if (gone && me.signedIn)
    return (
      <main className="center">
        <h1 className="brand-title">
          {LOGO}
          {BRAND.name}
        </h1>
        <h2>{t("workspace.gone")}</h2>
        <button
          type="button"
          className="primary"
          onClick={() => {
            location.hash = "#/queue";
            setGone(false);
          }}
        >
          {t("workspace.toQueue")}
        </button>
      </main>
    );
  // an invite link, signed in or not: joining signs in as the person invited, in the workspace they join
  const invite = /^#\/invite\/([A-Za-z0-9_-]+)/.exec(hash)?.[1];
  if (invite)
    return (
      <InvitePage
        token={invite}
        onDone={() => {
          location.hash = "#/";
          refreshMe();
        }}
      />
    );
  if (!me.signedIn) return <SignIn me={me} onDone={refreshMe} />;
  if (me.noWorkspace) return <NoWorkspace onSignOut={refreshMe} />;
  // keyed by the workspace, so a switch starts every page and the shared lists over in the new one
  return <SignedIn key={me.workspace?.id} me={me} hash={hash} onRefresh={refreshMe} />;
}

/** Signed in, in no workspace (removed, or never invited): every page would answer 403, so only this and the way
 *  out. */
function NoWorkspace({ onSignOut }: { onSignOut: () => void }) {
  return (
    <main className="center">
      <h1 className="brand-title">
        {LOGO}
        {BRAND.name}
      </h1>
      <h2>{t("noWorkspace.title")}</h2>
      <p className="muted">{t("noWorkspace.detail")}</p>
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
    </main>
  );
}

function SignedIn({ me, hash, onRefresh }: { me: Me; hash: string; onRefresh: () => void }) {
  const shared = useSharedState();
  const route = hash.replace(/^#/, "");
  // Needs you and the tab badges come from their own requests: reload them with each page, and when the app comes
  // back to the foreground, so they never contradict the page under them (e.g. after approving on another device).
  const sharedRefresh = useRef(shared.refresh);
  sharedRefresh.current = shared.refresh;
  const firstRoute = useRef(true);
  useEffect(() => {
    if (firstRoute.current) {
      firstRoute.current = false;
      return;
    }
    sharedRefresh.current();
  }, [route]);
  useEffect(() => {
    const back = () => {
      if (document.visibilityState === "visible") sharedRefresh.current();
    };
    document.addEventListener("visibilitychange", back);
    return () => document.removeEventListener("visibilitychange", back);
  }, []);
  const [named, setNamed] = useState<{ key: string; title: string | null } | null>(null); // the open item's display name
  const onItem = route.startsWith("/item/");
  const onVideo = route.startsWith("/video/");
  if (!onItem && !onVideo && !route.startsWith("/setup") && !route.startsWith("/stats/")) setLastList(hash || "#/");
  // #/item/<key>, or with the view it opens: #/item/<key>/results, #/item/<key>/post
  const itemRoute = onItem ? /^\/item\/(.+?)(?:\/(results|post))?$/.exec(route) : null;
  const itemKey = itemRoute ? decodeURIComponent(itemRoute[1]) : "";
  const itemView = itemRoute?.[2] as ItemView | undefined;
  const title = onItem
    ? named?.key === itemKey && named.title
      ? named.title
      : keyTitle(itemKey)
    : onVideo
      ? t("title.video")
      : route.startsWith("/calendar")
        ? t("tabs.calendar")
        : route.startsWith("/queue")
          ? t("tabs.queue")
          : route.startsWith("/drafts")
            ? t("tabs.drafts")
            : route.startsWith("/stats/")
              ? t("title.channel")
              : route.startsWith("/stats")
                ? t("tabs.stats")
                : route.startsWith("/settings")
                  ? t("header.settings")
                  : route.startsWith("/comments")
                    ? t("header.comments")
                    : t("tabs.today");
  const page = onItem ? (
    <ItemPage keyId={itemKey} view={itemView} onTitle={(t) => setNamed({ key: itemKey, title: t })} />
  ) : onVideo ? (
    <VideoPage route={route} />
  ) : route.startsWith("/calendar") ? (
    <CalendarPage />
  ) : route.startsWith("/queue") ? (
    <QueuePage days={60} filters />
  ) : route.startsWith("/drafts") ? (
    <DraftsPage />
  ) : route.startsWith("/stats/") ? (
    <ChannelPage route={route} />
  ) : route.startsWith("/stats") ? (
    <StatsPage />
  ) : route.startsWith("/settings") ? (
    <SettingsPage me={me} onSignOut={onRefresh} />
  ) : route.startsWith("/comments") ? (
    <CommentsPage />
  ) : (
    <TodayPage />
  );
  const [picking, setPicking] = useState(false);
  const several = (me.workspaces?.length ?? 0) > 1;
  const toApprove = shared.attention.length + shared.overdue.length;
  const openDrafts = shared.drafts.data?.drafts.length ?? 0;
  const badge: Record<string, number> = { "#/queue": toApprove, "#/drafts": openDrafts };
  return (
    <MeCtx.Provider value={me}>
      <SharedCtx.Provider value={shared}>
        <div className="top">
          <header>
            <a href="#/" className="brand" aria-label={t("header.brandToday", { name: BRAND.name })}>
              {LOGO}
            </a>
            <div className="head-title">
              <h1 className="clip">
                {title}
                {me.dryRun && <span className="pill warn">{t("header.dryRun")}</span>}
              </h1>
              {me.workspace &&
                (several ? (
                  <button
                    type="button"
                    className="ws-name"
                    aria-haspopup="dialog"
                    aria-label={`${t("workspace.switch")}: ${me.workspace.name}`}
                    onClick={() => setPicking(true)}
                  >
                    <WsIcon url={me.workspace.iconUrl} />
                    <span className="clip">{me.workspace.name}</span>
                    {ICON.chevD}
                  </button>
                ) : (
                  <span className="ws-name">
                    <WsIcon url={me.workspace.iconUrl} />
                    <span className="clip">{me.workspace.name}</span>
                  </span>
                ))}
            </div>
            <span className="head-icons">
              <a
                href="#/comments"
                className={`icon${hash.startsWith("#/comments") ? " on" : ""}`}
                aria-label={
                  shared.unseen.data?.n ? t("header.commentsNew", { n: shared.unseen.data.n }) : t("header.comments")
                }
                aria-current={hash.startsWith("#/comments") ? "page" : undefined}
              >
                <span className="tab-icon">
                  {ICON.comment}
                  {(shared.unseen.data?.n ?? 0) > 0 && (
                    <span className="badge">{shared.unseen.data!.n > 9 ? "9+" : shared.unseen.data!.n}</span>
                  )}
                </span>
              </a>
              <a
                href="#/settings"
                className={`icon${hash.startsWith("#/settings") ? " on" : ""}`}
                aria-label={t("header.settings")}
                aria-current={hash.startsWith("#/settings") ? "page" : undefined}
              >
                {ICON.settings}
              </a>
            </span>
          </header>
          {shared.status.data?.paused && <PausedBanner pausedBy={shared.status.data.paused_by} />}
        </div>
        <main>{page}</main>
        {picking && <WorkspaceSheet me={me} onClose={() => setPicking(false)} onSwitched={onRefresh} />}
        <nav aria-label={t("tabs.nav")}>
          {TABS.map(([h, key, icon]) => {
            const label = t(key);
            const on = h === "#/" ? hash === "#/" || hash === "" : hash.startsWith(h);
            const n = badge[h] ?? 0;
            return (
              <a
                key={h}
                href={h}
                className={on ? "on" : ""}
                aria-current={on ? "page" : undefined}
                aria-label={n ? t(h === "#/drafts" ? "tabs.badgeOpen" : "tabs.badgeApproval", { label, n }) : label}
              >
                <span className="tab-icon">
                  {icon}
                  {n > 0 && (
                    <span className="badge" aria-hidden="true">
                      {n > 9 ? "9+" : n}
                    </span>
                  )}
                </span>
                <span className="tab-label" aria-hidden="true">
                  {label}
                </span>
              </a>
            );
          })}
        </nav>
      </SharedCtx.Provider>
    </MeCtx.Provider>
  );
}

/** The banner under the header while the scheduler is paused: who paused it, when the workspace names them. */
export function PausedBanner({ pausedBy }: { pausedBy?: string | null }) {
  return (
    <div className="banner bad" role="status">
      {ICON.pause}
      <span>
        <strong>{t("header.paused")}</strong>{" "}
        {pausedBy ? t("header.pausedBy", { name: pausedBy }) : t("header.pausedDetail")}
      </span>
      <a href="#/settings">{t("header.resume")}</a>
    </div>
  );
}

/** A workspace's icon, small and rounded; nothing for one without (no placeholder box). */
function WsIcon({ url }: { url?: string | null }) {
  return url ? <img className="ws-icon" src={url} alt="" width={24} height={24} /> : null;
}

/** The header's picker: the workspaces the person can open, with their role in each. Choosing one moves the app's
 *  session there (the dashboard's keeps its own) and opens its queue. A native modal dialog, docked to the bottom in
 *  the thumb zone: it brings the focus trap, Escape and the backdrop. */
export function WorkspaceSheet({ me, onClose, onSwitched }: { me: Me; onClose: () => void; onSwitched: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal?.();
  }, []);
  const pick = async (id: string) => {
    if (id === me.workspace?.id) return onClose();
    setBusy(id);
    setErr(null);
    try {
      await switchWorkspace(id);
      cachePrune(true); // the day's cache is the old workspace's
      location.hash = "#/"; // the new workspace starts on Today, its home
      onSwitched();
    } catch (e) {
      setErr(e instanceof HttpError && e.status === 403 ? t("workspace.gone") : (e as Error).message);
      setBusy(null);
    }
  };
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: a tap on the scrim closes it; the keyboard has Escape and Cancel
    <dialog
      ref={ref}
      className="sheet"
      aria-label={t("workspace.switch")}
      onClose={onClose}
      onClick={(e) => e.target === ref.current && ref.current?.close()}
    >
      <h2>{t("workspace.switch")}</h2>
      <ul className="sheet-list">
        {(me.workspaces ?? []).map((w) => {
          const here = w.id === me.workspace?.id;
          return (
            <li key={w.id}>
              <button
                type="button"
                className={here ? "on" : ""}
                aria-current={here ? "true" : undefined}
                disabled={busy !== null}
                onClick={() => pick(w.id)}
              >
                <WsIcon url={w.iconUrl} />
                <span className="clip">
                  {w.name}
                  {w.shownAs && w.shownAs !== (me.you?.name ?? me.you?.emailName) && (
                    <span className="muted small ws-as">{t("workspace.shownAs", { name: w.shownAs })}</span>
                  )}
                </span>
                <span className="muted small">{w.role}</span>
                {here && <span className="check-mark">{ICON.check}</span>}
              </button>
            </li>
          );
        })}
      </ul>
      {err && (
        <p className="notice bad small" role="alert">
          {err}
        </p>
      )}
      <button type="button" onClick={() => ref.current?.close()}>
        {t("common.cancel")}
      </button>
    </dialog>
  );
}

// ---------------------------------------------------------------- sign-in

/** A setup code arriving in the link from another device's QR code: #/setup?code=XXXX (never sent to the server). */
const linkedCode = () => /^#\/setup\?code=([A-Za-z0-9-]+)/.exec(location.hash)?.[1] ?? "";

function SignIn({ me, onDone }: { me: Me; onDone: () => void }) {
  const [code, setCode] = useState(linkedCode);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      onDone();
    } catch (e) {
      const err = e as Error & { code?: string };
      // Errors from the browser/passkey provider (not from our server): say so, and that the code still works.
      const fromDevice = !(e instanceof HttpError);
      setMsg(
        fromDevice
          ? t("sign.deviceError", {
              detail: `${err.name}${err.code ? ` / ${err.code}` : ""}`,
              message: err.message,
            })
          : err.message,
      );
    } finally {
      setBusy(false);
    }
  };
  const login = () =>
    run(async () => {
      const o = await api<{ options: never; challengeId: string }>("login/options", {});
      const response = await startAuthentication({ optionsJSON: o.options });
      await api("login/verify", { challengeId: o.challengeId, response });
    });
  const setup = () =>
    run(async () => {
      const o = await api<{ options: never; challengeId: string }>("setup/options", { code });
      const response = await startRegistration({ optionsJSON: o.options });
      await api("setup/verify", {
        challengeId: o.challengeId,
        response,
        name: navigator.userAgent.includes("Android") ? "Android phone" : "device",
      });
      if (linkedCode()) location.hash = "#/";
    });
  return (
    <main className="center">
      <h1 className="brand-title">
        {LOGO}
        {BRAND.name}
      </h1>
      {!me.setupNeeded && (
        <button className="primary" disabled={busy} onClick={login}>
          {t("sign.signIn")}
        </button>
      )}
      <details open={me.setupNeeded || !!linkedCode()}>
        <summary>{me.setupNeeded ? t("sign.setupThis") : t("sign.addThis")}</summary>
        <p className="muted small">
          {linkedCode() ? t("sign.codeFilled") : t("sign.scan")} {t("sign.codeStays")}
        </p>
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder={t("sign.codeLabel")}
          autoCapitalize="characters"
          aria-label={t("sign.codeLabel")}
        />
        <button disabled={busy || !code} onClick={setup}>
          {t("sign.create")}
        </button>
      </details>
      {msg && (
        <p className="error" role="alert">
          {msg}
        </p>
      )}
      <LegalLinks />
    </main>
  );
}

/** Joining a workspace from an invite link: a name and a new passkey, or the passkey of the account the invite was
 *  sent to. The page doesn't know (and the server doesn't say) whether that account exists: the person picks. */
function InvitePage({ token, onDone }: { token: string; onDone: () => void }) {
  const [invite, setInvite] = useState<{ workspace: string; role: string } | null>(null);
  const [gone, setGone] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const path = `invite/${encodeURIComponent(token)}`;
  useEffect(() => {
    api<{ workspace: string; role: string }>(path)
      .then(setInvite)
      .catch(() => setGone(true));
  }, [path]);
  const join = async (mode: "new" | "existing") => {
    setBusy(true);
    setMsg(null);
    try {
      type Ceremony = { options: never; challengeId: string };
      const o = await api<{ register: Ceremony; signIn: Ceremony }>(`${path}/options`, { name });
      const c = mode === "new" ? o.register : o.signIn;
      const response =
        mode === "new"
          ? await startRegistration({ optionsJSON: c.options })
          : await startAuthentication({ optionsJSON: c.options });
      await api(`${path}/verify`, {
        mode,
        challengeId: c.challengeId,
        response,
        device: navigator.userAgent.includes("Android") ? "Android phone" : "device",
      });
      onDone();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="center">
      <h1 className="brand-title">
        {LOGO}
        {BRAND.name}
      </h1>
      {gone ? (
        <>
          <h2>{t("invite.gone")}</h2>
          <p className="muted">{t("invite.goneDetail")}</p>
        </>
      ) : !invite ? (
        <p className="muted">{t("common.loading")}</p>
      ) : (
        <>
          <h2>{t("invite.title", { workspace: invite.workspace })}</h2>
          <p className="muted">{t("invite.asRole", { role: invite.role })}</p>
          <h3>{t("invite.new")}</h3>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("invite.name")}
            aria-label={t("invite.name")}
            autoComplete="name"
          />
          <p className="muted small">{t("invite.passkey")}</p>
          <button type="button" className="primary" disabled={busy} onClick={() => join("new")}>
            {busy ? t("invite.waiting") : t("invite.create")}
          </button>
          <h3>{t("invite.existing")}</h3>
          <p className="muted small">{t("invite.existingDetail")}</p>
          <button type="button" disabled={busy} onClick={() => join("existing")}>
            {t("invite.signIn")}
          </button>
        </>
      )}
      {msg && (
        <p className="error" role="alert">
          {msg}
        </p>
      )}
    </main>
  );
}
