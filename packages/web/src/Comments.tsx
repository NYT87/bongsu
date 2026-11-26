// The Comments tab: new comments on the posts and videos, answered from here.

import { useEffect, useState } from "react";
import { api } from "./api";
import { ErrorNote, ICON, nice, useLoad, useShared, utcToZone } from "./common";
import { t } from "./i18n";

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
export function CommentsPage() {
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
