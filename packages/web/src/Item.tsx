// An item's page: its texts, media, approval, schedule, Trial Reel copy and results.

import { startAuthentication } from "@simplewebauthn/browser";
import { useEffect, useRef, useState } from "react";
import { api, HttpError, type Item, type UploadProgress } from "./api";
import {
  ConfirmButton,
  cap,
  channelLabel,
  Dot,
  dayName,
  dueDate,
  dueTime,
  ErrorNote,
  friendly,
  ICON,
  itemChannel,
  keyTitle,
  lastList,
  PLATFORMS,
  platformName,
  Segmented,
  Stale,
  Switch,
  useLoad,
  useShared,
  utcToZone,
  when,
  zoneClock,
  zoneLabel,
  zoneParts,
  zoneShift,
  zoneToday,
} from "./common";
import { FreeSlots, type Slot, slotsOf, TextsForm } from "./Drafts";
import { t } from "./i18n";
import { ResultsLine, ResultsView } from "./Metrics";
import { YtSummary, ytTexts } from "./YtFields";
import { changedSettings } from "./youtube-form";

const feature = (id: string, f: string) => !!PLATFORMS.get(id)?.features[f];

/** What an item's approval says: by whom and when while it still matches, else what changed since. */
export function ApprovedText({ approved }: { approved: NonNullable<Item["approved"]> }) {
  if (!approved.matches) return <>{approved.commentsOnly ? t("item.commentsChanged") : t("item.changed")}</>;
  const when = utcToZone(approved.at);
  return <>{approved.by ? t("item.approvedByAt", { name: approved.by, when }) : t("item.approvedAt", { when })}</>;
}

/** A published Reel's Trial Reel copy: posting, shown, or not posted and why. A copy closed without going out (its
 *  switch turned off before it posted, a dry run) is `done` with no post: not posted, though nothing went wrong (#99). */
