// What the app's screens share: the types the server answers with, loading and its cache, time zones, the
// platforms and channels, the shared state, icons and the small pieces several screens show.

import { createContext, type ReactNode, useCallback, useContext, useEffect, useLayoutEffect, useState } from "react";
import { api, HttpError, type QueueItem, type YouTubeSettings, type YouTubeTexts } from "./api";
import { dateLocale, t } from "./i18n";

export type Me = {
  signedIn: boolean;
  /** The workspace's locale: the catalogue the app reads its text from. */
  locale: string;
  setupNeeded: boolean;
  vapidPublicKey: string;
  dryRun: boolean;
  /** The running server's version (signed in only), shown beside the app's own. */
  server?: { version: string; commit: string | null } | null;
  /** The zone the app shows and takes times in: the user's own, else the workspace's. */
  timezone?: string;
  workspaceTimezone?: string;
  /** The workspace's active accounts: none yet means the app points at the dashboard's setup. */
  accounts?: number;
  /** What the signed-in role may do (the server's ROLE_SCOPES): an action is shown only to someone who can take it. */
  scopes?: string[];
  /** An admin or a creator of the workspace: Settings offers connecting accounts. */
  connects?: boolean;
  /** Signed in, but a member of no workspace (yet, or any more): nothing to show but "ask for an invite". */
  noWorkspace?: boolean;
  /** Where the session works (null: in none), and every workspace the person can open, with their role there. */
  workspace?: { id: string; name: string; mediaFolder: string; iconUrl: string | null } | null;
  workspaces?: { id: string; name: string; role: string; iconUrl: string | null; shownAs: string | null }[];
  /** The person's own name (all workspaces), the one this workspace shows for them, and what it shows now. */
  you?: { name: string | null; emailName: string | null; displayName: string | null; shownAs: string | null } | null;
};

export type Status = {
  dry_run: boolean;
  paused: boolean;
  /** Who paused it, as the workspace names them (null: unknown). */
  paused_by?: string | null;
  today: string;
  timezone: string;
  jobs_last_7_days: { state: string; mode: string; n: number }[];
};

export type Draft = {
  id: string;
  kind: string;
  account: string;
  source: string;
  created_by: string;
  /** Who made it, as the workspace names them (null: nobody to name). */
  by?: string | null;
  created_at: string;
  payload: Record<string, string> & {
    media?: string[];
    files?: { name: string; mime: string }[];
    options?: Record<string, unknown>;
  };
  previews?: { name: string; mime: string; url: string }[];
  /** A YouTube video's title, languages and tags (null: none yet). */
  texts?: YouTubeTexts | null;
};

/** `/app-api/drafts`: each account's platform, and a YouTube channel's default settings. */
export type AccountInfo = Record<string, { platform: string; youtube?: YouTubeSettings }>;

export type DraftsAnswer = { accounts: string[]; accountInfo?: AccountInfo; drafts: Draft[] };

// Each route change opens the new page at the top; going back/forward to a history entry the app made restores
// where that page was scrolled (entries are tagged in history.state, their scrollY kept here).
const scrolls = new Map<number, number>();

export let entry = 0;

function tagEntry(): number {
  const k = (history.state as { k?: number } | null)?.k;
  if (k !== undefined) return k;
  const n = Date.now() + Math.random();
  history.replaceState({ ...(history.state as object | null), k: n }, "");
  return n;
}

export function useHash(): string {
  const [h, set] = useState(location.hash || "#/");
  useEffect(() => {
    history.scrollRestoration = "manual";
    entry = tagEntry();
    const f = () => {
      scrolls.set(entry, scrollY);
      entry = tagEntry();
      set(location.hash || "#/");
    };
    addEventListener("hashchange", f);
    return () => removeEventListener("hashchange", f);
  }, []);
  useLayoutEffect(() => {
    scrollTo({ top: scrolls.get(entry) ?? 0, behavior: "instant" });
  }, [h]);
  return h;
}

// A day's cache of what the app last loaded (localStorage, this device only): a page opens with today's cached
// data at once and is refreshed from the server right after. Entries from other days are dropped; signing out
// clears it. Storage can be missing or full (private mode): then the app just waits for the network.
// Each entry keeps the time it was fetched, so a page can say how old it is when the refresh fails.
const CACHE = "bongsu-cache:";

