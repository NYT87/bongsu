// Audit: what happened in the workspace, and who did it.

import { useEffect, useState } from "react";
import { api, when } from "../api";
import { Card, Loading, Page } from "../ui";
import type { Props } from "./common";

// ---- Audit

interface Entry {
  id: number;
  at: number;
  actor: string;
  action: string;
  target: string | null;
  detail: string | null;
  /** The person who acted (name, else email), when a person did. */
  who: string | null;
}

export function Audit({ state }: Props) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState(true);
  // the workspace's log, or (instance admins only) the instance's: new workspaces, media stores, OAuth apps, instance
  // admins. In no workspace, only the instance's.
  const [instance, setInstance] = useState(state.noWorkspace);
  const load = (before?: number) => {
    const q = new URLSearchParams({
      ...(before ? { before: String(before) } : {}),
      ...(instance ? { instance: "1" } : {}),
    }).toString();
    return api<{ entries: Entry[] }>(`audit${q ? `?${q}` : ""}`)
      .then((r) => {
        setEntries((old) => (before ? [...(old ?? []), ...r.entries] : r.entries));
        setMore(r.entries.length === 50);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: reloads when the log shown changes
  useEffect(() => {
    setEntries(null);
    load();
  }, [instance]);
  return (
    <Page
      title="Audit"
      intro={
        instance
          ? "Every change to this instance: who, what, when."
          : "Every change to this workspace: who, what, when."
      }
    >
      <Card
        actions={
          state.instanceAdmin &&
          !state.noWorkspace && (
            <select
              aria-label="Which log"
              value={instance ? "instance" : "workspace"}
              onChange={(e) => setInstance(e.target.value === "instance")}
            >
              <option value="workspace">This workspace</option>
              <option value="instance">The instance</option>
            </select>
          )
        }
      >
        {!entries ? (
          <Loading error={error} retry={() => load()} />
        ) : entries.length === 0 ? (
          <p className="empty">Nothing yet.</p>
        ) : (
          <>
            <div className="table-wrap">
              <table className="stack">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Who</th>
                    <th>What</th>
                    <th>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((e) => (
                    <tr key={e.id}>
                      <td data-label="When" className="small nowrap">
                        {when(e.at)}
                      </td>
                      <td data-label="Who" className="small">
                        {e.who ?? e.actor}
                      </td>
                      <td data-label="What">
                        {e.action.replaceAll("_", " ")}
                        {e.target && <div className="muted small mono">{e.target}</div>}
                      </td>
                      <td data-label="Detail" className="small mono muted">
                        {e.detail && e.detail !== "{}" ? e.detail : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {more && (
              <div className="actions">
                <button type="button" onClick={() => load(entries[entries.length - 1]?.id)}>
                  Load older
                </button>
              </div>
            )}
          </>
        )}
      </Card>
    </Page>
  );
}
