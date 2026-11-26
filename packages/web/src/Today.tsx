// The Today tab: what needs you, then the day's posts.

import type { QueueItem } from "./api";
import { type CalEvent, EventList } from "./Calendar";
import {
  dayName,
  dueDate,
  dueTime,
  ErrorNote,
  keyTitle,
  SetupNote,
  Stale,
  useLoad,
  useNoAccounts,
  useShared,
  zoneShift,
} from "./common";
import { t } from "./i18n";
import { QueueList, QueuePage } from "./Queue";

/** Notification text without links, and with item keys made readable. */
const noteText = (s: string) =>
  s
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\b(reel|post):[\w./-]+/g, (k) => `"${keyTitle(k)}"`)
    .replace(/\s{2,}/g, " ")
    .trim();

// ---------------------------------------------------------------- today

export function TodayPage() {
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
