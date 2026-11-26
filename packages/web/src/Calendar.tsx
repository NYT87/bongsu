// The Calendar tab: a month of posts and videos, and a day's list.

import { useState } from "react";
import {
  type Channel,
  cap,
  channelLabel,
  Dot,
  dayName,
  dotClass,
  dueTime,
  ErrorNote,
  ICON,
  nice,
  SetupNote,
  Stale,
  useLoad,
  useNoAccounts,
  zoneLabel,
  zoneToday,
} from "./common";
import { dateLocale, type Key, t } from "./i18n";
import { Row, type Tone } from "./Queue";

const shiftMonth = (m: string, by: number) => {
  const d = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1 + by, 1));
  return d.toISOString().slice(0, 7);
};

const channelKey = (c: Channel) => `${c.platform}:${c.format === "video" ? "video" : "post"}`;

// ---------------------------------------------------------------- calendar (like the local dashboard's)

export type CalEvent = {
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

export const statusWord = (s: string) => (STATUS_KEY[s] ? t(STATUS_KEY[s]) : cap(s));

/** Events read from the platform itself (YouTube uploads), not planned here: no item page, nothing to approve. */
export const external = (e: CalEvent) => !e.key;

export const statusTone = (s: string) =>
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
export function EventList({ events, empty }: { events: CalEvent[]; empty?: string }) {
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

export function CalendarPage() {
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
