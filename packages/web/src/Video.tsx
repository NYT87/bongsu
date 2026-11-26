// A YouTube video's page: its release date and its Short's comment.

import { startAuthentication } from "@simplewebauthn/browser";
import { useContext, useEffect, useRef, useState } from "react";
import { api, HttpError, type Item } from "./api";
import { type CalEvent, external, statusTone, statusWord } from "./Calendar";
import {
  Dot,
  dayName,
  ErrorNote,
  friendly,
  ICON,
  lastList,
  MeCtx,
  platformName,
  Segmented,
  useLoad,
  when,
  zoneLabel,
  zoneShift,
  zoneToday,
} from "./common";
import { useApprove } from "./Item";
import { t } from "./i18n";
import { MetricsPanel, useMetrics, YT_METRICS, YT_METRICS_SUBS } from "./Metrics";

/** Whether the signed-in role has a scope, e.g. "reschedule" for moving a YouTube release date. */
const useCan = (scope: string) => useContext(MeCtx)?.scopes?.includes(scope) ?? false;

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

export function VideoPage({ route }: { route: string }) {
  const m = /^\/video\/([^/]+)\/([^?]+)\?d=(\d{4}-\d{2}-\d{2})/.exec(route);
  const month = m?.[3].slice(0, 7) ?? zoneToday().slice(0, 7);
  const { data, error, reload } = useLoad<{ events: CalEvent[] }>(`calendar?month=${month}`, [month]);
  const [moved, setMoved] = useState<string | null>(null);
  const canReschedule = useCan("reschedule"); // the server refuses other roles anyway; the card is for who can use it
  const e = m && data?.events.find((x) => external(x) && x.account === m[1] && x.url?.endsWith(`/${m[2]}`));
  // a video Bongsu uploaded isn't a separate video: its page is its item's Results (the calendar lists the item)
  const videoId = m?.[2];
  const missing = !!data && !e;
  useEffect(() => {
    if (!missing || !videoId) return;
    api<{ item_key?: string }>(`video/metrics?video=${encodeURIComponent(videoId)}`)
      .then((d) => {
        if (d.item_key) location.replace(`#/item/${encodeURIComponent(d.item_key)}/results`);
      })
      .catch(() => {}); // the "not in the calendar" note stands
  }, [missing, videoId]);
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