let CACHE_SCOPE = "";
/** Whose answers the cache holds: the host's API and the workspace (`/app-api|w_…`), so the app and the dashboard, or
 *  two workspaces, never read each other's in the same browser. Pruning is by day, before the scope. */
export function setCacheScope(scope: string) {
  CACHE_SCOPE = scope;
}

const cacheKey = (path: string) => `${CACHE}${zoneShift(0)}:${CACHE_SCOPE}:${path}`;

type Cached<T> = { at: number; data: T };

export function cacheGet<T>(path: string): Cached<T> | null {
  try {
    const v = localStorage.getItem(cacheKey(path));
    if (!v) return null;
    const o = JSON.parse(v) as Cached<T> | T;
    return o && typeof o === "object" && "at" in o && "data" in o ? (o as Cached<T>) : { at: 0, data: o as T };
  } catch {
    return null;
  }
}

export function cachePut(path: string, data: unknown) {
  try {
    localStorage.setItem(cacheKey(path), JSON.stringify({ at: Date.now(), data }));
  } catch {
    /* full or blocked: skip */
  }
}

export function cachePrune(all = false) {
  try {
    const today = `${CACHE}${zoneShift(0)}:`;
    for (const k of Object.keys(localStorage))
      if (k.startsWith(CACHE) && (all || !k.startsWith(today))) localStorage.removeItem(k);
  } catch {
    /* nothing to prune */
  }
}

/** An error as one plain sentence: what happened and what to do. */
export function friendly(e: Error): string {
  if (!(e instanceof HttpError)) return t("error.offline");
  if (e.status === 401) return t("error.signedOut");
  if (e.status >= 500) return t("error.server");
  return cap(e.message.replace(/\.$/, "")) + ".";
}

/** Loads `path`, showing today's cached copy first. `stale` is set when the refresh failed and the page is showing
 *  that cached copy: say so (with its time) instead of passing old data off as live. */
export function useLoad<T>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(() => (path ? (cacheGet<T>(path)?.data ?? null) : null));
  const [error, setError] = useState<string | null>(null);
  const [at, setAt] = useState<number | null>(null);
  const [stale, setStale] = useState<string | null>(null);
  const [fresh, setFresh] = useState(false); // true once this page has the server's current answer
  const reload = useCallback(() => {
    if (!path) return;
    setError(null);
    setFresh(false);
    const hit = cacheGet<T>(path);
    if (hit) {
      setData(hit.data);
      setAt(hit.at || null);
    }
    api<T>(path)
      .then((d) => {
        setData(d);
        cachePut(path, d);
        setAt(Date.now());
        setStale(null);
        setFresh(true);
      })
      .catch((e: Error) => {
        if (hit) setStale(friendly(e));
        else setError(friendly(e));
      });
  }, [path]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(reload, [reload, ...deps]);
  return { data, error, reload, at, stale, fresh };
}

// ---------------------------------------------------------------- formats

// Times are shown and entered in the user's time zone (from /app-api/me: their own, else the workspace's), not the
// device's; the server stores UTC.
export let ZONE = "UTC";

export const setZone = (tz: string | undefined) => {
  if (tz) ZONE = tz;
};

export const zoneParts = (ms: number) => {
  const o: Record<string, string> = {};
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: ZONE,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  for (const p of f.formatToParts(new Date(ms))) o[p.type] = p.value;
  return o;
};

export const zoneShift = (days: number) => {
  const p = zoneParts(Date.now());
  return new Date(Date.UTC(+p.year, +p.month - 1, +p.day + days)).toISOString().slice(0, 10);
};

export const zoneToday = () => zoneShift(0);

export const zoneClock = (ms: number) => {
  const p = zoneParts(ms);
  return `${p.hour}:${p.minute}`;
};

/** The zone's short label, e.g. "GMT+9" or "CET". */
export const zoneLabel = () =>
  new Intl.DateTimeFormat("en-US", { timeZone: ZONE, timeZoneName: "short" })
    .formatToParts(new Date())
    .find((p) => p.type === "timeZoneName")?.value ?? ZONE;

