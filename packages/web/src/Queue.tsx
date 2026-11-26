// The Queue tab: everything planned, by day, filtered by channel and group.

import { type ReactNode, useState } from "react";
import type { QueueItem } from "./api";
import {
  type Channel,
  cap,
  channelLabel,
  Dot,
  dayName,
  dueDate,
  dueTime,
  EMPTY,
  ErrorNote,
  ICON,
  itemChannel,
  needs,
  nice,
  platformName,
  project,
  SetupNote,
  Stale,
  useLoad,
  useNoAccounts,
  when,
  zoneLabel,
  zoneShift,
  zoneToday,
} from "./common";
import { dateLocale, t } from "./i18n";

/** The platform's own icon where the app has one, else a generic "open". */
const platformIcon = (id: string) =>
  id === "youtube" ? ICON.youtube : id === "instagram" ? ICON.instagram : ICON.external;

// ---------------------------------------------------------------- rows (one look for every list of items)

/** A row's status: its border colour (green: approved / posted / public; amber: waiting on the owner; red: failed;
 *  none: neutral), with the word kept for screen readers. */
export type Tone = "ok" | "warn" | "bad" | "";

function queueStatus(i: QueueItem): { tone: Tone; word: string } {
  if (i.hold) return { tone: "warn", word: t("status.hold") };
  const n = needs(i);
  if (!n) return { tone: "ok", word: t("status.approved") };
  return { tone: "warn", word: n === "approve" ? t("status.notApproved") : t("status.reApprove") };
}

/** A row: channel dot and label, title, when, account; the border's colour is the status (no
 *  label on the row). The row opens the item in the app; a posted or public one also gets the platform's icon, which
 *  opens the real post or video (only the icon, not the row). */
export function Row({
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

export function QueueList({
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

export const remembered = (k: string) => {
  try {
    return localStorage.getItem(k) ?? "";
  } catch {
    return "";
  }
};

export const remember = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* private mode */
  }
};

export function QueuePage({
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
