// The owner's app: see what's scheduled, approve with a passkey, get push notifications.
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  api,
  type ChannelStats,
  HttpError,
  type Item,
  type MetricPoint,
  type Metrics,
  type NoteGroup,
  type NotifyPrefs,
  notifyPrefs,
  type QueueItem,
  type Results,
  setNotifyPref,
  switchWorkspace,
} from "./api";
import { type ChartSeries, LineChart } from "./Chart";
import { dateLocale, type Key, setLocale, t } from "./i18n";
import { takeWorkspaceParam } from "./workspace-link";

type Me = {
  signedIn: boolean;
  /** The workspace's locale: the catalogue the app reads its text from. */
  locale: string;
  setupNeeded: boolean;
  vapidPublicKey: string;
  dryRun: boolean;
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
  workspace?: { id: string; name: string } | null;
  workspaces?: { id: string; name: string; role: string }[];
};
type Status = {
  dry_run: boolean;
  paused: boolean;
  today: string;
  timezone: string;
  jobs_last_7_days: { state: string; mode: string; n: number }[];
};
type Draft = {
  id: string;
  kind: string;
  account: string;
  source: string;
  created_by: string;
  created_at: string;
  payload: Record<string, string> & { media?: string[] };
  previews?: { name: string; mime: string; url: string }[];
};

// Each route change opens the new page at the top; going back/forward to a history entry the app made restores
// where that page was scrolled (entries are tagged in history.state, their scrollY kept here).
const scrolls = new Map<number, number>();
let entry = 0;
function tagEntry(): number {
  const k = (history.state as { k?: number } | null)?.k;
  if (k !== undefined) return k;
  const n = Date.now() + Math.random();
  history.replaceState({ ...(history.state as object | null), k: n }, "");
  return n;
}

function useHash(): string {
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
const cacheKey = (path: string) => `${CACHE}${zoneShift(0)}:${path}`;
type Cached<T> = { at: number; data: T };
function cacheGet<T>(path: string): Cached<T> | null {
  try {
    const v = localStorage.getItem(cacheKey(path));
    if (!v) return null;
    const o = JSON.parse(v) as Cached<T> | T;
    return o && typeof o === "object" && "at" in o && "data" in o ? (o as Cached<T>) : { at: 0, data: o as T };
  } catch {
    return null;
  }
}
function cachePut(path: string, data: unknown) {
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
function friendly(e: Error): string {
  if (!(e instanceof HttpError)) return t("error.offline");
  if (e.status === 401) return t("error.signedOut");
  if (e.status >= 500) return t("error.server");
  return cap(e.message.replace(/\.$/, "")) + ".";
}

/** Loads `path`, showing today's cached copy first. `stale` is set when the refresh failed and the page is showing
 *  that cached copy: say so (with its time) instead of passing old data off as live. */
function useLoad<T>(path: string | null, deps: unknown[] = []) {
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
let ZONE = "UTC";
const setZone = (tz: string | undefined) => {
  if (tz) ZONE = tz;
};
const zoneParts = (ms: number) => {
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
const zoneShift = (days: number) => {
  const p = zoneParts(Date.now());
  return new Date(Date.UTC(+p.year, +p.month - 1, +p.day + days)).toISOString().slice(0, 10);
};
const zoneToday = () => zoneShift(0);
const zoneClock = (ms: number) => {
  const p = zoneParts(ms);
  return `${p.hour}:${p.minute}`;
};
/** The zone's short label, e.g. "GMT+9" or "CET". */
const zoneLabel = () =>
  new Intl.DateTimeFormat("en-US", { timeZone: ZONE, timeZoneName: "short" })
    .formatToParts(new Date())
    .find((p) => p.type === "timeZoneName")?.value ?? ZONE;
const shiftMonth = (m: string, by: number) => {
  const d = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1 + by, 1));
  return d.toISOString().slice(0, 7);
};
const DUE = /(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?/;
const dueDate = (due?: string | null) => DUE.exec(due ?? "")?.[1] ?? null;
const dueTime = (due?: string | null) => DUE.exec(due ?? "")?.[2] ?? null;

/** "Today", "Tomorrow", or "Wed 21 Oct" for a date in the workspace's zone. */
function dayName(date: string): string {
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
function when(due?: string | null): string {
  const d = dueDate(due);
  if (!d) return t("day.noDate");
  const time = dueTime(due);
  return time ? `${dayName(d)} · ${time} ${zoneLabel()}` : dayName(d);
}
/** An ISO UTC timestamp ("2026-10-21T02:56:18Z") shown in the workspace's zone. */
function utcToZone(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const p = zoneParts(ms);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} ${zoneLabel()}`;
}
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
/** "short5_lisbon_food" → "Lisbon food"; "carousel2_food" → "Food". Anything else is returned as it is. */
function nice(name: string): string {
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
function project(folder: string): string {
  const last = folder.split("/").pop() ?? folder;
  const m = /^(\d{4})(\d{2})\d{2}(?:-\d{1,2})?[_ ](.+)$/.exec(last);
  const name = cap((m ? m[3] : last).replace(/_/g, " ").toLowerCase());
  return m
    ? `${name} (${new Date(Date.UTC(+m[1], +m[2] - 1, 1)).toLocaleDateString(dateLocale(), { month: "short", timeZone: "UTC" })})`
    : name;
}
/** An item key ("reel:20260823_LISBON/short5_lisbon_food") as a readable title. */
const keyTitle = (key: string) =>
  nice(
    key
      .replace(/^(reel|post):/, "")
      .split("/")
      .pop() ?? key,
  );
/** Notification text without links, and with item keys made readable. */
const noteText = (s: string) =>
  s
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\b(reel|post):[\w./-]+/g, (k) => `"${keyTitle(k)}"`)
    .replace(/\s{2,}/g, " ")
    .trim();

// ---------------------------------------------------------------- channel code (DESIGN.md: The Channel Code Rule)

// Names come from the server's platform list (/app-api/platforms): the app names no network itself. A channel is a
// platform and a format: "Instagram Reel", "YouTube Short", "FakeNet Note"…
type PlatformInfo = {
  id: string;
  name: string;
  accountNoun: string;
  formats: { format: string; name: string; plural: string }[];
  post: { name: string; plural: string };
  features: Record<string, boolean>;
};
let PLATFORMS = new Map<string, PlatformInfo>();
const setPlatforms = (list: PlatformInfo[]) => {
  PLATFORMS = new Map(list.map((p) => [p.id, p]));
};
const platformName = (id: string) => PLATFORMS.get(id)?.name ?? cap(id);
const feature = (id: string, f: string) => !!PLATFORMS.get(id)?.features[f];

type Channel = { platform: string; format: string | null; label?: string };
/** What the platform calls a post of this format ("Reel"), or the server's own label for it. */
const channelShort = (c: Channel) =>
  c.label ??
  PLATFORMS.get(c.platform)?.formats.find((f) => f.format === c.format)?.name ??
  PLATFORMS.get(c.platform)?.post.name ??
  t("channel.post");
const channelLabel = (c: Channel) => `${platformName(c.platform)} ${channelShort(c)}`;
/** The dot's look: one colour per platform, a circle for videos and a square for the rest (styles.css). */
const dotClass = (c: Channel) => `dot p-${c.platform}${c.format === "video" ? " video" : ""}`;
const channelKey = (c: Channel) => `${c.platform}:${c.format === "video" ? "video" : "post"}`;
const itemChannel = (i: { platform?: string; format?: string | null; label?: string }): Channel => ({
  platform: i.platform ?? "instagram",
  format: i.format ?? null,
  label: i.label,
});
const Dot = ({ c }: { c: Channel }) => <i className={dotClass(c)} aria-hidden="true" />;
/** The platform's own icon where the app has one, else a generic "open". */
const platformIcon = (id: string) =>
  id === "youtube" ? ICON.youtube : id === "instagram" ? ICON.instagram : ICON.external;

/** What an item needs from the owner, or null when it's set. */
function needs(i: QueueItem): "approve" | "re-approve" | null {
  if (i.hold) return null;
  if (!i.approved) return "approve";
  return i.approval_matches_schedule ? null : "re-approve";
}

// ---------------------------------------------------------------- shared state: status, what needs you, drafts

type Shared = {
  status: ReturnType<typeof useLoad<Status>>;
  attention: QueueItem[];
  overdue: QueueItem[];
  held: QueueItem[];
  queue: ReturnType<typeof useLoad<{ items: QueueItem[] }>>;
  drafts: ReturnType<typeof useLoad<{ accounts: string[]; drafts: Draft[] }>>;
  unseen: ReturnType<typeof useLoad<{ n: number }>>;
  refresh: () => void;
};
const SharedCtx = createContext<Shared | null>(null);
const useShared = () => useContext(SharedCtx)!;
const MeCtx = createContext<Me | null>(null);
/** True once /app-api/me says the workspace has no active account: every list shows the setup note instead. */
const useNoAccounts = () => useContext(MeCtx)?.accounts === 0;
/** Whether the signed-in role has a scope, e.g. "reschedule" for moving a YouTube release date. */
const useCan = (scope: string) => useContext(MeCtx)?.scopes?.includes(scope) ?? false;

/** What an empty list says once accounts exist: where posts come from. */
const EMPTY = {
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
function SetupNote() {
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

function useSharedState(): Shared {
  const status = useLoad<Status>("status");
  const queue = useLoad<{ items: QueueItem[] }>("queue?days=7");
  const drafts = useLoad<{ accounts: string[]; drafts: Draft[] }>("drafts");
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
const ICON = {
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

/** The app's mark at 32 px: the small mark drawn for that size (public/favicon.svg, from mark-small.svg). */
const LOGO = <img src="/favicon.svg" width={32} height={32} alt="" />;

/** The instance's name (build input BONGSU_APP_NAME, site/docs/configuration.md). */
const BRAND = __APP_BRAND__;

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

/** Where the item page's back link goes: the last list page the owner was on (Today when unknown). */
let lastList = "#/";

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
  if (!onItem && !onVideo && !route.startsWith("/setup") && !route.startsWith("/stats/")) lastList = hash || "#/";
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
                    <span className="clip">{me.workspace.name}</span>
                    {ICON.chevD}
                  </button>
                ) : (
                  <span className="ws-name clip">{me.workspace.name}</span>
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
          {shared.status.data?.paused && (
            <div className="banner bad" role="status">
              {ICON.pause}
              <span>
                <strong>{t("header.paused")}</strong> {t("header.pausedDetail")}
              </span>
              <a href="#/settings">{t("header.resume")}</a>
            </div>
          )}
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

/** The header's picker: the workspaces the person can open, with their role in each. Choosing one moves the app's
 *  session there (the dashboard's keeps its own) and opens its queue. A native modal dialog, docked to the bottom in
 *  the thumb zone: it brings the focus trap, Escape and the backdrop. */
function WorkspaceSheet({ me, onClose, onSwitched }: { me: Me; onClose: () => void; onSwitched: () => void }) {
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
      location.hash = "#/queue";
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
                <span className="clip">{w.name}</span>
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

// ---------------------------------------------------------------- rows (one look for every list of items)

/** A row's status: its border colour (green: approved / posted / public; amber: waiting on the owner; red: failed;
 *  none: neutral), with the word kept for screen readers. */
type Tone = "ok" | "warn" | "bad" | "";
function queueStatus(i: QueueItem): { tone: Tone; word: string } {
  if (i.hold) return { tone: "warn", word: t("status.hold") };
  const n = needs(i);
  if (!n) return { tone: "ok", word: t("status.approved") };
  return { tone: "warn", word: n === "approve" ? t("status.notApproved") : t("status.reApprove") };
}

/** A row: channel dot and label, title, when, account; the border's colour is the status (no
 *  label on the row). The row opens the item in the app; a posted or public one also gets the platform's icon, which
 *  opens the real post or video (only the icon, not the row). */
function Row({
  channel,
  title,
  time,
  account,
  extra,
  status,
  href,
  out,
}: {
  channel: Channel;
  title: string;
  time: string;
  account?: string;
  extra?: string;
  status: { tone: Tone; word: string };
  href?: string;
  out?: string;
}) {
  const body = (
    <>
      <div className="row">
        <strong className="clip">{title}</strong>
        <span className="vh">, {status.word}</span>
      </div>
      <div className="meta">
        <span className="when">{time}</span>
        <span className="muted">
          <Dot c={channel} />
          {channelLabel(channel)}
          {account ? ` · @${account}` : ""}
          {extra ? ` · ${extra}` : ""}
        </span>
      </div>
    </>
  );
  const where = platformName(channel.platform);
  return (
    <li
      className={
        [out ? "has-out" : "", status.tone ? `tone-${status.tone}` : ""].filter(Boolean).join(" ") || undefined
      }
      title={status.word}
    >
      {href ? <a href={href}>{body}</a> : <div>{body}</div>}
      {out && (
        <a
          className="out"
          href={out}
          target="_blank"
          rel="noopener"
          aria-label={t("row.openTitleOn", { title, where })}
          title={t("row.openOn", { where })}
        >
          {platformIcon(channel.platform)}
        </a>
      )}
    </li>
  );
}

function QueueList({
  items,
  empty = EMPTY.scheduled,
  timeOnly = false,
}: {
  items: QueueItem[];
  empty?: ReactNode;
  timeOnly?: boolean;
}) {
  if (!items.length) return <p className="muted">{empty}</p>;
  return (
    <ul className="list">
      {items.map((i) => (
        <Row
          key={i.key}
          channel={itemChannel(i)}
          title={i.title || nice(i.name)}
          time={timeOnly && dueTime(i.due) ? `${dueTime(i.due)} ${zoneLabel()}` : when(i.due)}
          account={i.account}
          extra={project(i.folder)}
          status={queueStatus(i)}
          href={`#/item/${encodeURIComponent(i.key)}`}
        />
      ))}
    </ul>
  );
}

