// The Drafts tab: new drafts (texts, media, upload) and scheduling one.

import { isSubtitle, THUMBNAIL, videoWithExtras } from "@bongsu/core/platforms/youtube";
import { type ReactNode, useContext, useState } from "react";
import { api, HttpError, type YouTubeSettings } from "./api";
import {
  type AccountInfo,
  ConfirmButton,
  cap,
  type Draft,
  dayName,
  EMPTY,
  ErrorNote,
  ICON,
  MeCtx,
  nice,
  SetupNote,
  Stale,
  useLoad,
  useNoAccounts,
  useShared,
  when,
  zoneLabel,
  zoneShift,
} from "./common";
import { t } from "./i18n";
import { remember, remembered } from "./Queue";
import { Counter, type Texts, YtExtras, type YtFiles, type YtState, YtTitle, ytFiles, ytTexts } from "./YtFields";
import { changedSettings, YT_DESCRIPTION_MAX, ytBlocked } from "./youtube-form";

/** The workspace's media folder: where its inbox and the app's uploads live. */
const useMediaFolder = () => useContext(MeCtx)?.workspace?.mediaFolder ?? "UPLOADS";

/** A draft's previews as media: a YouTube video's subtitle files and thumbnail aren't slides (the item page shows
 *  only the video too); a lone thumbnail.jpg of a photo post stays. */
function shownPreviews<T extends { name: string; mime: string }>(list: T[]): T[] {
  const extras = videoWithExtras(list);
  return list.filter((m) => !isSubtitle(m.name) && !(extras && THUMBNAIL.test(m.name)));
}

/** Caption / self-comment / alt texts (posts only), as they'll be published; a YouTube video's title, settings,
 *  languages and thumbnail around them when `youtube` is given. */
