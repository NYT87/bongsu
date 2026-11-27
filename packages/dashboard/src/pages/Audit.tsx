// Audit: what happened in the workspace, and who did it; in the admin dashboard, the instance's or any workspace's.

import { useEffect, useState } from "react";
import { api, when } from "../api";
import { Card, Loading, Page, useLoad } from "../ui";
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

/** One log, newest first, 50 at a time: `query` names it (none: the session's workspace). */
function AuditLog({ query }: { query: Record<string, string> }) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState(true);
  const load = (before?: number) => {
    const q = new URLSearchParams({ ...query, ...(before ? { before: String(before) } : {}) }).toString();
    return api<{ entries: Entry[] }>(`audit${q ? `?${q}` : ""}`)
      .then((r) => {
        setEntries((old) => (before ? [...(old ?? []), ...r.entries] : r.entries));
        setMore(r.entries.length === 50);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: loads once; another log is another AuditLog (its key)
  useEffect(() => {
    load();
  }, []);
  return (
    <>
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
    </>
  );
}

/** The workspace's own log. */
export function Audit(_: Props) {
  return (
    <Page title="Audit" intro="Every change to this workspace: who, what, when.">
      <Card>
        <AuditLog query={{}} />
      </Card>
    </Page>
  );
}

/** The admin dashboard's Audit: the instance's own log (new workspaces, media stores, OAuth apps, instance admins), or
 *  any workspace's, picked here. None is picked at first. */
export function AdminAudit(_: Props) {
  const { data } = useLoad<{ workspaces: { id: string; name: string }[] }>("workspaces");
  const [workspace, setWorkspace] = useState("");
  return (
    <Page
      title="Audit"
      intro={
        workspace
          ? "Every change to this workspace: who, what, when."
          : "Every change to this instance: who, what, when. Pick a workspace to read its log."
      }
    >
      <Card
        actions={
          <select aria-label="Workspace" value={workspace} onChange={(e) => setWorkspace(e.target.value)}>
            <option value="">No workspace: the instance</option>
            {data?.workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        }
      >
        <AuditLog key={workspace} query={workspace ? { workspace } : { instance: "1" }} />
      </Card>
    </Page>
  );
}