/** A queue split into one group per day, with the day as a heading. */
function DayGroups({ items }: { items: QueueItem[] }) {
  if (!items.length) return <p className="muted">{EMPTY.scheduled}</p>;
  const by = new Map<string, QueueItem[]>();
  for (const i of items) {
    const d = dueDate(i.due) ?? "none";
    by.set(d, [...(by.get(d) ?? []), i]);
  }
  return (
    <>
      {[...by].map(([d, list]) => (
        <section key={d} className="day-group">
          <h2 className="day-head">
            {d === "none" ? t("day.none") : dayName(d)}
            {d === zoneToday() || d === zoneShift(1) ? (
              <span className="muted">
                {" "}
                ·{" "}
                {new Date(`${d}T00:00:00Z`).toLocaleDateString(dateLocale(), {
                  weekday: "short",
                  day: "numeric",
                  month: "short",
                  timeZone: "UTC",
                })}
              </span>
            ) : null}
          </h2>
          <QueueList items={list} timeOnly />
        </section>
      ))}
    </>
  );
}

/** The plan's channel groups (the repo's channels/<name>/ folders) as the owner calls them. */
const CHANNEL_NAME: Record<string, string> = { main: "Main", vlogs: "Vlogs", demo_running: "@demo_running" };

const remembered = (k: string) => {
  try {
    return localStorage.getItem(k) ?? "";
  } catch {
    return "";
  }
};
const remember = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* private mode */
  }
};

function QueuePage({
  days,
  title,
  filters = false,
  from,
}: {
  days: number;
  title?: string;
  filters?: boolean;
  from?: string;
}) {
  const noAccounts = useNoAccounts();
  const [channel, setChannelRaw] = useState(filters ? remembered("queue.channel") : "");
  const [group, setGroupRaw] = useState(filters ? remembered("queue.group") : "");
  const [only, setOnlyRaw] = useState(filters ? remembered("queue.only") : "");
  const setChannel = (v: string) => {
    setChannelRaw(v);
    remember("queue.channel", v);
    setGroup("");
  };
  const setGroup = (v: string) => {
    setGroupRaw(v);
    remember("queue.group", v);
  };
  const setOnly = (v: string) => {
    setOnlyRaw(v);
    remember("queue.only", v);
  };
  // The server filters: only the chosen channel/group comes back.
  const qs = new URLSearchParams({
    days: String(days),
    ...(from ? { from } : {}),
    ...(channel ? { channel } : {}),
    ...(group ? { group } : {}),
  }).toString();
  const { data, error, stale, at, reload } = useLoad<{ items: QueueItem[] }>(`queue?${qs}`, [qs]);
  const facets = useLoad<{
    channels: { channel: string; n: number }[];
    groups: { channel: string; group: string; n: number }[];
  }>(filters ? `queue/groups?days=${days}` : null);
  const groups = (facets.data?.groups ?? []).filter((g) => !channel || g.channel === channel);
  const all = data?.items ?? [];
  const waiting = all.filter((i) => needs(i));
  const shown = only === "needs" ? waiting : all;
  return (
    <section>
      {title && <h2>{title}</h2>}
      {filters && (
        <div className="segmented" role="group" aria-label={t("results.show")}>
          <button aria-pressed={only !== "needs"} onClick={() => setOnly("")}>
            {t("queue.all")} <span className="muted">{all.length}</span>
          </button>
          <button aria-pressed={only === "needs"} onClick={() => setOnly("needs")}>
            {t("status.notApproved")} <span className="muted">{waiting.length}</span>
          </button>
        </div>
      )}
      {filters && facets.data && (
        <div className="filters">
          <select value={channel} onChange={(e) => setChannel(e.target.value)} aria-label={t("queue.channel")}>
            <option value="">{t("queue.allChannels")}</option>
            {facets.data.channels.map((c) => (
              <option key={c.channel} value={c.channel}>
                {CHANNEL_NAME[c.channel] ?? cap(c.channel)} ({c.n})
              </option>
            ))}
          </select>
          <select
            value={groups.some((g) => g.group === group) ? group : ""}
            onChange={(e) => setGroup(e.target.value)}
            aria-label={t("queue.project")}
          >
            <option value="">{t("queue.allProjects")}</option>
            {groups.map((g) => (
              <option key={`${g.channel}/${g.group}`} value={g.group}>
                {project(g.group)} ({g.n})
              </option>
            ))}
          </select>
        </div>
      )}
      {filters && <p className="muted small">{t("queue.nextDays", { n: days, zone: zoneLabel() })}</p>}
      {stale && <Stale msg={stale} at={at} onRetry={reload} />}
      {noAccounts ? (
        <SetupNote />
      ) : error ? (
        <ErrorNote msg={error} onRetry={reload} />
      ) : !data ? (
        <p className="muted">{t("common.loading")}</p>
      ) : filters ? (
        shown.length ? (
          <DayGroups items={shown} />
        ) : (
          <p className="muted">{only === "needs" ? t("queue.noneNeeds") : EMPTY.scheduled}</p>
        )
      ) : (
        <QueueList items={shown} />
      )}
    </section>
  );
}

const Stale = ({ msg, at, onRetry }: { msg: string; at?: number | null; onRetry?: () => void }) => (
  <div className="notice warn row" role="status">
    <span>
      {at ? t("stale.savedAt", { time: `${zoneClock(at)} ${zoneLabel()}` }) : t("stale.saved")} {msg}
    </span>
    {onRetry && <button onClick={onRetry}>{t("common.tryAgain")}</button>}
  </div>
);
const ErrorNote = ({ msg, onRetry }: { msg: string; onRetry?: () => void }) => (
  <div className="notice bad row" role="alert">
    <span>{msg}</span>
    {onRetry && <button onClick={onRetry}>{t("common.tryAgain")}</button>}
  </div>
);

// ---------------------------------------------------------------- today