const DUE = /(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?/;

export const dueDate = (due?: string | null) => DUE.exec(due ?? "")?.[1] ?? null;

export const dueTime = (due?: string | null) => DUE.exec(due ?? "")?.[2] ?? null;

/** "Today", "Tomorrow", or "Wed 21 Oct" for a date in the workspace's zone. */
export function dayName(date: string): string {
  if (date === zoneToday()) return t("day.today");
  if (date === zoneShift(1)) return t("day.tomorrow");
  if (date === zoneShift(-1)) return t("day.yesterday");
  return new Date(`${date}T00:00:00Z`).toLocaleDateString(dateLocale(), {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

/** A due string ("YYYY-MM-DD HH:MM[ zone]") as "Tomorrow · 18:00 GMT+9". */
export function when(due?: string | null): string {
  const d = dueDate(due);
  if (!d) return t("day.noDate");
  const time = dueTime(due);
  return time ? `${dayName(d)} · ${time} ${zoneLabel()}` : dayName(d);
}

/** An ISO UTC timestamp ("2026-10-21T02:56:18Z") shown in the workspace's zone. */
export function utcToZone(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const p = zoneParts(ms);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} ${zoneLabel()}`;
}

export const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** "short5_lisbon_food" → "Lisbon food"; "carousel2_food" → "Food". Anything else is returned as it is. */
export function nice(name: string): string {
  const last = name.includes(" ") ? name : (name.split("/").pop() ?? name); // titles with spaces are already readable
  const m = /^(?:(?:short|reel|carousel|post|photo|video)\d*|\d+)_(.+)$/.exec(last);
  return m
    ? cap(m[1].replace(/_/g, " "))
    : last.includes("_") && !last.includes(" ")
      ? cap(last.replace(/_/g, " "))
      : last;
}

/** "vlogs/CONTENT/20260823_LISBON" → "Lisbon (Aug)"; "20261008_PORTO_RIDE" → "Porto ride (Oct)": the month tells two
 *  projects with the same name apart. */
export function project(folder: string): string {
  const last = folder.split("/").pop() ?? folder;
  const m = /^(\d{4})(\d{2})\d{2}(?:-\d{1,2})?[_ ](.+)$/.exec(last);
  const name = cap((m ? m[3] : last).replace(/_/g, " ").toLowerCase());
  return m
    ? `${name} (${new Date(Date.UTC(+m[1], +m[2] - 1, 1)).toLocaleDateString(dateLocale(), { month: "short", timeZone: "UTC" })})`
    : name;
}

/** An item key ("reel:20260823_LISBON/short5_lisbon_food") as a readable title. */
export const keyTitle = (key: string) =>
  nice(
    key
      .replace(/^(reel|post):/, "")
      .split("/")
      .pop() ?? key,
  );

// ---------------------------------------------------------------- channel code (DESIGN.md: The Channel Code Rule)

// Names come from the server's platform list (/app-api/platforms): the app names no network itself. A channel is a
// platform and a format: "Instagram Reel", "YouTube Short", "FakeNet Note"…
export type PlatformInfo = {
  id: string;
  name: string;
  accountNoun: string;
  formats: { format: string; name: string; plural: string }[];
  post: { name: string; plural: string };
  features: Record<string, boolean>;
};

export let PLATFORMS = new Map<string, PlatformInfo>();

export const setPlatforms = (list: PlatformInfo[]) => {
  PLATFORMS = new Map(list.map((p) => [p.id, p]));
};

export const platformName = (id: string) => PLATFORMS.get(id)?.name ?? cap(id);

export type Channel = { platform: string; format: string | null; label?: string };

/** What the platform calls a post of this format ("Reel"), or the server's own label for it. */
const channelShort = (c: Channel) =>
  c.label ??
  PLATFORMS.get(c.platform)?.formats.find((f) => f.format === c.format)?.name ??
  PLATFORMS.get(c.platform)?.post.name ??
  t("channel.post");

export const channelLabel = (c: Channel) => `${platformName(c.platform)} ${channelShort(c)}`;

/** The dot's look: one colour per platform, a circle for videos and a square for the rest (styles.css). */
export const dotClass = (c: Channel) => `dot p-${c.platform}${c.format === "video" ? " video" : ""}`;

export const itemChannel = (i: { platform?: string; format?: string | null; label?: string }): Channel => ({
  platform: i.platform ?? "instagram",
  format: i.format ?? null,
  label: i.label,
});

export const Dot = ({ c }: { c: Channel }) => <i className={dotClass(c)} aria-hidden="true" />;

/** What an item needs from the owner, or null when it's set. */
export function needs(i: QueueItem): "approve" | "re-approve" | null {
  if (i.hold) return null;
  if (!i.approved) return "approve";
  return i.approval_matches_schedule ? null : "re-approve";
}

// ---------------------------------------------------------------- shared state: status, what needs you, drafts

export type Shared = {
  status: ReturnType<typeof useLoad<Status>>;
  attention: QueueItem[];
  overdue: QueueItem[];
  held: QueueItem[];
  queue: ReturnType<typeof useLoad<{ items: QueueItem[] }>>;
  drafts: ReturnType<typeof useLoad<DraftsAnswer>>;
  unseen: ReturnType<typeof useLoad<{ n: number }>>;
  refresh: () => void;
};

export const SharedCtx = createContext<Shared | null>(null);

export const useShared = () => useContext(SharedCtx)!;

export const MeCtx = createContext<Me | null>(null);

/** True once /app-api/me says the workspace has no active account: every list shows the setup note instead. */
export const useNoAccounts = () => useContext(MeCtx)?.accounts === 0;

/** What an empty list says once accounts exist: where posts come from. */
export const EMPTY = {
  // getters: read at render time, after the locale is known
  get scheduled() {
    return (
      <>
        {t("empty.scheduledBefore")} <a href="#/drafts">{t("empty.scheduledLink")}</a>.
      </>
    );
  },
  get drafts() {
    return t("empty.drafts");
  },
};

/** No account connected yet: the one note every page shows, pointing at the dashboard's setup and the guides. */
export function SetupNote() {
  return (
    <div className="notice" role="status">
      <p>
        <strong>{t("setup.none")}</strong> {t("setup.connect")}
      </p>
      <p className="small">
        <a href="/dashboard/start">{t("setup.start")}</a> · {t("setup.guides")}{" "}
        <a href="/dashboard/docs/instagram-graph" target="_blank" rel="noopener">
          Instagram
        </a>
        ,{" "}
        <a href="/dashboard/docs/youtube" target="_blank" rel="noopener">
          YouTube
        </a>
      </p>
    </div>
  );
}

// Icons for the header and the bottom bar (inline, stroke follows the text colour).
const svg = (d: ReactNode, size = 22) => (
  <svg
    viewBox="0 0 24 24"
    width={size}
    height={size}
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {d}
  </svg>
);

export const ICON = {
  home: svg(
    <>
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5 9.5V21h14V9.5" />
      <path d="M10 21v-6h4v6" />
    </>,
  ),
  stats: svg(
    <>
      <path d="M4 20V10M10 20V4M16 20v-8M22 20H2" />
    </>,
  ),
  queue: svg(
    <>
      <path d="M8 6h13M8 12h13M8 18h13" />
      <circle cx="3.5" cy="6" r="1" />
      <circle cx="3.5" cy="12" r="1" />
      <circle cx="3.5" cy="18" r="1" />
    </>,
  ),
  drafts: svg(
    <>
      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
      <path d="M14 3v6h6M9 14h6M9 18h4" />
    </>,
  ),
  calendar: svg(
    <>
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M16 2v4M8 2v4M3 10h18" />
    </>,
  ),
  settings: svg(
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </>,
  ),
  check: svg(<path d="M20 6 9 17l-5-5" />, 20),
  back: svg(<path d="M15 18l-6-6 6-6" />, 20),
  pause: svg(
    <>
      <rect x="6" y="5" width="4" height="14" rx="1" />
      <rect x="14" y="5" width="4" height="14" rx="1" />
    </>,
    18,
  ),
  plus: svg(<path d="M12 5v14M5 12h14" />, 18),
  comment: svg(<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" />, 22),
  info: svg(
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5" />
      <circle cx="12" cy="7.8" r="1.1" fill="currentColor" stroke="none" />
    </>,
    22,
  ),
  pencil: svg(
    <>
      <path d="M4 20h4L19 9l-4-4L4 16z" />
      <path d="M14 6l4 4" />
    </>,
    20,
  ),
  chevL: svg(<path d="M15 18l-6-6 6-6" />, 22),
  external: svg(
    <>
      <path d="M14 4h6v6" />
      <path d="M20 4l-9 9" />
      <path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
    </>,
    20,
  ),
  // the platforms, drawn as outlines in the same stroke (not the brands' filled logos)
  instagram: svg(
    <>
      <rect x="3" y="3" width="18" height="18" rx="5" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="17.3" cy="6.7" r="1.2" fill="currentColor" stroke="none" />
    </>,
    20,
  ),
  youtube: svg(
    <>
      <rect x="2.5" y="5.5" width="19" height="13" rx="4" />
      <path d="M10.2 9.3v5.4l4.6-2.7z" fill="currentColor" />
    </>,
    20,
  ),
  chevR: svg(<path d="M9 18l6-6-6-6" />, 22),
  chevD: svg(<path d="M6 9l6 6 6-6" />, 14),
};

/** The instance's name (build input BONGSU_APP_NAME, site/docs/configuration.md). */
/** The app's name and colour: the app's build sets them (__APP_BRAND__); another host passes its own (setBrand). */
export let BRAND: { name: string; themeColor: string } =
  typeof __APP_BRAND__ === "undefined" ? { name: "Bongsu", themeColor: "#131f2a" } : __APP_BRAND__;
export function setBrand(b: { name: string; themeColor: string }) {
  BRAND = b;
}

/** The instance's privacy policy and terms (privacy/, terms/: pages of their own, outside the app's hash routes). */
export const LegalLinks = () => (
  <p className="muted small legal">
    <a href="/privacy/">{t("legal.privacy")}</a> · <a href="/terms/">{t("legal.terms")}</a>
  </p>
);

/** Where the item page's back link goes: the last list page the owner was on (Today when unknown). */
export let lastList = "#/";
/** The shell sets it as the owner moves between list pages (an import can't be assigned to). */
export const setLastList = (hash: string) => {
  lastList = hash;
};

export const Stale = ({ msg, at, onRetry }: { msg: string; at?: number | null; onRetry?: () => void }) => (
  <div className="notice warn row" role="status">
    <span>
      {at ? t("stale.savedAt", { time: `${zoneClock(at)} ${zoneLabel()}` }) : t("stale.saved")} {msg}
    </span>
    {onRetry && <button onClick={onRetry}>{t("common.tryAgain")}</button>}
  </div>
);

export const ErrorNote = ({ msg, onRetry }: { msg: string; onRetry?: () => void }) => (
  <div className="notice bad row" role="alert">
    <span>{msg}</span>
    {onRetry && <button onClick={onRetry}>{t("common.tryAgain")}</button>}
  </div>
);

/** An on/off switch (a button with role="switch"), label beside it. */
export function Switch({
  on,
  label,
  onChange,
  disabled,
}: {
  on: boolean;
  label: React.ReactNode;
  onChange: (on: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      className="switch"
      disabled={disabled}
      onClick={() => onChange(!on)}
    >
      <span className="switch-track" aria-hidden="true">
        <span className="switch-knob" />
      </span>
      <span className="switch-label">{label}</span>
    </button>
  );
}

// ---------------------------------------------------------------- results

/** A two-way (or more) choice in the Queue's segmented style; `grid` lays six choices out three to a row. */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  grid,
}: {
  label: string;
  value: T;
  options: { value: T; text: string }[];
  onChange: (v: T) => void;
  grid?: boolean;
}) {
  return (
    <div className={`segmented${grid ? " grid" : ""}`} role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.text}
        </button>
      ))}
    </div>
  );
}

/** A destructive button that asks once, in place, before it acts. */
export function ConfirmButton({
  label,
  confirm,
  detail,
  onConfirm,
  full = false,
  tone = "danger",
}: {
  label: string;
  confirm: string;
  detail: string;
  onConfirm: () => Promise<unknown> | void;
  full?: boolean;
  tone?: "danger" | "go";
}) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const cls = tone === "danger" ? "danger" : "";
  if (!asking)
    return (
      <button className={`${cls}${full ? " full" : ""}`} onClick={() => setAsking(true)}>
        {label}
      </button>
    );
  return (
    <div className={`confirm-ask${tone === "go" ? " go" : ""}`} role="alertdialog" aria-label={confirm}>
      <p className="small">
        <strong>{confirm}</strong> {detail}
      </p>
      <div className="row">
        <button onClick={() => setAsking(false)} disabled={busy}>
          {t("common.cancel")}
        </button>
        <button
          className={tone === "danger" ? "danger" : "primary inline"}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onConfirm();
            } finally {
              setBusy(false);
              setAsking(false);
            }
          }}
        >
          {busy ? "…" : label}
        </button>
      </div>
    </div>
  );
}