export function TrialCopy({ trial }: { trial: NonNullable<Item["trial"]> }) {
  const bad = ["failed", "refused", "held"].includes(trial.state);
  return (
    <div className="card published">
      <p className="small">
        <span className={`pill${trial.state === "published" ? " ok" : bad ? " bad" : ""}`}>{t("results.trial")}</span>{" "}
        {trial.state === "published"
          ? t("item.trialShown", { when: trial.at ? when(trial.at) : t("item.published") })
          : bad || trial.state === "done"
            ? trial.error
              ? t("item.trialNotPostedError", { error: trial.error })
              : t("item.trialNotPosted")
            : t("item.trialPosting")}
      </p>
      {trial.results && <ResultsLine r={trial.results} vs={t("results.vsRegular")} />}
      {trial.permalink && (
        <a className="button-link with-icon" href={trial.permalink} target="_blank" rel="noopener">
          {ICON.external}
          {t("item.openTrial")}
        </a>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- one item, and approving it

export type ItemView = "results" | "post";

export function ItemPage({
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
  // A YouTube video's own fields: its texts and settings, its subtitle files and thumbnail among the media.
  const yt = item.platform === "youtube" ? (item.youtube ?? null) : null;
  const files = yt
    ? {
        subtitles: yt.subtitles,
        thumbnail: yt.thumbnail
          ? { name: yt.thumbnail, url: item.media.find((m) => m.name === yt.thumbnail)?.url ?? null }
          : null,
      }
    : null;
  const shownMedia = yt ? item.media.filter((m) => m.mime.startsWith("video/")) : item.media;
  // A published Instagram item or YouTube video opens on its Results (when it has any, unless the link says Post)
  // or on the post.
  const split = !!item.published && (item.platform === "instagram" || item.platform === "youtube");
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
            { value: "post", text: yt ? t("results.video") : t("results.post") },
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
              {t("row.openOn", { where: platformName(item.platform) })}
            </a>
          )}
        </div>
      )}
      {!item.published && item.progress && <UploadLine p={item.progress} again={!!item.failed?.again} />}
      {item.trial && item.published && (item.trial.on || item.trial.state !== "planned") && (
        <TrialCopy trial={item.trial} />
      )}

      {item.format === "story" ? (
        <p className="muted small">{t("item.storyNote")}</p>
      ) : (
        <>
          {yt && (
            <>
              <h2>{t("yt.title")}</h2>
              <pre className="text">{yt.texts?.title || t("item.missing")}</pre>
            </>
          )}
          <h2>{yt ? t("yt.description") : t("item.caption")}</h2>
          <pre className="text">{item.caption || (yt ? t("item.none") : t("item.missing"))}</pre>
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
      {yt && files && <YtSummary yt={yt} files={files} />}
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
            youtube={
              yt && files
                ? { initial: { texts: { title: "", ...(yt.texts ?? {}) }, settings: yt.settings }, files }
                : null
            }
            submit={t("item.saveTexts")}
            onSubmit={async (texts, edited) => {
              if (yt && edited) {
                const { alt: _alt, ...words } = texts;
                await api("item/texts", { key: keyId, ...words, texts: ytTexts(edited.texts) });
                // the settings aren't part of the approval: saved on their own, after the texts
                const changed = changedSettings(edited.settings, yt.settings, yt.channel);
                if (Object.keys(changed).length)
                  try {
                    await api("item/youtube", { key: keyId, ...changed });
                  } catch (e) {
                    reload();
                    throw new Error(t("yt.saveFailedSettings", { error: (e as Error).message }));
                  }
              } else await api("item/texts", { key: keyId, ...texts });
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

      <h2>{shownMedia.length > 1 ? t("item.mediaCount", { n: shownMedia.length }) : t("item.media")}</h2>
      <div className={shownMedia.length > 1 ? "media carousel" : "media"}>
        {shownMedia.map((m, k) =>
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
        {!shownMedia.length &&
          (item.posted ? (
            <p className="muted small">{t("item.mediaPosted")}</p>
          ) : (
            <p className="notice warn">{t("item.mediaMissing")}</p>
          ))}
      </div>

      {item.failed && !item.posted && !done && item.progress?.phase !== "locked" && (
        <p className="notice bad" role="status">
          {item.failed.error ? t("item.failedWith", { error: item.failed.error }) : t("item.failed")}{" "}
          {item.failed.again
            ? t("item.failedAgain")
            : t("item.failedMayBeLive", { platform: platformName(item.platform) })}
        </p>
      )}
      {item.approved && !item.failed && !done && (
        <p className={`notice ${item.approved.matches ? "ok" : "warn"}`}>
          <ApprovedText approved={item.approved} />
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

/** Approving one item (a post, or a Short's comment) with a passkey: the server binds the challenge to what the page
 *  showed (`fingerprint`) and refuses if it changed since. */
export function useApprove(keyId: string, fingerprint: string | undefined, after: () => void) {
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

/** The upload's phase on the item page: uploading (with how far), adding subtitles, processing, ready, or locked.
 *  `again`: a locked job starts over on a new approval (the failed notice isn't shown beside this card). */
function UploadLine({ p, again }: { p: NonNullable<UploadProgress>; again?: boolean }) {
  const text =
    p.phase === "uploading"
      ? t("upload.uploading", { percent: p.percent })
      : p.phase === "ready"
        ? readyText(p.at)
        : t(`upload.${p.phase}`);
  const tone = p.phase === "ready" ? " ok" : p.phase === "locked" ? " bad" : "";
  return (
    <div className="card published" role="status">
      <p className="small">
        <span className={`pill${tone}`}>{t("upload.progress")}</span> {text}
      </p>
      {p.phase === "uploading" && <progress className="upload-bar" max={100} value={p.percent} aria-hidden="true" />}
      {p.phase === "locked" && (
        <p className="small">
          {t("upload.lockedNote")}{" "}
          <a href="/dashboard/docs/youtube" target="_blank" rel="noopener">
            {t("upload.guide")}
          </a>
          {again ? ` ${t("item.failedAgain")}` : ""}
        </p>
      )}
    </div>
  );
}

/** "Ready: goes public at 18:00 GMT+9" today, with the day otherwise; once the time has passed it only waits (the
 *  next run publishes it, or a paused workspace holds it), so it names no time it can't keep. */
function readyText(at: number): string {
  const ms = at * 1000;
  if (ms <= Date.now()) return t("upload.readyWaiting");
  const p = zoneParts(ms);
  const date = `${p.year}-${p.month}-${p.day}`;
  const time = `${zoneClock(ms)} ${zoneLabel()}`;
  return t("upload.ready", { time: date === zoneToday() ? time : `${dayName(date)} ${time}` });
}