function TodayPage() {
  const { status, attention, overdue, held, drafts, queue } = useShared();
  const noAccounts = useNoAccounts();
  const notes = useLoad<{ notifications: { at: string; title: string; text: string; target: string | null }[] }>(
    "notifications?limit=8",
  );
  const openDrafts = drafts.data?.drafts.length ?? 0;
  const stale = status.stale || queue.stale;
  return (
    <>
      {stale && (
        <Stale
          msg={t("today.offline")}
          at={status.at}
          onRetry={() => {
            status.reload();
            queue.reload();
          }}
        />
      )}
      <NeedsYou
        attention={attention}
        overdue={overdue}
        held={held}
        drafts={openDrafts}
        loading={!queue.data && !queue.error}
      />
      {noAccounts ? (
        <SetupNote />
      ) : (
        <>
          <TodaySection />
          <QueuePage days={3} from={zoneShift(1)} title={t("today.next3")} />
        </>
      )}

      <details className="activity">
        <summary className="tap">
          {t("today.activity")}
          {notes.data?.notifications.length ? (
            <span className="muted"> ({notes.data.notifications.length})</span>
          ) : null}
        </summary>
        {notes.data?.notifications.length ? (
          <ul className="list compact">
            {notes.data.notifications.map((n, k) => (
              <li key={k}>
                {n.target && /^(reel|post):/.test(n.target) ? (
                  <a href={`#/item/${encodeURIComponent(n.target)}`}>
                    <Note n={n} />
                  </a>
                ) : (
                  <Note n={n} />
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">{t("today.activityNone")}</p>
        )}
      </details>
    </>
  );
}

/** The first thing on Today when something waits on the owner (to approve, overdue, open drafts, on hold); nothing otherwise. */
function NeedsYou({
  attention,
  overdue,
  held,
  drafts,
  loading,
}: {
  attention: QueueItem[];
  overdue: QueueItem[];
  held: QueueItem[];
  drafts: number;
  loading: boolean;
}) {
  const n = attention.length + overdue.length + (drafts ? 1 : 0);
  if (loading) return null;
  const heldLine = held.length > 0 && (
    <p className="small held-line">
      <a href={held.length === 1 ? `#/item/${encodeURIComponent(held[0].key)}` : "#/queue"} className="link">
        {t("today.held", { n: held.length })}
      </a>
      {t("today.heldDetail", { n: held.length })}
    </p>
  );
  // Nothing waiting: no block at all (no "all set" row); items on hold still get their line.
  if (!n)
    return held.length ? (
      <section className="needs" aria-label={t("today.needsYou")}>
        <h2>{t("today.needsYou")}</h2>
        {heldLine}
      </section>
    ) : null;
  return (
    <section className="needs" aria-label={t("today.needsYou")}>
      <h2>{t("today.needsYou")}</h2>
      {overdue.length > 0 && (
        <>
          <p className="small bad-text">
            <strong>{t("today.overdue", { n: overdue.length })}</strong>
            {t("today.overdueDetail")}
          </p>
          <QueueList items={overdue} />
        </>
      )}
      {attention.length > 0 && <QueueList items={attention} />}
      {drafts > 0 && (
        <p className="small">
          <a href="#/drafts" className="link">
            {t("today.drafts", { n: drafts })}
          </a>
        </p>
      )}
      {heldLine}
    </section>
  );
}

/** Everything dated today (in the workspace's zone), posted or pending. */
function TodaySection() {
  const day = useLoad<{ events: CalEvent[]; warnings: string[] }>("day");
  const events = day.data?.events ?? [];
  return (
    <section>
      <h2>{t("day.today")}</h2>
      {day.stale && <Stale msg={day.stale} at={day.at} onRetry={day.reload} />}
      {day.error ? (
        <ErrorNote msg={day.error} onRetry={day.reload} />
      ) : !day.data ? (
        <p className="muted">{t("common.loading")}</p>
      ) : (
        <EventList events={events} empty={t("today.nothing")} />
      )}
      {day.data?.warnings.map((w) => (
        <p key={w} className="notice warn small">
          {w}
        </p>
      ))}
    </section>
  );
}

const Note = ({ n }: { n: { at: string; title: string; text: string } }) => (
  <div>
    <div className="row">
      <strong className="small">{noteText(n.title)}</strong>
      <span className="muted small">{dueDate(n.at) ? `${dayName(dueDate(n.at)!)} ${dueTime(n.at) ?? ""}` : n.at}</span>
    </div>
    {n.text && noteText(n.text) && <div className="muted small clip">{noteText(n.text)}</div>}
  </div>
);

// ---------------------------------------------------------------- calendar (like the local dashboard's)

type CalEvent = {
  date: string;
  time: string | null;
  platform: string;
  format: string | null;
  label: string;
  title: string;
  status: string;
  key?: string;
  url?: string;
  account?: string;
  /** The YouTube account's name. */
  account_name?: string;
  posted_at?: string;
};
const STATUS_KEY: Record<string, Key> = {
  "not approved": "status.notApproved",
  "re-approve": "status.reApprove",
  approved: "status.approved",
  posted: "status.posted",
  public: "status.public",
  scheduled: "status.scheduled",
  private: "status.private",
  unlisted: "status.unlisted",
  hold: "status.hold",
};
const statusWord = (s: string) => (STATUS_KEY[s] ? t(STATUS_KEY[s]) : cap(s));
/** Events read from the platform itself (YouTube uploads), not planned here: no item page, nothing to approve. */
const external = (e: CalEvent) => !e.key;
const statusTone = (s: string) =>
  s === "posted" || s === "public" || s === "approved"
    ? "ok"
    : s === "not approved" || s === "re-approve" || s === "hold"
      ? "warn"
      : s === "failed"
        ? "bad"
        : "";
const waitingEvent = (e: CalEvent) => e.status === "not approved" || e.status === "re-approve";

/** A day's events, posted or pending: every row opens its page in the app (an item, or a YouTube video's page); the
 *  icon on a posted/public one opens it on Instagram or YouTube. */
function EventList({ events, empty }: { events: CalEvent[]; empty?: string }) {
  if (!events.length) return <p className="muted">{empty ?? t("calendar.nothingThatDay")}</p>;
  const sorted = [...events].sort((a, b) => (a.time ?? "").localeCompare(b.time ?? "")); // no time known: first
  return (
    <ul className="list">
      {sorted.map((e, k) => {
        const time = e.posted_at
          ? t("calendar.posted", {
              when: `${dueTime(e.posted_at) ?? dayName(e.posted_at.slice(0, 10))}${dueTime(e.posted_at) ? ` ${zoneLabel()}` : ""}`,
            })
          : e.time
            ? `${e.time} ${zoneLabel()}`
            : t("calendar.noTime");
        // YouTube rows are the videos themselves (public / going public), read from YouTube; they need no approval here.
        const yt = external(e);
        const title = yt ? e.title.replace(/^Short · /, "") : nice(e.title);
        const status = { tone: statusTone(e.status) as Tone, word: statusWord(e.status) };
        const href = e.key
          ? `#/item/${encodeURIComponent(e.key)}`
          : yt && e.url
            ? `#/video/${e.account}/${e.url.split("/").pop()}?d=${e.date}`
            : undefined;
        const out = e.url && (e.status === "posted" || e.status === "public") ? e.url : undefined;
        return (
          <Row
            key={k}
            channel={e}
            title={title}
            time={time}
            account={yt ? e.account_name : e.account}
            status={status}
            href={href}
            out={out}
          />
        );
      })}
    </ul>
  );
}

const WEEKDAYS = [
  "calendar.mon",
  "calendar.tue",
  "calendar.wed",
  "calendar.thu",
  "calendar.fri",
  "calendar.sat",
  "calendar.sun",
] as const satisfies readonly Key[];

function CalendarPage() {
  const noAccounts = useNoAccounts();
  const [month, setMonth] = useState(zoneToday().slice(0, 7));
  const [day, setDay] = useState(zoneToday());
  const [refresh, setRefresh] = useState(0);
  const { data, error, stale, at, reload } = useLoad<{ events: CalEvent[]; warnings: string[] }>(
    `calendar?month=${month}${refresh ? "&refresh=1" : ""}`,
    [month, refresh],
  );
  const first = new Date(`${month}-01T00:00:00Z`);
  const lead = (first.getUTCDay() + 6) % 7; // Monday first
  const days = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  const cells: (string | null)[] = [
    ...Array(lead).fill(null),
    ...Array.from({ length: days }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`),
  ];
  while (cells.length % 7) cells.push(null);
  const byDay = new Map<string, CalEvent[]>();
  for (const e of data?.events ?? []) byDay.set(e.date, [...(byDay.get(e.date) ?? []), e]);
  const today = zoneToday();
  const label = first.toLocaleDateString(dateLocale(), { month: "long", year: "numeric", timeZone: "UTC" });
  const list = byDay.get(day) ?? [];
  const long = (d: string) =>
    new Date(`${d}T00:00:00Z`).toLocaleDateString(dateLocale(), {
      weekday: "long",
      day: "numeric",
      month: "long",
      timeZone: "UTC",
    });
  return (
    <section>
      {noAccounts && <SetupNote />}
      <div className="row month-bar">
        <button
          className="icon-btn"
          onClick={() => setMonth(shiftMonth(month, -1))}
          aria-label={t("calendar.prevMonth")}
        >
          {ICON.chevL}
        </button>
        <h2>{label}</h2>
        <button
          className="icon-btn"
          onClick={() => setMonth(shiftMonth(month, 1))}
          aria-label={t("calendar.nextMonth")}
        >
          {ICON.chevR}
        </button>
      </div>
      <div className="legend small" aria-hidden="true">
        {[...new Map((data?.events ?? []).map((e) => [channelKey(e), e])).values()].map((e) => (
          <span key={channelKey(e)}>
            <Dot c={e} />
            {channelLabel(e.format === "video" || external(e) ? e : { platform: e.platform, format: null })}
          </span>
        ))}
        <span>
          <i className="dot ring" aria-hidden="true" />
          {t("status.notApproved")}
        </span>
      </div>
      {stale && <Stale msg={stale} at={at} onRetry={reload} />}
      {error && <ErrorNote msg={error} onRetry={reload} />}
      <div className="cal" role="group" aria-label={t("calendar.pickDay", { month: label })}>
        {WEEKDAYS.map((d) => (
          <div key={d} className="cal-head small muted" aria-hidden="true">
            {t(d)}
          </div>
        ))}
        {cells.map((d, i) => {
          if (d === null) return <div key={i} className="cal-cell empty" aria-hidden="true" />;
          const ev = byDay.get(d) ?? [];
          const waiting = ev.filter(waitingEvent).length;
          const kinds = [...new Map(ev.map((e) => [channelKey(e), e])).values()].map(
            (c) => [c, ev.filter((e) => channelKey(e) === channelKey(c)).length] as const,
          );
          const name = `${long(d)}${d === today ? t("calendar.todaySuffix") : ""}: ${ev.length ? kinds.map(([c, n]) => `${n} ${channelLabel(c)}`).join(", ") : t("calendar.nothing")}${waiting ? t("calendar.cellWaiting", { n: waiting }) : ""}`;
          return (
            <button
              key={d}
              className={`cal-cell${d === today ? " today" : ""}${d === day ? " sel" : ""}`}
              onClick={() => setDay(d)}
              aria-label={name}
              aria-pressed={d === day}
              aria-current={d === today ? "date" : undefined}
            >
              <span className="cal-num">{Number(d.slice(8))}</span>
              <span className="cal-dots">
                {ev.slice(0, 6).map((e, k) => (
                  <i key={k} className={`${dotClass(e)}${waitingEvent(e) ? " ring" : ""}`} />
                ))}
              </span>
            </button>
          );
        })}
      </div>
      <h3>{long(day)}</h3>
      {!data ? <p className="muted">{t("common.loading")}</p> : <EventList events={list} />}
      {data?.warnings.map((w) => (
        <p key={w} className="notice warn small">
          {w}
        </p>
      ))}
      <p className="row">
        <button onClick={() => setRefresh(refresh + 1)}>{t("calendar.checkYoutube")}</button>{" "}
        <span className="muted small">{t("calendar.youtubeHourly")}</span>
      </p>
    </section>
  );
}

// ---------------------------------------------------------------- one item, and approving it

type ItemView = "results" | "post";

function ItemPage({
  keyId,
  view,
  onTitle,
}: {
  keyId: string;
  view?: ItemView;
  onTitle?: (title: string | null) => void;
}) {
  const { refresh, status } = useShared();
  const paused = !!status.data?.paused;
  const {
    data: item,
    error,
    reload,
    stale,
    at,
    fresh,
  } = useLoad<Item>(`item?key=${encodeURIComponent(keyId)}`, [keyId]);
  const [holdMsg, setHoldMsg] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [moved, setMoved] = useState<string | null>(null);
  useEffect(() => {
    if (item) onTitle?.(item.title ?? null);
  }, [item?.title]); // eslint-disable-line react-hooks/exhaustive-deps
  const { approve, busy, done, err, setDone } = useApprove(keyId, item?.fingerprint, () => {
    reload();
    refresh();
  });
  const hold = async (on: boolean) => {
    try {
      await api("item/hold", { key: keyId, hold: on });
      setHoldMsg(on ? t("item.heldMsg") : t("item.releasedMsg"));
      setDone(null);
      reload();
      refresh();
    } catch (e) {
      setHoldMsg((e as Error).message);
    }
  };
  const back = (
    <p className="back-row">
      <a className="back" href={lastList}>
        {ICON.back}
        {lastList.startsWith("#/calendar")
          ? t("tabs.calendar")
          : lastList.startsWith("#/queue")
            ? t("tabs.queue")
            : lastList.startsWith("#/drafts")
              ? t("tabs.drafts")
              : t("tabs.today")}
      </a>
    </p>
  );
  if (error)
    return (
      <>
        {back}
        <ErrorNote msg={error} onRetry={reload} />
      </>
    );
  if (!item)
    return (
      <>
        {back}
        <p className="muted">{t("common.loading")}</p>
      </>
    );
  const ch = itemChannel({ platform: item.platform, format: item.postFormat, label: item.label });
  const alts = item.alt
    ? item.alt
        .split("\n")
        .map((l) => l.replace(/^\s*\d{1,2}\t/, "").trim())
        .filter(Boolean)
    : [];
  // a failed item that may start over takes a new approval even when nothing changed
  const canApprove = !item.posted && !item.hold && (!item.approved || !item.approved.matches || !!item.failed?.again);
  const showBar = (canApprove || !!done) && !editing;
  const slot = dueTime(item.due)
    ? `${dayName(dueDate(item.due)!)} ${dueTime(item.due)} ${zoneLabel()}`
    : t("item.whenScheduled");
  const target = (
    <>
      <Dot c={ch} />
      {channelLabel(ch)} · @{item.account} · <strong>{when(item.due)}</strong>
    </>
  );
  // A published Instagram item opens on its Results (when it has any, unless the link says Post) or on the post.
  const split = !!item.published && item.platform === "instagram";
  const shown: ItemView = split ? (view ?? (item.results || item.trial?.results ? "results" : "post")) : "post";
  const head = (
    <>
      {back}
      <ItemName
        keyId={keyId}
        title={item.title ?? null}
        onSaved={(title) => {
          onTitle?.(title);
          reload();
          refresh();
        }}
      />
      <p className="item-target">
        {target}
        {item.format === "story" ? (
          <>
            {" "}
            <span className="pill">{t("item.story")}</span>
          </>
        ) : null}
        {item.hold ? (
          <>
            {" "}
            <span className="pill warn">{t("status.hold")}</span>
          </>
        ) : null}
      </p>
      {stale && <Stale msg={stale} at={at} onRetry={reload} />}
      {split && (
        <Segmented
          label={t("results.show")}
          value={shown}
          options={[
            { value: "results", text: t("results.results") },
            { value: "post", text: t("results.post") },
          ]}
          // the view is part of the link (a notification opens Results), replaced so Back still leaves the item
          onChange={(v) => location.replace(`#/item/${encodeURIComponent(keyId)}/${v}`)}
        />
      )}
    </>
  );
  if (shown === "results")
    return (
      <section>
        {head}
        <ResultsView keyId={keyId} item={item} />
      </section>
    );
  return (
    <section className={showBar ? "has-action" : ""}>
      {head}
      {item.published && (
        <div className="card published">
          <p className="small">
            <span className="pill ok">{t("item.published")}</span> {when(item.published.at)}
          </p>
          {item.results && <ResultsLine r={item.results} vs={t("results.vsUsual")} />}
          {item.published.permalink && (
            <a className="button-link with-icon" href={item.published.permalink} target="_blank" rel="noopener">
              {ICON.external}
              {t("row.openOn", { where: "Instagram" })}
            </a>
          )}
        </div>
      )}
      {item.trial && item.published && (item.trial.on || item.trial.state !== "planned") && (
        <div className="card published">
          <p className="small">
            <span
              className={`pill${item.trial.state === "published" ? " ok" : ["failed", "refused", "held"].includes(item.trial.state) ? " bad" : ""}`}
            >
              {t("results.trial")}
            </span>{" "}
            {item.trial.state === "published"
              ? t("item.trialShown", { when: item.trial.at ? when(item.trial.at) : t("item.published") })
              : ["failed", "refused", "held"].includes(item.trial.state)
                ? item.trial.error
                  ? t("item.trialNotPostedError", { error: item.trial.error })
                  : t("item.trialNotPosted")
                : t("item.trialPosting")}
          </p>
          {item.trial.results && <ResultsLine r={item.trial.results} vs={t("results.vsRegular")} />}
          {item.trial.permalink && (
            <a className="button-link with-icon" href={item.trial.permalink} target="_blank" rel="noopener">
              {ICON.external}
              {t("item.openTrial")}
            </a>
          )}
        </div>
      )}

      {item.format === "story" ? (
        <p className="muted small">{t("item.storyNote")}</p>
      ) : (
        <>
          <h2>{t("item.caption")}</h2>
          <pre className="text">{item.caption || t("item.missing")}</pre>
          {!item.posted && (item.lint?.length ?? 0) > 0 && (
            <div className="notice warn small">
              <strong>{t("item.captionCheck")}</strong> {t("item.captionCheckNote")}
              <ul>
                {item.lint!.map((c) => (
                  <li key={c.check}>
                    {cap(c.check.toLowerCase())}: {c.detail}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <h2>{t("item.selfComment")}</h2>
          <pre className="text">{item.comment ?? t("item.none")}</pre>
          {item.comment2 && (
            <>
              <h2>{t("item.secondComment")}</h2>
              <pre className="text">{item.comment2}</pre>
            </>
          )}
        </>
      )}
      {alts.length > 0 && (
        <>
          <h2>
            {t("item.altTexts")} <span className="muted small">({alts.length})</span>
          </h2>
          <ol className="small">
            {alts.map((a, k) => (
              <li key={k}>{a}</li>
            ))}
          </ol>
        </>
      )}
      {item.format !== "story" && <TextsOrigin item={item} />}
      {item.format !== "story" &&
        !item.posted &&
        (editing ? (
          <TextsForm
            alt={item.postFormat !== "video" && feature(item.platform, "altText")}
            initial={{
              caption: item.caption,
              comment: item.comment ?? "",
              comment2: item.comment2 ?? "",
              alt: item.alt ?? "",
            }}
            submit={t("item.saveTexts")}
            onSubmit={async (texts) => {
              await api("item/texts", { key: keyId, ...texts });
              setEditing(false);
              reload();
            }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <p className="row">
            <button onClick={() => setEditing(true)}>{t("item.editTexts")}</button>{" "}
            {item.approved ? <span className="muted small">{t("item.editNeedsApproval")}</span> : null}
          </p>
        ))}

      <h2>{item.media.length > 1 ? t("item.mediaCount", { n: item.media.length }) : t("item.media")}</h2>
      <div className={item.media.length > 1 ? "media carousel" : "media"}>
        {item.media.map((m, k) =>
          m.mime.startsWith("video/") ? (
            <video
              key={m.id}
              src={`${m.url}#t=0.1`}
              controls
              playsInline
              preload="metadata"
              aria-label={t("item.videoN", { label: channelLabel(ch), n: k + 1 })}
            />
          ) : (
            <img key={m.id} src={m.url} alt={alts[k] ?? t("item.imageN", { n: k + 1 })} loading="lazy" />
          ),
        )}
        {!item.media.length &&
          (item.posted ? (
            <p className="muted small">{t("item.mediaPosted")}</p>
          ) : (
            <p className="notice warn">{t("item.mediaMissing")}</p>
          ))}
      </div>

      {item.failed && !item.posted && !done && (
        <p className="notice bad" role="status">
          {item.failed.error ? t("item.failedWith", { error: item.failed.error }) : t("item.failed")}{" "}
          {item.failed.again
            ? t("item.failedAgain")
            : t("item.failedMayBeLive", { platform: platformName(item.platform) })}
        </p>
      )}
      {item.approved && !item.failed && !done && (
        <p className={`notice ${item.approved.matches ? "ok" : "warn"}`}>
          {item.approved.matches
            ? t("item.approvedAt", { when: utcToZone(item.approved.at) })
            : item.approved.commentsOnly
              ? t("item.commentsChanged")
              : t("item.changed")}
        </p>
      )}
      {!item.posted && item.problems.length > 0 && (
        <div className="notice bad" role="alert">
          <strong>{t("item.fixFirst")}</strong>
          <ul>
            {item.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}

      {!item.posted && (item.approved || item.hold) && (
        <div className="card" id="hold">
          <h2>{item.hold ? t("status.hold") : t("item.stopOne")}</h2>
          {item.hold ? (
            <>
              <p className="small muted">
                {t("item.heldNote")}
                {item.approved?.matches ? ` ${t("item.heldKept")}` : ""}
              </p>
              <ConfirmButton
                tone="go"
                label={t("item.release")}
                confirm={t("item.releaseConfirm")}
                detail={item.approved?.matches ? t("item.goesOut", { when: when(item.due) }) : t("item.stillNeeds")}
                onConfirm={() => hold(false)}
              />
            </>
          ) : (
            <>
              <p className="small muted">{t("item.holdNote")}</p>
              <ConfirmButton
                label={t("item.hold")}
                confirm={t("item.holdConfirm")}
                detail={t("item.holdDetail")}
                onConfirm={() => hold(true)}
              />
            </>
          )}
          {holdMsg && (
            <p className="notice small" role="status">
              {holdMsg}
            </p>
          )}
        </div>
      )}
      {!item.posted && (
        <Reschedule
          item={item}
          onDone={(note) => {
            setDone(null);
            setHoldMsg(null);
            setMoved(note);
            reload();
            refresh();
          }}
        />
      )}
      {!item.posted &&
        feature(item.platform, "coverFrame") &&
        item.media.length === 1 &&
        item.media[0].mime.startsWith("video/") &&
        item.format !== "story" && (
          <CoverFrame keyId={keyId} url={item.media[0].url} ms={item.coverMs ?? null} onSaved={reload} />
        )}
      {!item.posted && feature(item.platform, "location") && item.format !== "story" && (
        <LocationCard keyId={keyId} location={item.location ?? null} onSaved={reload} />
      )}
      {!item.posted && feature(item.platform, "trial") && item.trial && (
        <TrialCard keyId={keyId} account={item.account} trial={item.trial} onSaved={reload} />
      )}
      {moved && (
        <p className="notice ok small" role="status">
          {moved}
        </p>
      )}
      <details className="key-details">
        <summary className="small muted tap">{t("item.key")}</summary>
        <code>{keyId}</code>
      </details>

      {showBar && done && (
        <div className="action-bar done" role="status">
          <div className="confirm-line">
            <span className="check">{ICON.check}</span>
            <div>
              <strong>{t("item.approvedDone")}</strong>{" "}
              {paused
                ? t("item.goesOutResumed", { when: when(done) })
                : t("item.goesOutOn", { when: when(done), account: item.account })}
            </div>
          </div>
          <div className="row">
            <button onClick={() => setDone(null)}>{t("common.done")}</button>
            <button
              onClick={() => document.getElementById("hold")?.scrollIntoView({ behavior: "smooth", block: "center" })}
            >
              {t("item.holdInstead")}
            </button>
          </div>
        </div>
      )}
      {showBar && !done && (
        <div className="action-bar">
          {err && (
            <p className="notice bad small" role="alert">
              {err}
            </p>
          )}
          {paused && (
            <p className="notice warn small" role="status">
              {t("item.pausedNote")}
            </p>
          )}
          <p className="small">{target}</p>
          <button className="primary" disabled={busy || !fresh || item.problems.length > 0} onClick={approve}>
            {busy
              ? t("common.waitingPasskey")
              : !fresh
                ? t("item.checking")
                : item.problems.length
                  ? t("item.fixN", { n: item.problems.length })
                  : item.approved?.commentsOnly
                    ? t("item.approveComments")
                    : paused
                      ? t("item.approvePaused")
                      : t("item.approve", { slot })}
          </button>
        </div>
      )}
      {!showBar && err && (
        <p className="notice bad" role="alert">
          {err}
        </p>
      )}
    </section>
  );
}

/** The item's display name: what the app, the calendar and the daily summary show. Its file name and key (which the
 *  approval and history point at) don't change; clearing it goes back to the readable file name. */
function ItemName({
  keyId,
  title,
  onSaved,
}: {
  keyId: string;
  title: string | null;
  onSaved: (title: string | null) => void;
}) {
  const auto = keyTitle(keyId);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(title ?? auto);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const save = async (next: string | null) => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ title: string | null }>("item/title", {
        key: keyId,
        title: next && next.trim() !== auto ? next : null,
      });
      setEditing(false);
      onSaved(r.title);
    } catch (e) {
      setErr(e instanceof HttpError ? friendly(e) : (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (!editing)
    return (
      <div className="item-name">
        <h2 className="clip">{title ?? auto}</h2>
        <button
          className="icon-btn"
          onClick={() => {
            setValue(title ?? auto);
            setEditing(true);
          }}
          aria-label={t("name.rename")}
          title={t("name.rename")}
        >
          {ICON.pencil}
        </button>
      </div>
    );
  return (
    <div className="card form">
      <label>
        {t("name.name")}
        <input
          value={value}
          maxLength={80}
          autoFocus
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") save(value);
            if (e.key === "Escape") setEditing(false);
          }}
        />
      </label>
      <p className="muted small">{t("name.note", { file: keyId.split("/").pop() ?? keyId })}</p>
      {err && (
        <p className="notice bad small" role="alert">
          {err}
        </p>
      )}
      <div className="row actions">
        {title && (
          <button onClick={() => save(null)} disabled={busy}>
            {t("name.useFile")}
          </button>
        )}
        <button onClick={() => setEditing(false)} disabled={busy}>
          {t("common.cancel")}
        </button>
        <button className="primary inline" onClick={() => save(value)} disabled={busy || !value.trim()}>
          {busy ? t("common.saving") : t("name.save")}
        </button>
      </div>
    </div>
  );
}

/** A video's cover frame: play or scrub to the frame, then "Use this frame" (Instagram's thumb_offset). */
function CoverFrame({
  keyId,
  url,
  ms,
  onSaved,
}: {
  keyId: string;
  url: string;
  ms: number | null;
  onSaved: () => void;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const save = async (to: number | null) => {
    try {
      await api("item/cover", { key: keyId, ms: to });
      setMsg(to === null ? t("cover.reset") : t("cover.set", { s: (to / 1000).toFixed(1) }));
      onSaved();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  return (
    <div className="card">
      <h2>{t("cover.title")}</h2>
      <p className="small">
        {ms === null ? (
          t("cover.default")
        ) : (
          <>
            {t("cover.frameAt")} <strong>{t("cover.seconds", { s: (ms / 1000).toFixed(1) })}</strong>.
          </>
        )}
      </p>
      <div className="media">
        <video
          ref={ref}
          src={`${url}#t=${((ms ?? 500) / 1000).toFixed(1)}`}
          controls
          playsInline
          preload="metadata"
          aria-label={t("cover.video")}
        />
      </div>
      <div className="row actions">
        {ms !== null && <button onClick={() => save(null)}>{t("common.useDefault")}</button>}
        <button className="primary inline" onClick={() => save(Math.round((ref.current?.currentTime ?? 0.5) * 1000))}>
          {t("cover.use")}
        </button>
      </div>
      {msg && (
        <p className="notice small" role="status">
          {msg}
        </p>
      )}
    </div>
  );
}

/** The location tag: paste an Instagram location link (or the place's number). The API can't search places
 *  by name; find the place on Instagram, open it and copy its link. Not part of the approval. */
function LocationCard({ keyId, location, onSaved }: { keyId: string; location: string | null; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const save = async (v: string) => {
    setErr(null);
    try {
      await api("item/location", { key: keyId, location: v });
      setOpen(false);
      setValue("");
      onSaved();
    } catch (e) {
      setErr(e instanceof HttpError ? friendly(e) : (e as Error).message);
    }
  };
  return (
    <div className="card form">
      <h2>{t("location.title")}</h2>
      <p className="small">
        {location ? (
          <>
            {t("location.tagged")}{" "}
            <a
              className="link"
              href={`https://www.instagram.com/explore/locations/${location}/`}
              target="_blank"
              rel="noopener"
            >
              {t("location.place", { id: location })}
            </a>
          </>
        ) : (
          t("location.none")
        )}
      </p>
      {open ? (
        <>
          <label>
            {t("location.label")}
            <input
              value={value}
              autoFocus
              placeholder="https://www.instagram.com/explore/locations/…"
              onChange={(e) => setValue(e.target.value)}
            />
          </label>
          <p className="muted small">{t("location.help")}</p>
          {err && (
            <p className="notice bad small" role="alert">
              {err}
            </p>
          )}
          <div className="row actions">
            <button
              onClick={() => {
                setOpen(false);
                setErr(null);
              }}
            >
              {t("common.cancel")}
            </button>
            <button className="primary inline" onClick={() => save(value)} disabled={!value.trim()}>
              {t("location.save")}
            </button>
          </div>
        </>
      ) : (
        <div className="row actions">
          {location && <button onClick={() => save("")}>{t("common.remove")}</button>}
          <button onClick={() => setOpen(true)}>{location ? t("common.change") : t("location.add")}</button>
        </div>
      )}
    </div>
  );
}

/** An on/off switch (a button with role="switch"), label beside it. */
function Switch({
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

/** This Reel's Trial Reel switch: its own choice, or the account's default (set on the account's page). */
function TrialCard({
  keyId,
  account,
  trial,
  onSaved,
}: {
  keyId: string;
  account: string;
  trial: NonNullable<Item["trial"]>;
  onSaved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const save = async (on: boolean | null) => {
    setBusy(true);
    setErr(null);
    try {
      await api("item/trial", { key: keyId, on });
      onSaved();
    } catch (e) {
      setErr(e instanceof HttpError ? friendly(e) : (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card form">
      <h2>{t("results.trial")}</h2>
      <Switch on={trial.on} disabled={busy} onChange={(on) => save(on)} label={t("trial.also")} />
      <p className="muted small">{t("trial.note")}</p>
      <p className="muted small">
        {trial.explicit ? (
          <>
            {t("trial.set")}{" "}
            <a className="link" href={`#/stats/instagram/${encodeURIComponent(account)}`}>
              @{account}
            </a>
            {t("trial.defaultIs", { state: trial.byDefault ? t("trial.on") : t("trial.off") })}{" "}
            <button className="link-button" disabled={busy} onClick={() => save(null)}>
              {t("common.useDefault")}
            </button>
          </>
        ) : (
          <>
            {t("trial.following")}{" "}
            <a className="link" href={`#/stats/instagram/${encodeURIComponent(account)}`}>
              @{account}
            </a>
            {t("trial.followingEnd")}
          </>
        )}
      </p>
      {err && (
        <p className="notice bad small" role="alert">
          {err}
        </p>
      )}
    </div>
  );
}

/** Change when an item goes out: date and time (the workspace's zone). One item per account per hour; an approved item then needs
 *  approving again for the new time (the server says so, and the approve bar comes back). */
function Reschedule({ item, onDone }: { item: Item; onDone: (note: string) => void }) {
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(dueDate(item.due) ?? zoneShift(1));
  const [time, setTime] = useState(dueTime(item.due) ?? (item.postFormat === "video" ? "18:00" : "19:00"));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [slots, setSlots] = useState<Slot[]>([]);
  const save = async (to?: Slot) => {
    setBusy(true);
    setErr(null);
    setSlots([]);
    try {
      const r = await api<{ due: string; approved: boolean; note?: string }>("item/reschedule", {
        key: item.key,
        date: to?.date ?? date,
        time: to?.time ?? time,
      });
      setOpen(false);
      onDone(`${t("reschedule.moved", { when: when(r.due) })}${r.note ? ` ${t("reschedule.reapprove")}` : ""}`);
    } catch (e) {
      setErr(e instanceof HttpError ? friendly(e) : (e as Error).message);
      setSlots(slotsOf(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card form">
      <h2>{t("reschedule.title")}</h2>
      <p className="small">
        {item.due ? (
          <>
            {t("reschedule.goesOut")} <strong>{when(item.due)}</strong>.
          </>
        ) : (
          t("reschedule.notYet")
        )}
      </p>
      {open ? (
        <>
          <div className="row">
            <label>
              {t("common.dateIn", { zone: zoneLabel() })}
              <input type="date" value={date} min={zoneShift(0)} onChange={(e) => setDate(e.target.value)} />
            </label>
            <label>
              {t("common.time")}
              <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
            </label>
          </div>
          {item.approved && <p className="muted small">{t("reschedule.needsApproval")}</p>}
          {err && (
            <p className="notice bad small" role="alert">
              {err}
            </p>
          )}
          <FreeSlots
            slots={slots}
            onPick={(s) => {
              setDate(s.date);
              setTime(s.time);
              save(s);
            }}
          />
          <div className="row actions">
            <button
              onClick={() => {
                setOpen(false);
                setErr(null);
                setSlots([]);
              }}
              disabled={busy}
            >
              {t("common.cancel")}
            </button>
            <button className="primary inline" onClick={() => save()} disabled={busy || !date || !time}>
              {busy ? t("common.saving") : t("common.saveNewDate")}
            </button>
          </div>
        </>
      ) : (
        <button onClick={() => setOpen(true)}>{t("common.changeDate")}</button>
      )}
    </div>
  );
}

/** A YouTube video from the calendar (public or going public): its page in the app, with a button to open it on
 *  YouTube. Read from the month's calendar (YouTube uploads, cached by the server for an hour). */
/** Where the texts shown (the scheduler's copy, what it posts) came from: a repo item's files, copied by an importer, or an
 *  edit here or by an agent. */
function TextsOrigin({ item }: { item: Item }) {
  const texts = item.texts;
  if (!texts || (item.content === "db" && (!texts.by || texts.by === "owner@app"))) return null; // a draft's texts: written here
  const at = texts.at ? utcToZone(new Date(texts.at * 1000).toISOString()) : null;
  if (texts.by === "repo") return <p className="muted small">{at ? t("texts.copiedAt", { at }) : t("texts.copied")}</p>;
  if (!texts.by)
    return (
      <p className="muted small">
        {t("texts.notCopied")} <code>bongsu texts set</code>.
      </p>
    );
  const who = texts.by === "owner@app" ? t("texts.byHere") : t("texts.byAgent", { id: texts.by.replace(/^key:/, "") });
  return (
    <p className="muted small">
      {t("texts.edited", { who })}
      {at ? t("texts.on", { at }) : ""}
      {texts.files ? (
        <>
          {t("texts.filesOlder")}
          <code>bongsu texts set</code>
          {t("texts.filesOlderEnd")}
        </>
      ) : null}
      .
    </p>
  );
}

/** One 24 h results line: views (against `vs`), likes, comments, saves, shares, reach. */
function ResultsLine({ r, vs, label }: { r: Results; vs: string; label?: string }) {
  return (
    <p className="small num results-line">
      <strong>{label ?? t("results.line24h")}</strong> {t("results.lineViews", { n: r.views ?? "–" })}
      {r.median_views && r.views != null ? (
        <span className={r.views >= r.median_views ? " ok-text" : " muted"}>
          {" "}
          ({(r.views / r.median_views).toFixed(1)}× {vs})
        </span>
      ) : null}{" "}
      ·{" "}
      {t("results.lineRest", {
        likes: r.likes ?? 0,
        comments: r.comments ?? 0,
        saves: r.saves ?? 0,
        shares: r.shares ?? 0,
        reach: r.reach ?? "–",
      })}
      {r.follows != null && ` · +${r.follows} ${t("results.followersWord")}`}
      {r.profile_visits != null && ` · ${r.profile_visits} ${t("results.visitsWord")}`}
    </p>
  );
}

// ---------------------------------------------------------------- results

/** A two-way (or more) choice in the Queue's segmented style; `grid` lays six choices out three to a row. */
function Segmented<T extends string>({
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

type Metric = Exclude<keyof MetricPoint, "at">;
const IG_METRICS: Metric[] = ["views", "reach", "likes", "comments", "saves", "shares", "follows", "profile_visits"];
const YT_METRICS: Metric[] = ["views", "likes", "comments"];
// with the analytics scope a video also has the subscribers it gained (its "follows")
const YT_METRICS_SUBS: Metric[] = [...YT_METRICS, "follows"];

type Loaded = { data: Metrics; at: number };
const hasSamples = (d?: Metrics | null) => !!d && (d.samples.length > 0 || (d.trial?.samples.length ?? 0) > 0);

/** A metrics series (`base`: the route with its key) in Total or Daily, on the same day's cache as useLoad: a path
 *  opens on its cached answer, a failed refresh keeps it and says so (`stale`). Each path keeps one answer object
 *  until the data really changes, so the chart's series (memoised on it) don't start over on an identical refresh. */
function useMetrics(base: string | null) {
  const [mode, setMode] = useState<"total" | "daily">("total");
  const [metric, setMetric] = useState<Metric>("views");
  const [got, setGot] = useState<Record<string, Loaded>>({});
  const [failed, setFailed] = useState<Record<string, string>>({});
  const path = base && `${base}${mode === "daily" ? "&daily=1" : ""}`;
  const fromCache = (p: string | null): Loaded | undefined => {
    const hit = p ? cacheGet<Metrics>(p) : null;
    return hit ? { data: hit.data, at: hit.at } : undefined;
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: fromCache only reads storage
  const cached = useMemo(() => fromCache(path), [path]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: fromCache only reads storage
  const cachedTotal = useMemo(() => fromCache(base), [base]);
  const reload = useCallback(() => {
    if (!path) return;
    setFailed(({ [path]: _, ...rest }) => rest);
    api<Metrics>(path)
      .then((d) => {
        cachePut(path, d);
        setGot((g) => {
          const was = g[path]?.data ?? cached?.data;
          return { ...g, [path]: { data: was && JSON.stringify(was) === JSON.stringify(d) ? was : d, at: Date.now() } };
        });
      })
      .catch((e: Error) => setFailed((f) => ({ ...f, [path]: friendly(e) })));
  }, [path, cached]);
  useEffect(reload, [reload]);
  const entry = path ? (got[path] ?? cached) : undefined;
  const failure = path ? failed[path] : undefined;
  return {
    mode,
    setMode,
    metric,
    setMetric,
    data: entry?.data ?? null,
    at: entry?.at ?? null,
    error: entry ? null : (failure ?? null),
    stale: entry && failure ? failure : null,
    reload,
    any: hasSamples((base ? (got[base] ?? cachedTotal) : undefined)?.data),
  };
}

/** The chart of a metrics series with its Total | Daily switch and metric picker; the Trial Reel copy is series 2. */
function MetricsPanel({
  m,
  metrics,
  trialPosted = false,
  names = {},
}: {
  m: ReturnType<typeof useMetrics>;
  metrics: Metric[];
  trialPosted?: boolean;
  /** A metric's name where the platform's word differs (a video's "follows" are subscribers). */
  names?: Partial<Record<Metric, string>>;
}) {
  const { data, metric, mode } = m;
  const series = useMemo((): ChartSeries[] => {
    if (!data) return [];
    const points = (rows: MetricPoint[]) => rows.map((r) => ({ at: r.at, value: r[metric] }));
    const trial = data.trial?.samples ?? [];
    const own = data.samples.length
      ? [
          {
            label: trial.length ? data.item.label : (names[metric] ?? t(`results.${metric}`)),
            hue: 1 as const,
            points: points(data.samples),
          },
        ]
      : [];
    return trial.length ? [...own, { label: t("results.trial"), hue: 2 as const, points: points(trial) }] : own;
  }, [data, metric]);
  // In Total, an answer without samples (or none at all) is the whole panel; Daily keeps its switch to go back.
  if (mode === "total" && m.error) return <ErrorNote msg={m.error} onRetry={m.reload} />;
  if (mode === "total" && !data) return <p className="muted">{t("common.loading")}</p>;
  const stale = m.stale && <Stale msg={m.stale} at={m.at} onRetry={m.reload} />;
  if (mode === "total" && !series.length)
    return (
      <>
        {stale}
        <p className="muted">{t("results.empty")}</p>
      </>
    );
  return (
    <div className="card">
      {stale}
      <Segmented
        label={t("results.range")}
        value={mode}
        options={[
          { value: "total", text: t("results.total") },
          { value: "daily", text: t("results.daily") },
        ]}
        onChange={m.setMode}
      />
      <Segmented
        label={t("results.metric")}
        value={metric}
        options={metrics.map((x) => ({ value: x, text: names[x] ?? t(`results.${x}`) }))}
        onChange={m.setMetric}
        grid={metrics.length > 3}
      />
      {m.error ? (
        <ErrorNote msg={m.error} onRetry={m.reload} />
      ) : !data ? (
        <p className="muted">{t("common.loading")}</p>
      ) : series.length ? (
        <LineChart series={series} mode={mode} tz={ZONE} />
      ) : (
        <p className="muted">{t("results.empty")}</p>
      )}
      {trialPosted && data && !data.trial?.samples.length && <p className="muted small">{t("results.trialEmpty")}</p>}
    </div>
  );
}

const takenAt = (s: number) =>
  `${new Intl.DateTimeFormat(dateLocale(), {
    timeZone: ZONE,
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(s * 1000)} ${zoneLabel()}`;

/** A published Instagram item's Results: the 24 h numbers (the Trial Reel copy's too), then the series' chart. */
function ResultsView({ keyId, item }: { keyId: string; item: Item }) {
  const m = useMetrics(`item/metrics?key=${encodeURIComponent(keyId)}`);
  const r = item.results;
  const tr = item.trial?.results;
  return (
    <>
      {(r || tr) && (
        <div className="card published">
          {r && <ResultsLine r={r} vs={t("results.vsUsual")} />}
          {tr && <ResultsLine r={tr} vs={t("results.vsRegular")} label={t("results.trialNumbers")} />}
          <p className="muted small">{t("results.taken", { when: takenAt((r ?? tr)!.fetched_at) })}</p>
        </div>
      )}
      <MetricsPanel m={m} metrics={IG_METRICS} trialPosted={item.trial?.state === "published"} />
    </>
  );
}

/** Approving one item (a post, or a Short's comment) with a passkey: the server binds the challenge to what the page
 *  showed (`fingerprint`) and refuses if it changed since. */
function useApprove(keyId: string, fingerprint: string | undefined, after: () => void) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const approve = async () => {
    setBusy(true);
    setErr(null);
    try {
      const o = await api<{ options: never; challengeId: string }>("approve/options", { key: keyId, fingerprint });
      const response = await startAuthentication({ optionsJSON: o.options });
      const r = await api<{ due: string | null }>("approve/verify", { challengeId: o.challengeId, response });
      setDone(r.due ?? "approved");
      after();
    } catch (e) {
      const extra =
        e instanceof HttpError && Array.isArray(e.body.problems) ? ` ${(e.body.problems as string[]).join("; ")}` : "";
      const m = (e as Error).message;
      if (e instanceof HttpError && e.body.changed) after(); // show the new version; approving it needs another tap
      setErr(
        e instanceof HttpError
          ? friendly(e) + extra
          : /NotAllowed|cancel/i.test(`${(e as Error).name} ${m}`)
            ? t("approve.cancelled")
            : `${m}${extra}`,
      );
    } finally {
      setBusy(false);
    }
  };
  return { approve, busy, done, err, setDone };
}

/** The comment the scheduler posts on a Short once the video is public: its text and approval, approved here. */
function ShortComment({ video }: { video: string }) {
  const keyId = `comment:${video}`;
  const { data: c, error, reload, fresh } = useLoad<Item>(`item?key=${encodeURIComponent(keyId)}`, [video]);
  const { approve, busy, done, err } = useApprove(keyId, c?.fingerprint, reload);
  if (error && /isn't in the plan/.test(error)) return null; // no comment listed for this Short
  if (error) return <ErrorNote msg={error} onRetry={reload} />;
  if (!c) return null;
  const state = c.posted
    ? { tone: "ok", word: t("comment.commented") }
    : c.approved?.matches
      ? { tone: "ok", word: t("status.approved") }
      : c.approved
        ? { tone: "warn", word: t("comment.changed") }
        : { tone: "warn", word: t("comment.waiting") };
  return (
    <>
      <h2>{t("comment.title")}</h2>
      <p>
        <span className={`pill ${state.tone}`}>{state.word}</span>
      </p>
      <pre className="text">{c.caption || t("item.missing")}</pre>
      {c.problems.map((p) => (
        <p key={p} className="notice warn small">
          {p}
        </p>
      ))}
      {!c.posted && !c.approved?.matches && !done && (
        <div className="action-bar">
          {err && (
            <p className="notice bad small" role="alert">
              {err}
            </p>
          )}
          <p className="small">{t("comment.goesOutAs", { account: c.account })}</p>
          <button className="primary" disabled={busy || !fresh || c.problems.length > 0} onClick={approve}>
            {busy ? t("common.waitingPasskey") : c.problems.length ? t("comment.fixFirst") : t("comment.approve")}
          </button>
        </div>
      )}
      {done && <p className="notice ok small">{t("comment.approved")}</p>}
    </>
  );
}

/** Move when a scheduled YouTube video goes public. Like approving, it needs a fresh passkey: the server binds the
 *  challenge to this video and time, then changes the release date on YouTube itself. */
function ReleaseDate({
  video,
  event,
  onDone,
}: {
  video: string;
  event: CalEvent;
  onDone: (note: string, due: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(event.date);
  const [time, setTime] = useState(event.time ?? "18:00");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      const o = await api<{ options: never; challengeId: string }>("youtube/release/options", { video, date, time });
      const response = await startAuthentication({ optionsJSON: o.options });
      const r = await api<{ due: string }>("youtube/release/verify", { challengeId: o.challengeId, response });
      setOpen(false);
      onDone(t("reschedule.moved", { when: when(r.due) }), r.due);
    } catch (e) {
      const m = (e as Error).message;
      setErr(
        e instanceof HttpError
          ? friendly(e)
          : /NotAllowed|cancel/i.test(`${(e as Error).name} ${m}`)
            ? t("release.cancelled")
            : m,
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card form">
      <h2>{t("reschedule.title")}</h2>
      <p className="small">
        {t("status.scheduled")}{" "}
        <strong>{event.time ? when(`${event.date} ${event.time}`) : dayName(event.date)}</strong>.
      </p>
      {open ? (
        <>
          <div className="row">
            <label>
              {t("common.dateIn", { zone: zoneLabel() })}
              <input type="date" value={date} min={zoneShift(0)} onChange={(e) => setDate(e.target.value)} />
            </label>
            <label>
              {t("common.time")}
              <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
            </label>
          </div>
          {err && (
            <p className="notice bad small" role="alert">
              {err}
            </p>
          )}
          <div className="row actions">
            <button
              onClick={() => {
                setOpen(false);
                setErr(null);
              }}
              disabled={busy}
            >
              {t("common.cancel")}
            </button>
            <button className="primary inline" onClick={save} disabled={busy || !date || !time}>
              {busy ? t("common.saving") : t("common.saveNewDate")}
            </button>
          </div>
        </>
      ) : (
        <button onClick={() => setOpen(true)}>{t("common.changeDate")}</button>
      )}
    </div>
  );
}

function VideoPage({ route }: { route: string }) {
  const m = /^\/video\/([^/]+)\/([^?]+)\?d=(\d{4}-\d{2}-\d{2})/.exec(route);
  const month = m?.[3].slice(0, 7) ?? zoneToday().slice(0, 7);
  const { data, error, reload } = useLoad<{ events: CalEvent[] }>(`calendar?month=${month}`, [month]);
  const [moved, setMoved] = useState<string | null>(null);
  const canReschedule = useCan("reschedule"); // the server refuses other roles anyway; the card is for who can use it
  const e = m && data?.events.find((x) => external(x) && x.account === m[1] && x.url?.endsWith(`/${m[2]}`));
  // its metrics series, once the calendar knows the video: Results | Video when it has samples
  const metrics = useMetrics(e && m ? `video/metrics?video=${encodeURIComponent(m[2])}` : null);
  // Results first when the series is at hand as the page opens (cached), as an item opens on its Results; when it
  // arrives after the video's details showed, the split appears with Video kept, so nothing moves under the thumb.
  const [picked, setPicked] = useState<"results" | "video" | null>(null);
  const detailsShown = useRef(false);
  if (e && !metrics.any) detailsShown.current = true;
  const view = picked ?? (detailsShown.current ? "video" : "results");
  const back = (
    <p className="back-row">
      <a className="back" href={lastList}>
        {ICON.back}
        {lastList.startsWith("#/calendar") ? t("tabs.calendar") : t("tabs.today")}
      </a>
    </p>
  );
  if (!m)
    return (
      <>
        {back}
        <p className="muted">{t("video.unknown")}</p>
      </>
    );
  const [, account, id] = m;
  if (error)
    return (
      <>
        {back}
        <ErrorNote msg={error} onRetry={reload} />
      </>
    );
  if (!data)
    return (
      <>
        {back}
        <p className="muted">{t("common.loading")}</p>
      </>
    );
  if (!e)
    return (
      <>
        {back}
        {moved && (
          <p className="notice ok small" role="status">
            {moved}
          </p>
        )}
        <p className="muted">{t("video.gone", { month })}</p>
        <a className="button-link with-icon" href={`https://youtu.be/${id}`} target="_blank" rel="noopener">
          {ICON.external}
          {t("common.openOnYoutube")}
        </a>
      </>
    );
  return (
    <section>
      {back}
      <p className="item-target">
        <Dot c={e} />
        {platformName(e.platform)}
        {e.account_name ? ` ${e.account_name}` : ""} · {e.label} ·{" "}
        <strong>
          {dayName(e.date)}
          {e.time ? ` · ${e.time} ${zoneLabel()}` : ""}
        </strong>
      </p>
      <h2>{e.title.replace(/^Short · /, "")}</h2>
      {metrics.any && (
        <Segmented
          label={t("results.show")}
          value={view}
          options={[
            { value: "results", text: t("results.results") },
            { value: "video", text: t("results.video") },
          ]}
          onChange={setPicked}
        />
      )}
      {metrics.any && view === "results" ? (
        <>
          <MetricsPanel
            m={metrics}
            metrics={metrics.data?.analytics ? YT_METRICS_SUBS : YT_METRICS}
            names={{ follows: t("results.subscribers") }}
          />
          {metrics.data?.analytics === false && <p className="muted small">{t("results.analyticsMissing")}</p>}
        </>
      ) : (
        <>
          <p>
            <span className={`pill ${statusTone(e.status)}`}>{statusWord(e.status)}</span>
          </p>
          <p className="muted small">{t("video.note")}</p>
          {moved && (
            <p className="notice ok small" role="status">
              {moved}
            </p>
          )}
          {e.status === "scheduled" && canReschedule && (
            <ReleaseDate
              video={id}
              event={e}
              onDone={(note, due) => {
                // a move into another month: the page's own month no longer has the event, so follow it
                setMoved(note);
                const to = `/video/${account}/${id}?d=${due.slice(0, 10)}`;
                if (to === route) reload();
                else location.hash = `#${to}`;
              }}
            />
          )}
          <a className="button-link with-icon" href={`https://youtu.be/${id}`} target="_blank" rel="noopener">
            {ICON.external}
            {t("common.openOnYoutube")}
          </a>
          <ShortComment video={id} />
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- comments

type CommentRow = {
  id: string;
  platform: "ig" | "yt";
  account: string;
  media_id: string;
  item_key: string | null;
  author: string;
  text: string;
  at: number;
  seen: number;
  reply_text: string | null;
  replied_at: number | null;
  title: string | null;
  name: string | null;
  permalink: string | null;
};

/** Others' comments on recent posts and Shorts, per post, newest first; reply in place. Opening it marks them seen. */
function CommentsPage() {
  const { unseen } = useShared();
  const { data, error, reload } = useLoad<{ comments: CommentRow[] }>("comments");
  const [open, setOpen] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Marked seen once the list has loaded, so what was new still shows highlighted this time.
  const loaded = !!data;
  useEffect(() => {
    if (loaded)
      api("comments/seen", {})
        .then(() => unseen.reload())
        .catch(() => {});
  }, [loaded]); // eslint-disable-line react-hooks/exhaustive-deps
  const send = async (id: string) => {
    setBusy(true);
    setErr(null);
    try {
      await api(`comments/${encodeURIComponent(id)}/reply`, { text });
      setOpen(null);
      setText("");
      reload();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (error) return <ErrorNote msg={error} onRetry={reload} />;
  if (!data) return <p className="muted">{t("common.loading")}</p>;
  if (!data.comments.length) return <p className="muted">{t("comments.none")}</p>;
  const groups = new Map<string, CommentRow[]>();
  for (const c of data.comments) groups.set(c.media_id, [...(groups.get(c.media_id) ?? []), c]);
  return (
    <section>
      {[...groups.values()].map((cs) => {
        const c0 = cs[0];
        const yt = c0.platform === "yt";
        const title = c0.title || (c0.name ? nice(c0.name) : yt ? t("comments.ytShort") : t("comments.igPost"));
        const href = c0.item_key && !yt ? `#/item/${encodeURIComponent(c0.item_key)}` : null;
        const out = yt ? `https://youtu.be/${c0.media_id}` : c0.permalink;
        return (
          <div key={c0.media_id} className="comment-group">
            <h2 className="row">
              <span className="clip">
                {href ? (
                  <a href={href} className="link">
                    {title}
                  </a>
                ) : (
                  title
                )}
              </span>
              {out && (
                <a
                  className="icon-btn out-inline"
                  href={out}
                  target="_blank"
                  rel="noopener"
                  aria-label={t("row.openOn", { where: yt ? "YouTube" : "Instagram" })}
                >
                  {yt ? ICON.youtube : ICON.instagram}
                </a>
              )}
            </h2>
            <p className="muted small">{yt ? `YouTube · ${c0.account}` : `Instagram · @${c0.account}`}</p>
            <ul className="list">
              {cs.map((c) => (
                <li key={c.id} className={c.seen ? undefined : "tone-warn"}>
                  <div>
                    <div className="row">
                      <strong className="small clip">{yt ? c.author : `@${c.author}`}</strong>
                      <span className="muted small">{utcToZone(new Date(c.at * 1000).toISOString())}</span>
                    </div>
                    <p className="comment-text">{c.text}</p>
                    {c.reply_text && <p className="small muted">{t("comments.replied", { text: c.reply_text })}</p>}
                    {open === c.id ? (
                      <div className="form">
                        <label className="vh" htmlFor={`r-${c.id}`}>
                          {t("comments.reply")}
                        </label>
                        <textarea
                          id={`r-${c.id}`}
                          rows={2}
                          value={text}
                          autoFocus
                          onChange={(e) => setText(e.target.value)}
                          placeholder={t("comments.replyTo", { author: yt ? c.author : `@${c.author}` })}
                        />
                        {err && (
                          <p className="notice bad small" role="alert">
                            {err}
                          </p>
                        )}
                        <div className="row actions">
                          <button
                            onClick={() => {
                              setOpen(null);
                              setErr(null);
                            }}
                            disabled={busy}
                          >
                            {t("common.cancel")}
                          </button>
                          <button className="primary inline" onClick={() => send(c.id)} disabled={busy || !text.trim()}>
                            {busy ? t("comments.sending") : t("comments.send")}
                          </button>
                        </div>
                      </div>
                    ) : (
                      !c.reply_text && (
                        <button
                          onClick={() => {
                            setOpen(c.id);
                            setText("");
                            setErr(null);
                          }}
                        >
                          {t("comments.reply")}
                        </button>
                      )
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </section>
  );
}

// ---------------------------------------------------------------- drafts and settings

type Texts = { caption: string; comment: string; comment2: string; alt: string };

/** Caption / self-comment / alt texts (posts only), as they'll be published. */
function TextsForm({
  alt,
  initial,
  submit,
  onSubmit,
  onCancel,
  children,
  noTexts = false,
}: {
  /** Show the alt texts field (images on a platform that takes alt texts). */
  alt: boolean;
  initial: Texts;
  submit: string;
  onSubmit: (texts: Texts) => Promise<void>;
  onCancel: () => void;
  children?: ReactNode;
  noTexts?: boolean;
}) {
  const [texts, setTexts] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    setBusy(true);
    setErr(null);
    try {
      await onSubmit(texts);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card form">
      {children}
      {noTexts ? (
        <p className="muted small">{t("texts.storyNone")}</p>
      ) : (
        <>
          <label>
            {t("item.caption")}
            <textarea
              rows={6}
              value={texts.caption}
              onChange={(e) => setTexts({ ...texts, caption: e.target.value })}
            />
          </label>
          <span className={`small ${texts.caption.length > 2200 ? "bad-text" : "muted"}`}>
            {texts.caption.length} / 2200
          </span>
          <label>
            {t("item.selfComment")} <span className="muted small">{t("texts.commentHint")}</span>
            <textarea
              rows={2}
              value={texts.comment}
              onChange={(e) => setTexts({ ...texts, comment: e.target.value })}
            />
          </label>
          <label>
            {t("item.secondComment")} <span className="muted small">{t("texts.comment2Hint")}</span>
            <textarea
              rows={2}
              value={texts.comment2}
              onChange={(e) => setTexts({ ...texts, comment2: e.target.value })}
            />
          </label>
          {alt && (
            <label>
              {t("item.altTexts")} <span className="muted small">{t("texts.altHint")}</span>
              <textarea rows={3} value={texts.alt} onChange={(e) => setTexts({ ...texts, alt: e.target.value })} />
            </label>
          )}
        </>
      )}
      {err && (
        <p className="notice bad small" role="alert">
          {err}
        </p>
      )}
      <div className="row">
        <button onClick={onCancel} disabled={busy}>
          {t("common.cancel")}
        </button>
        <button
          className="primary"
          onClick={go}
          disabled={busy || (!noTexts && (!texts.caption.trim() || texts.caption.length > 2200))}
        >
          {busy ? t("common.saving") : submit}
        </button>
      </div>
    </div>
  );
}

type Slot = { date: string; time: string };
const slotsOf = (e: unknown): Slot[] =>
  e instanceof HttpError && Array.isArray(e.body.suggestions) ? (e.body.suggestions as Slot[]) : [];

/** The account's next free hours after a clash, as one-tap choices. */
function FreeSlots({ slots, onPick }: { slots: Slot[]; onPick: (s: Slot) => void }) {
  if (!slots.length) return null;
  return (
    <div className="slots" role="group" aria-label={t("schedule.freeTimes")}>
      <span className="small muted">{t("schedule.free")}</span>
      {slots.map((s) => (
        <button key={`${s.date} ${s.time}`} className="chip" onClick={() => onPick(s)}>
          {dayName(s.date)} · {s.time}
        </button>
      ))}
    </div>
  );
}

/** Turn a draft into a scheduled item: account, date, time, name and texts; approval follows on the item page. */
function ScheduleForm({ d, accounts, onCancel }: { d: Draft; accounts: string[]; onCancel: () => void }) {
  const kind = d.kind === "reel" ? "reel" : "post";
  const [account, setAccount] = useState(accounts.includes(d.account) ? d.account : accounts[0]);
  const [date, setDate] = useState(zoneShift(1));
  const [time, setTime] = useState(kind === "reel" ? "18:00" : "19:00");
  const [name, setName] = useState(d.payload.name ?? d.id);
  const [slots, setSlots] = useState<Slot[]>([]);
  const single = (d.payload.media?.length ?? 0) === 1;
  const [story, setStory] = useState(false);
  return (
    <TextsForm
      alt={kind === "post"}
      noTexts={story}
      initial={{
        caption: d.payload.caption ?? "",
        comment: d.payload.comment ?? "",
        comment2: d.payload.comment2 ?? "",
        alt: d.payload.alt ?? "",
      }}
      submit={story ? t("schedule.story") : t("schedule.schedule")}
      onCancel={onCancel}
      onSubmit={async (texts) => {
        setSlots([]);
        try {
          const r = await api<{ key: string }>(`drafts/${d.id}/schedule`, {
            account,
            date,
            time,
            name,
            ...(story ? { format: "story" } : texts),
          });
          location.hash = `#/item/${encodeURIComponent(r.key)}`;
        } catch (e) {
          setSlots(slotsOf(e));
          throw e;
        }
      }}
    >
      {single && (
        <div className="segmented" role="group" aria-label={t("schedule.publishAs")}>
          <button aria-pressed={!story} onClick={() => setStory(false)}>
            {kind === "reel" ? t("schedule.reel") : t("channel.post")}
          </button>
          <button aria-pressed={story} onClick={() => setStory(true)}>
            {t("item.story")}
          </button>
        </div>
      )}
      <label>
        {t("schedule.account")}
        <select value={account} onChange={(e) => setAccount(e.target.value)}>
          {accounts.map((a) => (
            <option key={a} value={a}>
              @{a}
            </option>
          ))}
        </select>
      </label>
      <div className="row">
        <label>
          {t("common.dateIn", { zone: zoneLabel() })}
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label>
          {t("common.timeIn", { zone: zoneLabel() })}
          <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
        </label>
      </div>
      <FreeSlots
        slots={slots}
        onPick={(s) => {
          setDate(s.date);
          setTime(s.time);
          setSlots([]);
        }}
      />
      <label>
        {t("name.name")}{" "}
        <span className="muted small">
          {t("schedule.itemKey", {
            key: `${story || kind === "post" ? "post" : "reel"}:${d.payload.folder ?? "drafts"}/${name}`,
          })}
        </span>
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
    </TextsForm>
  );
}

const CHUNK = 8 * 1024 * 1024; // a multiple of 256 KiB, as Drive's resumable uploads want

/** Sends one file to a Drive resumable session, reading it once from start to end (file.stream()): files from
 *  Android's picker often can't be read at an offset (slice → NotReadableError) and may not be the size they claim,
 *  so nothing seeks and the real total is only given with the last chunk. Chunks are 8 MiB; XHR, for progress.
 *  Browsers treat Drive's "308 Resume Incomplete" as a redirect and fail, so X-Guploader-No-308 asks for 200 +
 *  X-HTTP-Status-Code-Override: 308; the next chunk starts after the Range Google confirms. */
function uploadFile(url: string, file: File, onProgress: (sent: number) => void): Promise<{ id: string }> {
  const fail = (msg: string, detail: Record<string, unknown>) => {
    // What the phone saw, kept in the scheduler's audit log (the phone has no console to look at).
    api("client-error", {
      msg,
      detail: {
        ...detail,
        name: file.name,
        type: file.type,
        size: file.size,
        online: navigator.onLine,
        ua: navigator.userAgent,
      },
    }).catch(() => {});
    return new Error(msg);
  };
  const reader = file.stream().getReader();
  let pieces: Uint8Array[] = [],
    have = 0,
    eof = false;
  const fill = async () => {
    // at least one chunk buffered, or the rest of the file
    while (have < CHUNK && !eof) {
      const { done, value } = await reader.read();
      if (done) eof = true;
      else {
        pieces.push(value);
        have += value.length;
      }
    }
  };
  const take = (): Uint8Array => {
    // the buffered bytes as one array (kept: a retry or a short confirm re-sends from it)
    if (pieces.length !== 1) {
      const all = new Uint8Array(have);
      let o = 0;
      for (const p of pieces) {
        all.set(p, o);
        o += p.length;
      }
      pieces = [all];
    }
    return pieces[0];
  };
  const send = (body: Uint8Array, range: string, start: number) =>
    new Promise<XMLHttpRequest>((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open("PUT", url);
      x.setRequestHeader("Content-Range", range);
      x.setRequestHeader("X-Guploader-No-308", "yes");
      x.upload.onprogress = (e) => onProgress(start + e.loaded);
      x.onload = () => resolve(x);
      x.onerror = () => reject(new Error("network"));
      x.send(body as Uint8Array<ArrayBuffer>); // stream chunks are ArrayBuffer-backed
    });
  return (async () => {
    let offset = 0;
    for (;;) {
      try {
        await fill();
      } catch (e) {
        throw fail(t("upload.unreadable", { file: file.name, error: (e as Error).name }), {
          start: offset,
          stage: "read",
        });
      }
      const buf = take();
      const last = eof && have <= CHUNK;
      const n = last ? have : CHUNK;
      const range = n === 0 ? `bytes */${offset}` : `bytes ${offset}-${offset + n - 1}/${last ? offset + n : "*"}`;
      let x: XMLHttpRequest | null = null;
      for (let tries = 0; ; tries++) {
        try {
          x = await send(buf.subarray(0, n), range, offset);
        } catch {
          x = null;
        }
        if (x && !(x.status >= 500)) break;
        if (tries >= 3)
          throw fail(
            x
              ? t("upload.failed", { file: file.name, status: x.status })
              : t("upload.network", {
                  file: file.name,
                  percent: file.size ? Math.round((offset / file.size) * 100) : 0,
                }),
            { start: offset, stage: x ? "status" : "network", status: x?.status ?? 0 },
          );
        await new Promise((r) => setTimeout(r, 2000 * (tries + 1)));
      }
      if (x.status === 308 || x.getResponseHeader("X-HTTP-Status-Code-Override") === "308") {
        const got = /bytes=0-(\d+)/.exec(x.getResponseHeader("Range") ?? "");
        const next = got ? Number(got[1]) + 1 : offset + n;
        pieces = [buf.subarray(next - offset)];
        have -= next - offset;
        offset = next; // keep what Google didn't confirm
        continue;
      }
      if (x.status === 200 || x.status === 201) return JSON.parse(x.responseText) as { id: string };
      throw fail(t("upload.failed", { file: file.name, status: `${x.status}: ${x.responseText.slice(0, 120)}` }), {
        start: offset,
        stage: "status",
        status: x.status,
      });
    }
  })();
}

/** Sends one file to a presigned PUT (an S3 bucket) in one request: the store named the file before, so there's no
 *  answer to read. Retried on a network error or a 5xx; XHR, for progress. */
function putFile(url: string, headers: Record<string, string>, file: File, onProgress: (sent: number) => void) {
  const once = () =>
    new Promise<XMLHttpRequest>((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open("PUT", url);
      for (const [k, v] of Object.entries(headers)) x.setRequestHeader(k, v);
      x.upload.onprogress = (e) => onProgress(e.loaded);
      x.onload = () => resolve(x);
      x.onerror = () => reject(new Error("network"));
      x.send(file);
    });
  return (async () => {
    for (let tries = 0; ; tries++) {
      let x: XMLHttpRequest | null = null;
      try {
        x = await once();
      } catch {
        x = null;
      }
      if (x && x.status >= 200 && x.status < 300) return;
      if (x && x.status < 500)
        throw new Error(
          t("upload.failed", { file: file.name, status: `${x.status}: ${x.responseText.slice(0, 120)}` }),
        );
      if (tries >= 3)
        throw new Error(
          x
            ? t("upload.failed", { file: file.name, status: x.status })
            : t("upload.network", { file: file.name, percent: 0 }),
        );
      await new Promise((r) => setTimeout(r, 2000 * (tries + 1)));
    }
  })();
}

/** A new draft from this device: pick the media (slide order = the order picked), the store (when several take
 *  uploads), the project and the texts. */
function NewDraft({
  stores,
  onDone,
  onCancel,
}: {
  stores: string[];
  onDone: (id: string) => void;
  onCancel: () => void;
}) {
  const [store, setStore] = useState(stores[0] ?? "");
  const groups = useLoad<{ groups: { channel: string; group: string }[] }>("queue/groups?days=120");
  const [files, setFiles] = useState<File[]>([]);
  const [project, setProject] = useState(remembered("draft.project"));
  const [name, setName] = useState("");
  const [texts, setTexts] = useState<Texts>({ caption: "", comment: "", comment2: "", alt: "" });
  const [sent, setSent] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const total = files.reduce((s, f) => s + f.size, 0);
  const images = files.filter((f) => f.type.startsWith("image/")).length;
  const pick = (list: FileList | null) => {
    const fs = [...(list ?? [])].filter((f) => /^(image|video)\//.test(f.type)).slice(0, 10);
    setFiles(fs);
    if (!name && fs[0])
      setName(
        fs[0].name
          .replace(/\.[^.]+$/, "")
          .replace(/[^A-Za-z0-9_.-]+/g, "_")
          .slice(0, 60),
      );
  };
  const go = async () => {
    setErr(null);
    setSent(0);
    try {
      const ids: string[] = [];
      let done = 0;
      for (const f of files) {
        const up = await api<{
          uploadUrl: string;
          headers: Record<string, string>;
          chunked: boolean;
          id: string | null;
        }>("uploads/start", { name: f.name, mimeType: f.type, size: f.size, store });
        const progress = (n: number) => setSent(done + n);
        if (up.chunked) ids.push((await uploadFile(up.uploadUrl, f, progress)).id);
        else {
          await putFile(up.uploadUrl, up.headers, f, progress);
          ids.push(up.id ?? "");
        }
        done += f.size;
      }
      remember("draft.project", project);
      const r = await api<{ id: string }>("drafts/new", { files: ids, project, name, store, ...texts });
      onDone(r.id);
    } catch (e) {
      setErr((e as Error).message);
      setSent(null);
    }
  };
  const busy = sent !== null;
  return (
    <div className="card form">
      <div className="row picks">
        {/* No accept list on purpose: with image/video types Android opens its photo picker, whose copies Chrome can't
            read (NotReadableError / TypeError, seen on some Android phones); without, it opens the file browser. */}
        <label className="button">
          {t("draft.choose")}
          <input type="file" multiple className="vh" disabled={busy} onChange={(e) => pick(e.target.files)} />
        </label>
      </div>
      <p className="muted small">{t("draft.pickHelp")}</p>
      {stores.length > 1 && (
        <label>
          {t("draft.store")}
          <select value={store} onChange={(e) => setStore(e.target.value)} disabled={busy}>
            {stores.map((s) => (
              <option key={s} value={s}>
                {s === "drive" || s === "s3" || s === "local" ? t(`store.${s}`) : s}
              </option>
            ))}
          </select>
        </label>
      )}
      {files.length > 0 && (
        <p className="muted small">
          {files.length > 1
            ? t("draft.carouselOf", { n: files.length })
            : files[0].type.startsWith("video/")
              ? t("schedule.reel")
              : t("draft.photo")}{" "}
          · {t("draft.size", { mb: (total / 1024 / 1024).toFixed(1), files: files.map((f) => f.name).join(", ") })}
        </p>
      )}
      <div className="row">
        <label>
          {t("queue.project")}
          <input
            list="projects"
            value={project}
            onChange={(e) => setProject(e.target.value)}
            placeholder="20260201_RUN"
            disabled={busy}
          />
        </label>
        <label>
          {t("name.name")}
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="short3_name" disabled={busy} />
        </label>
      </div>
      <datalist id="projects">
        {[...new Set((groups.data?.groups ?? []).map((g) => g.group))].map((g) => (
          <option key={g} value={g} />
        ))}
      </datalist>
      <label>
        {t("item.caption")}
        <textarea
          rows={5}
          value={texts.caption}
          onChange={(e) => setTexts({ ...texts, caption: e.target.value })}
          disabled={busy}
        />
      </label>
      <label>
        {t("item.selfComment")} <span className="muted small">{t("texts.commentHint")}</span>
        <textarea
          rows={2}
          value={texts.comment}
          onChange={(e) => setTexts({ ...texts, comment: e.target.value })}
          disabled={busy}
        />
      </label>
      <label>
        {t("item.secondComment")} <span className="muted small">{t("texts.comment2Hint")}</span>
        <textarea
          rows={2}
          value={texts.comment2}
          onChange={(e) => setTexts({ ...texts, comment2: e.target.value })}
          disabled={busy}
        />
      </label>
      {images > 0 && files.length > 1 && (
        <label>
          {t("item.altTexts")} <span className="muted small">{t("draft.altHint")}</span>
          <textarea
            rows={3}
            value={texts.alt}
            onChange={(e) => setTexts({ ...texts, alt: e.target.value })}
            disabled={busy}
          />
        </label>
      )}
      {busy && (
        <p className="small">
          {t("draft.uploading", { percent: total ? Math.round((sent! / total) * 100) : 0 })}{" "}
          <progress max={total} value={sent!} />
        </p>
      )}
      {err && <p className="error small">{err}</p>}
      <div className="row">
        <button onClick={onCancel} disabled={busy}>
          {t("common.cancel")}
        </button>
        <button className="primary" onClick={go} disabled={busy || !files.length || !project || !name}>
          {busy ? t("draft.uploadingShort") : t("draft.upload")}
        </button>
      </div>
      <p className="muted small">{t("draft.uploadNote")}</p>
    </div>
  );
}

/** A destructive button that asks once, in place, before it acts. */
function ConfirmButton({
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

function DraftsPage() {
  const {
    drafts: { data, error, reload, stale, at },
  } = useShared();
  const uploads = useLoad<{ enabled: boolean; stores: string[] }>("uploads/enabled");
  const noAccounts = useNoAccounts();
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [about, setAbout] = useState(false);
  const refuse = async (id: string) => {
    try {
      await api(`drafts/${id}/refuse`, {});
      setMsg(t("drafts.refused"));
      reload();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  const kindWord = (k: string) =>
    k === "reel"
      ? t("schedule.reel")
      : k === "carousel"
        ? t("drafts.carousel")
        : k === "photo"
          ? t("draft.photo")
          : k === "shorts_comment"
            ? t("drafts.shortsComment")
            : cap(k);
  return (
    <section>
      {!adding && (
        <div className="drafts-head">
          {uploads.data?.enabled && (
            <button onClick={() => setAdding(true)} className="with-icon">
              {ICON.plus}
              {t("drafts.new")}
            </button>
          )}
          <button
            className="icon-btn"
            onClick={() => setAbout(!about)}
            aria-expanded={about}
            aria-controls="drafts-about"
            aria-label={t("drafts.about")}
            title={t("drafts.about")}
          >
            {ICON.info}
          </button>
        </div>
      )}
      {about && (
        <p id="drafts-about" className="notice small">
          {t("drafts.aboutBefore")} <code>UPLOADS/inbox/&lt;project&gt;/</code> {t("drafts.aboutAfter")}
        </p>
      )}
      {adding && (
        <NewDraft
          stores={uploads.data?.stores ?? []}
          onCancel={() => setAdding(false)}
          onDone={(id) => {
            setAdding(false);
            setOpen(id);
            reload();
          }}
        />
      )}
      {stale && <Stale msg={stale} at={at} onRetry={reload} />}
      {error && <ErrorNote msg={error} onRetry={reload} />}
      {msg && (
        <p className="notice small" role="status">
          {msg}
        </p>
      )}
      {noAccounts && <SetupNote />}
      {data && !data.drafts.length && !noAccounts && <p className="muted">{EMPTY.drafts}</p>}
      <ul className="list">
        {data?.drafts.map((d) => (
          <li key={d.id}>
            <div className="row">
              <strong className="clip">{d.payload.title ?? nice(d.payload.name ?? kindWord(d.kind))}</strong>
              <span className="muted small">
                {kindWord(d.kind)} · @{d.account}
              </span>
            </div>
            {d.previews && (
              <div className={d.previews.length > 1 ? "media carousel" : "media"}>
                {d.previews.map((m) =>
                  m.mime.startsWith("video/") ? (
                    <video
                      key={m.url}
                      src={`${m.url}#t=0.1`}
                      controls
                      playsInline
                      preload="metadata"
                      aria-label={t("drafts.video", { name: m.name })}
                    />
                  ) : (
                    <img key={m.url} src={m.url} alt={m.name} loading="lazy" />
                  ),
                )}
              </div>
            )}
            {d.payload.caption && <pre className="text small">{d.payload.caption}</pre>}
            {d.payload.comment && <p className="muted small">{t("drafts.selfComment", { text: d.payload.comment })}</p>}
            {d.payload.comment2 && (
              <p className="muted small">{t("drafts.secondComment", { text: d.payload.comment2 })}</p>
            )}
            {d.payload.note && <p className="small">{d.payload.note}</p>}
            <p className="muted small">
              {when(d.created_at)} · {d.source === "drive" ? t("drafts.driveInbox") : d.created_by}
            </p>
            {open !== d.id && (
              <div className="row actions">
                <ConfirmButton
                  label={t("drafts.refuse")}
                  confirm={t("drafts.refuseConfirm")}
                  detail={t("drafts.refuseDetail")}
                  onConfirm={() => refuse(d.id)}
                />
                {(d.payload.media?.length ?? 0) > 0 && d.kind !== "shorts_comment" && (
                  <button onClick={() => setOpen(d.id)}>{t("drafts.schedule")}</button>
                )}
              </div>
            )}
            {open === d.id && data && <ScheduleForm d={d} accounts={data.accounts} onCancel={() => setOpen(null)} />}
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------- stats (the accounts and the last week's posts)

type StatsOverview = {
  days: number;
  accounts: {
    id: string;
    platform: string;
    handle: string;
    title: string;
    followers: number | null;
    change: number | null;
    /** When the sample the change is counted from was taken. */
    since: string | null;
  }[];
  recent: {
    key: string;
    platform: string;
    title: string;
    label: string | null;
    published_at: string | null;
    views: number | null;
    likes: number | null;
    comments: number | null;
    /** The post's Results or the video's page. */
    href: string;
  }[];
};

const num = (n?: number | null) => (n == null ? "–" : n >= 10000 ? `${(n / 1000).toFixed(1)}k` : String(n));
/** "1 follower", "12.3k views": the plural key picks one/other by the count (a missing count reads "–" and plural). */
const count = (n: number | null | undefined, key: Key) => t(key, { n: n ?? Number.NaN, count: num(n) });

/** The Stats tab: each account with its followers and the change since a day before, opening its page; then the
 *  posts and videos of the last 7 days, most viewed first, each opening its Results or video page. */
function StatsPage() {
  const { data, error, stale, at, reload } = useLoad<StatsOverview>("stats");
  if (error) return <ErrorNote msg={error} onRetry={reload} />;
  if (!data) return <p className="muted">{t("common.loading")}</p>;
  return (
    <section>
      {stale && <Stale msg={stale} at={at} onRetry={reload} />}
      <h2>{t("stats.audience")}</h2>
      {data.accounts.length ? (
        <ul className="list">
          {data.accounts.map((a) => (
            <li key={a.id}>
              <a className="aud" href={`#/stats/${a.platform}/${encodeURIComponent(a.id)}`}>
                <div className="clip">
                  <strong className="small">{a.title}</strong>
                  <div className="muted small">
                    {a.platform === "youtube"
                      ? t("stats.ytChannel")
                      : `Instagram${a.title !== a.handle ? ` · @${a.handle}` : ""}`}
                  </div>
                </div>
                <div className="small num aud-n">
                  {count(a.followers, a.platform === "youtube" ? "stats.subscribers" : "stats.followers")}
                  {a.change ? (
                    <div className={a.change > 0 ? "ok-text" : "bad-text"}>
                      {a.change > 0 ? "+" : ""}
                      {a.change} {a.since ? t("channel.since", { when: shortDay(a.since) }) : ""}
                    </div>
                  ) : null}
                </div>
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">{t("stats.noAccounts")}</p>
      )}
      <h2>{t("stats.recent", { n: data.days })}</h2>
      {data.recent.length ? (
        <ul className="list">
          {data.recent.map((r) => (
            <li key={r.key}>
              <a href={r.href}>
                <div className="row">
                  <strong className="small clip">{r.title}</strong>
                  <span className="small num">{count(r.views, "stats.views")}</span>
                </div>
                <div className="muted small">
                  {r.label ?? (r.platform === "youtube" ? t("results.video") : t("channel.post"))}
                  {r.published_at ? ` · ${shortDay(r.published_at)}` : ""}
                </div>
                <div className="muted small num">
                  {count(r.likes, "stats.likes")} · {count(r.comments, "stats.comments")}
                </div>
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">{t("stats.recentNone", { n: data.days })}</p>
      )}
    </section>
  );
}

/** An account's page: its follower count and change, the followers chart and views per day over a period, and
 *  the posts and videos that brought followers, each opening its Results or video page. */
function ChannelPage({ route }: { route: string }) {
  const [, platform, raw] = /^\/stats\/([^/]+)\/(.+)$/.exec(route) ?? [];
  const account = raw ? decodeURIComponent(raw) : "";
  const [days, setDays] = useState<"7" | "30" | "90">("30");
  const [mode, setMode] = useState<"total" | "daily">("total");
  const { data, error, stale, at, reload } = useLoad<ChannelStats>(
    account ? `stats/channel?account=${encodeURIComponent(account)}&days=${days}` : null,
    [account, days],
  );
  const yt = platform === "youtube";
  const word = yt ? t("channel.subscribers") : t("channel.followers");
  // memoised: the chart keeps its readout while the parent re-renders
  const followers = useMemo(
    (): ChartSeries[] =>
      data ? [{ label: word, hue: 1, points: mode === "total" ? data.followers.total : data.followers.daily }] : [],
    [data, mode, word],
  );
  const views = useMemo(
    (): ChartSeries[] => (data ? [{ label: t("results.views"), hue: 2, points: data.views }] : []),
    [data],
  );
  const back = (
    <p className="back-row">
      <a className="back" href="#/stats">
        {ICON.back}
        {t("tabs.stats")}
      </a>
    </p>
  );
  if (error)
    return (
      <>
        {back}
        <ErrorNote msg={error} onRetry={reload} />
      </>
    );
  if (!data)
    return (
      <>
        {back}
        <p className="muted">{t("common.loading")}</p>
      </>
    );
  const a = data.account;
  return (
    <section>
      {back}
      {stale && <Stale msg={stale} at={at} onRetry={reload} />}
      <h2>{a.title || `@${a.id}`}</h2>
      <p className="muted small">{yt ? t("stats.ytChannel") : `Instagram · @${a.id}`}</p>
      <div className="card">
        <p className="stat-big num">{a.followers == null ? "–" : a.followers.toLocaleString("en")}</p>
        <p className="small">
          {yt ? t("results.subscribersWord") : t("results.followersWord")}
          {a.change ? (
            <span className={a.change > 0 ? " ok-text" : " bad-text"}>
              {" "}
              · {a.change > 0 ? "+" : ""}
              {a.change} {a.since ? t("channel.since", { when: shortDay(a.since) }) : ""}
            </span>
          ) : null}
        </p>
      </div>
      <Segmented
        label={t("channel.period")}
        value={days}
        options={[
          { value: "7", text: t("channel.days7") },
          { value: "30", text: t("channel.days30") },
          { value: "90", text: t("channel.days90") },
        ]}
        onChange={setDays}
      />
      <div className="card">
        <h3>{word}</h3>
        <Segmented
          label={t("results.range")}
          value={mode}
          options={[
            { value: "total", text: t("results.total") },
            { value: "daily", text: t("results.daily") },
          ]}
          onChange={setMode}
        />
        {followers[0]?.points.length ? (
          <LineChart series={followers} mode={mode} tz={ZONE} />
        ) : (
          <p className="muted">{t("channel.noSamples")}</p>
        )}
      </div>
      <div className="card">
        <h3>{t("channel.viewsPerDay")}</h3>
        {data.views.some((p) => p.value !== null) ? (
          <LineChart series={views} mode="daily" tz={ZONE} />
        ) : (
          <p className="muted">{t("channel.noViews")}</p>
        )}
      </div>
      <h3>{t("channel.brought")}</h3>
      {yt && data.analytics === false ? (
        <p className="muted small">{t("channel.analyticsMissing")}</p>
      ) : data.brought.length ? (
        <ul className="list">
          {data.brought.map((b) => (
            <li key={b.key}>
              <a className="aud" href={b.href}>
                <div className="clip">
                  <strong className="small">{b.title}</strong>
                </div>
                <div className="small num aud-n">
                  <span className="ok-text">+{b.follows}</span>
                  {b.share != null && <div className="muted">{Math.round(b.share * 100)}%</div>}
                </div>
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">{t("channel.broughtNone")}</p>
      )}
      {a.url && (
        <a className="button-link with-icon" href={a.url} target="_blank" rel="noopener">
          {yt ? ICON.youtube : ICON.instagram}
          {t("row.openOn", { where: yt ? "YouTube" : "Instagram" })}
        </a>
      )}
    </section>
  );
}

/** "Oct 31" on the workspace's clock, for a UTC instant. */
const shortDay = (iso: string) =>
  new Intl.DateTimeFormat(dateLocale(), { timeZone: ZONE, month: "short", day: "numeric" }).format(Date.parse(iso));

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
  const { data } = useLoad<{ stores: { kind: string; default: boolean; status: string; where: string | null }[] }>(
    "media-stores",
  );
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
            <li key={s.kind}>
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

function SettingsPage({ me, onSignOut }: { me: Me; onSignOut: () => void }) {
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
