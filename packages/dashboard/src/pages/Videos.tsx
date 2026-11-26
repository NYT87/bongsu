// Videos: a channel's scheduled YouTube videos and their release dates.

import { useState } from "react";
import { api, withFreshCheck } from "../api";
import { Card, Field, Loading, Page, Pill, useLoad, useToast } from "../ui";
import { errorText, type Props } from "./common";

// ---- Videos

interface VideoRow {
  id: string;
  title: string;
  short: boolean;
  status: "public" | "scheduled" | "private" | "unlisted";
  when: string | null;
  url: string;
}

interface VideoList {
  channels: { id: string; name: string; videos: VideoRow[] }[];
  warnings: string[];
}

export function Videos(_: Props) {
  const toast = useToast();
  const [path, setPath] = useState("videos");
  const { data, error, reload } = useLoad<VideoList>(path);
  const [editing, setEditing] = useState<string | null>(null);
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // "Check YouTube now" reads past the hour's cache; the next plain load goes back to it
  const check = () => (path === "videos?refresh=1" ? reload() : setPath("videos?refresh=1"));
  const start = (v: VideoRow) => {
    setEditing(v.id);
    setErr(null);
    const [d, t] = (v.when ?? "").split(" ");
    setDate(d ?? "");
    setTime(t ?? "");
  };
  const save = async (v: VideoRow) => {
    setBusy(true);
    setErr(null);
    try {
      const r = await withFreshCheck(() =>
        api<{ due: string }>(`videos/${encodeURIComponent(v.id)}/release`, { date, time }),
      );
      toast({ ok: true, text: `Moved to ${r.due}.` });
      setEditing(null);
      // a plain load again: it ends "Check YouTube now"'s read past the cache
      if (path === "videos") reload();
      else setPath("videos");
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Page title="Videos" intro="Each YouTube channel's uploads. A scheduled video's release date can move from here.">
      {!data ? (
        <Loading error={error} retry={reload} />
      ) : (
        <>
          <div className="actions">
            <button type="button" onClick={check}>
              Check YouTube now
            </button>
          </div>
          {data.warnings.map((w) => (
            <p key={w} className="error" role="alert">
              {w}
            </p>
          ))}
          {data.channels.length === 0 && (
            <Card>
              <p className="empty">No YouTube channel connected yet.</p>
            </Card>
          )}
          {data.channels.map((ch) => (
            <Card key={ch.id} title={ch.name}>
              {ch.videos.length === 0 ? (
                <p className="empty">No uploads found.</p>
              ) : (
                <div className="table-wrap">
                  <table className="stack">
                    <thead>
                      <tr>
                        <th>Title</th>
                        <th>Kind</th>
                        <th>State</th>
                        <th>When</th>
                        <th className="right">
                          <span className="vh">Actions</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {ch.videos.map((v) => (
                        <tr key={v.id}>
                          <td>
                            <a href={v.url} target="_blank" rel="noreferrer">
                              {v.title}
                            </a>
                          </td>
                          <td data-label="Kind">{v.short ? "Short" : "Video"}</td>
                          <td data-label="State">
                            <Pill status={v.status} />
                          </td>
                          <td data-label="When">{v.when ?? "—"}</td>
                          <td className="right">
                            {v.status !== "scheduled" ? null : editing === v.id ? (
                              <form
                                className="row"
                                onSubmit={(e) => {
                                  e.preventDefault();
                                  save(v);
                                }}
                              >
                                <Field label="Date">
                                  {(p) => (
                                    <input
                                      {...p}
                                      type="date"
                                      required
                                      value={date}
                                      onChange={(e) => setDate(e.target.value)}
                                    />
                                  )}
                                </Field>
                                <Field label="Time">
                                  {(p) => (
                                    <input
                                      {...p}
                                      type="time"
                                      required
                                      value={time}
                                      onChange={(e) => setTime(e.target.value)}
                                    />
                                  )}
                                </Field>
                                <button className="primary" type="submit" aria-disabled={busy}>
                                  Save
                                </button>
                                <button type="button" className="link" onClick={() => setEditing(null)}>
                                  Cancel
                                </button>
                                {err && (
                                  <p className="error" role="alert">
                                    {err}
                                  </p>
                                )}
                              </form>
                            ) : (
                              <button type="button" className="link" onClick={() => start(v)}>
                                Change date
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          ))}
        </>
      )}
    </Page>
  );
}
