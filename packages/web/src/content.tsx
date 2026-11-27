// The content screens, for any host (#145): the app shows them under its own header and tabs, and the dashboard on its
// Content page, against its own API (/admin-api/content). Here: what a host sets up (where the API is, the brand, the
// person's zone, language and platforms, a cache of its own), the lists the screens share, which page each `#/` route
// shows and its title, and the context the screens read. The chrome (header, tabs, the workspace picker, the app's
// Settings) is each host's own.

import type { ReactNode } from "react";
import { type QueueItem, setApiBase } from "./api";
import { CalendarPage } from "./Calendar";
import { CommentsPage } from "./Comments";
import {
  type DraftsAnswer,
  dueDate,
  dueTime,
  keyTitle,
  type Me,
  MeCtx,
  needs,
  type PlatformInfo,
  type Shared,
  SharedCtx,
  type Status,
  setBrand,
  setCacheScope,
  setLastList,
  setPlatforms,
  setZone,
  useLoad,
  zoneClock,
  zoneToday,
} from "./common";
import { DraftsPage } from "./Drafts";
import { ItemPage, type ItemView } from "./Item";
import { setLocale, t } from "./i18n";
import { QueuePage } from "./Queue";
import { ChannelPage, StatsPage } from "./Stats";
import { TodayPage } from "./Today";
import { VideoPage } from "./Video";

/** Where the screens run: the API they call, and the brand when the host's build doesn't define the app's. */
export interface ContentHost {
  apiBase: string;
  brand?: { name: string; themeColor: string };
}

/** Sets the screens up for a host and the person in it: where the API is (the host sets it before loading `me` too),
 *  the brand, their zone and language, the workspace's platforms, and a cache scoped to the host and the workspace. */
export function applyContent(host: ContentHost, me: Me, platforms: PlatformInfo[]) {
  setApiBase(host.apiBase);
  if (host.brand) setBrand(host.brand);
  setZone(me.timezone);
  setLocale(me.locale);
  setPlatforms(platforms);
  setCacheScope(`${host.apiBase}|${me.workspace?.id ?? ""}`);
}

/** The lists every screen shares: the status, the week's queue (what needs you, what's overdue, what's held), the
 *  drafts and the unseen comments. */
export function useSharedState(): Shared {
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

/** The open item's display name, once its page has loaded it (the title otherwise comes from its key). */
export type Named = { key: string; title: string | null } | null;

/** The page and title for a route (the hash without its `#`), or null when it isn't a content route (`/settings`, the
 *  app's own). An unknown route is Today. Also notes the last list, where an item's or a video's page goes back to. */
export function contentRoute(
  route: string,
  named: Named,
  onTitle: (named: { key: string; title: string | null }) => void,
): { page: ReactNode; title: string } | null {
  if (route.startsWith("/settings")) return null;
  const onItem = route.startsWith("/item/");
  const onVideo = route.startsWith("/video/");
  if (!onItem && !onVideo && !route.startsWith("/setup") && !route.startsWith("/stats/"))
    setLastList(`#${route || "/"}`);
  if (onItem) {
    // #/item/<key>, or with the view it opens: #/item/<key>/results, #/item/<key>/post
    const m = /^\/item\/(.+?)(?:\/(results|post))?$/.exec(route);
    const key = m ? decodeURIComponent(m[1]) : "";
    return {
      page: <ItemPage keyId={key} view={m?.[2] as ItemView | undefined} onTitle={(title) => onTitle({ key, title })} />,
      title: named?.key === key && named.title ? named.title : keyTitle(key),
    };
  }
  if (onVideo) return { page: <VideoPage route={route} />, title: t("title.video") };
  if (route.startsWith("/calendar")) return { page: <CalendarPage />, title: t("tabs.calendar") };
  if (route.startsWith("/queue")) return { page: <QueuePage days={60} filters />, title: t("tabs.queue") };
  if (route.startsWith("/drafts")) return { page: <DraftsPage />, title: t("tabs.drafts") };
  if (route.startsWith("/stats/")) return { page: <ChannelPage route={route} />, title: t("title.channel") };
  if (route.startsWith("/stats")) return { page: <StatsPage />, title: t("tabs.stats") };
  if (route.startsWith("/comments")) return { page: <CommentsPage />, title: t("header.comments") };
  return { page: <TodayPage />, title: t("tabs.today") };
}

/** The person and the shared lists, for the screens below. */
export function ContentProviders({ me, shared, children }: { me: Me; shared: Shared; children: ReactNode }) {
  return (
    <MeCtx.Provider value={me}>
      <SharedCtx.Provider value={shared}>{children}</SharedCtx.Provider>
    </MeCtx.Provider>
  );
}