export function TextsForm({
  alt,
  initial,
  submit,
  onSubmit,
  onCancel,
  children,
  noTexts = false,
  youtube,
}: {
  /** Show the alt texts field (images on a platform that takes alt texts). */
  alt: boolean;
  initial: Texts;
  submit: string;
  onSubmit: (texts: Texts, yt: YtState | null) => Promise<void>;
  onCancel: () => void;
  children?: ReactNode;
  noTexts?: boolean;
  /** A YouTube video's form: where its fields start, and its files. */
  youtube?: { initial: YtState; files: YtFiles } | null;
}) {
  const [texts, setTexts] = useState(initial);
  // kept once touched, so switching the account back and forth doesn't lose it; until then the account's start
  const [ytEdit, setYt] = useState<YtState | null>(null);
  const yt = youtube ? (ytEdit ?? youtube.initial) : null;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const max = yt ? YT_DESCRIPTION_MAX : 2200;
  const go = async () => {
    setBusy(true);
    setErr(null);
    try {
      await onSubmit(texts, yt);
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
          {yt && <YtTitle value={yt} onChange={setYt} />}
          <label>
            {yt ? t("yt.description") : t("item.caption")}
            <textarea
              rows={6}
              value={texts.caption}
              onChange={(e) => setTexts({ ...texts, caption: e.target.value })}
            />
          </label>
          <Counter n={texts.caption.length} max={max} />
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
          {alt && !yt && (
            <label>
              {t("item.altTexts")} <span className="muted small">{t("texts.altHint")}</span>
              <textarea rows={3} value={texts.alt} onChange={(e) => setTexts({ ...texts, alt: e.target.value })} />
            </label>
          )}
          {yt && youtube && <YtExtras value={yt} onChange={setYt} files={youtube.files} />}
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
          disabled={
            busy ||
            (!noTexts &&
              // a YouTube description may be empty; an Instagram caption may not
              ((!yt && !texts.caption.trim()) || texts.caption.length > max || (!!yt && ytBlocked(yt.texts))))
          }
        >
          {busy ? t("common.saving") : submit}
        </button>
      </div>
    </div>
  );
}

export type Slot = { date: string; time: string };

export const slotsOf = (e: unknown): Slot[] =>
  e instanceof HttpError && Array.isArray(e.body.suggestions) ? (e.body.suggestions as Slot[]) : [];

/** The account's next free hours after a clash, as one-tap choices. */
export function FreeSlots({ slots, onPick }: { slots: Slot[]; onPick: (s: Slot) => void }) {
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
function ScheduleForm({
  d,
  accounts,
  info,
  onCancel,
}: {
  d: Draft;
  accounts: string[];
  info: AccountInfo;
  onCancel: () => void;
}) {
  const kind = d.kind === "reel" ? "reel" : "post";
  const [account, setAccount] = useState(accounts.includes(d.account) ? d.account : accounts[0]);
  const [date, setDate] = useState(zoneShift(1));
  const [time, setTime] = useState(kind === "reel" ? "18:00" : "19:00");
  const [name, setName] = useState(d.payload.name ?? d.id);
  const [slots, setSlots] = useState<Slot[]>([]);
  const single = (d.payload.media?.length ?? 0) === 1;
  const [story, setStory] = useState(false);
  // a YouTube channel takes a video with its title, settings and languages; its settings start at the channel's
  // defaults with the draft's own on top, and only what the form changes is sent
  const channel = info[account]?.youtube;
  const tube = kind === "reel" && !!channel;
  const start: YtState | null = channel
    ? {
        texts: { title: "", ...(d.texts ?? {}) },
        settings: { ...channel, ...((d.payload.options ?? {}) as Partial<YouTubeSettings>) },
      }
    : null;
  return (
    <TextsForm
      alt={kind === "post"}
      noTexts={story && !tube}
      youtube={tube && start ? { initial: start, files: ytFiles(d.previews ?? d.payload.files ?? []) } : null}
      initial={{
        caption: d.payload.caption ?? "",
        comment: d.payload.comment ?? "",
        comment2: d.payload.comment2 ?? "",
        alt: d.payload.alt ?? "",
      }}
      submit={story && !tube ? t("schedule.story") : t("schedule.schedule")}
      onCancel={onCancel}
      onSubmit={async (texts, yt) => {
        setSlots([]);
        const { alt: _alt, ...words } = texts;
        try {
          const r = await api<{ key: string }>(`drafts/${d.id}/schedule`, {
            account,
            date,
            time,
            name,
            ...(yt && start
              ? {
                  ...words,
                  texts: ytTexts(yt.texts),
                  options: changedSettings(yt.settings, start.settings, channel ?? start.settings),
                }
              : story
                ? { format: "story" }
                : texts),
          });
          location.hash = `#/item/${encodeURIComponent(r.key)}`;
        } catch (e) {
          setSlots(slotsOf(e));
          throw e;
        }
      }}
    >
      {single && !tube && (
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

const CHUNK = 8 * 1024 * 1024;
// a multiple of 256 KiB, as Drive's resumable uploads want

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
  const mediaFolder = useMediaFolder();
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
    // a YouTube video's subtitle files go with it by name (<lang>.srt or .vtt); phones give them no media type
    const fs = [...(list ?? [])].filter((f) => /^(image|video)\//.test(f.type) || isSubtitle(f.name)).slice(0, 10);
    setFiles(fs);
    const first = fs.find((f) => !isSubtitle(f.name) && !THUMBNAIL.test(f.name)) ?? fs[0];
    if (!name && first)
      setName(
        first.name
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
          {videoWithExtras(files.map((f) => ({ name: f.name, mime: f.type })))
            ? t("draft.youtubeVideo", {
                extras: files
                  .filter((f) => isSubtitle(f.name) || THUMBNAIL.test(f.name))
                  .map((f) => f.name)
                  .join(", "),
              })
            : files.length > 1
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
      <p className="muted small">{t("draft.uploadNote", { folder: mediaFolder })}</p>
    </div>
  );
}

export function DraftsPage() {
  const mediaFolder = useMediaFolder();
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
          {t("drafts.aboutBefore")} <code>{mediaFolder}/inbox/&lt;project&gt;/</code> {t("drafts.aboutAfter")}
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
              <div className={shownPreviews(d.previews).length > 1 ? "media carousel" : "media"}>
                {shownPreviews(d.previews).map((m) =>
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
            {d.previews?.some((m) => isSubtitle(m.name)) && (
              <p className="muted small">
                {t("yt.subtitleFile", {
                  name: d.previews
                    .filter((m) => isSubtitle(m.name))
                    .map((m) => m.name)
                    .join(", "),
                })}
              </p>
            )}
            {d.texts?.title && <p className="small">{t("drafts.ytTitle", { title: d.texts.title })}</p>}
            {d.payload.caption && <pre className="text small">{d.payload.caption}</pre>}
            {d.payload.comment && <p className="muted small">{t("drafts.selfComment", { text: d.payload.comment })}</p>}
            {d.payload.comment2 && (
              <p className="muted small">{t("drafts.secondComment", { text: d.payload.comment2 })}</p>
            )}
            {d.payload.note && <p className="small">{d.payload.note}</p>}
            <p className="muted small">
              {when(d.created_at)}
              {d.source === "drive" ? ` · ${t("drafts.driveInbox")}` : d.by ? ` · ${d.by}` : ""}
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
            {open === d.id && data && (
              <ScheduleForm
                d={d}
                accounts={data.accounts}
                info={data.accountInfo ?? {}}
                onCancel={() => setOpen(null)}
              />
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
