// Overview: the instance at a glance and what's left to set up.

import { manages } from "../api";
import { Card, Loading, Page, useLoad } from "../ui";
import type { Props } from "./common";

// ---- Overview

export interface Overview {
  dryRun: boolean;
  accounts: number;
  connections: Record<string, number>;
  keys: number;
  passkeys: number;
  recoveryCodesLeft: number;
  waitingApproval: number;
  setup: Setup;
}

interface Setup {
  timezone: boolean;
  oauthApp: boolean;
  mediaStore: boolean;
  connection: boolean;
  device: boolean;
}

const setupDone = (s: Setup) => Object.values(s).filter(Boolean).length;

const SETUP_STEPS = 5;

export function Overview({ state, go }: Props) {
  const { data, error, reload } = useLoad<Overview>("overview");
  // an editor sees the numbers; setting up and the connections are the admins' (an editor can't open those pages)
  const admin = manages(state);
  const conns = data ? Object.values(data.connections).reduce((a, b) => a + b, 0) : 0;
  const broken = (data?.connections.broken ?? 0) + (data?.connections.expiring ?? 0);
  return (
    <Page title="Overview" intro="What this instance publishes with, and what needs you.">
      {!data ? (
        <Loading error={error} retry={reload} />
      ) : (
        <div className="overview">
          {admin && setupDone(data.setup) < SETUP_STEPS && (
            <div className="banner setup" role="status">
              <span>
                <strong>Finish setting up:</strong> {setupDone(data.setup)} of {SETUP_STEPS} done.
              </span>
              <button type="button" className="primary" onClick={() => go("start")}>
                Continue
              </button>
            </div>
          )}
          <div className="grid stats">
            <Stat label="Accounts" value={data.accounts} onClick={() => go("accounts")} />
            <Stat
              label="Connections"
              value={conns}
              note={broken ? `${broken} need attention` : undefined}
              onClick={admin ? () => go("connections") : undefined}
            />
            <Stat label="Waiting for approval" value={data.waitingApproval} note="Approve in the Bongsu app" />
            <Stat label="Agent keys" value={data.keys} onClick={() => go("keys")} />
          </div>
          <Card title="Needs you">
            <ul className="todo">
              {admin && conns === 0 && (
                <Todo
                  text="Connect an account to publish to."
                  action="Connect an account"
                  onClick={() => go("connections")}
                />
              )}
              {admin && broken > 0 && (
                <Todo
                  text={`${broken} connection(s) are expiring or broken.`}
                  action="Reconnect"
                  onClick={() => go("connections")}
                />
              )}
              {data.passkeys < 2 && (
                <Todo
                  text="Add a second passkey or another device, so losing one doesn't lock you out."
                  action="Add a passkey"
                  onClick={() => go("devices")}
                />
              )}
              {data.recoveryCodesLeft < 3 && (
                <Todo
                  text={
                    data.recoveryCodesLeft
                      ? `Only ${data.recoveryCodesLeft} recovery codes left: make new ones.`
                      : "No recovery codes left: make new ones."
                  }
                  action="Make new codes"
                  onClick={() => go("devices")}
                />
              )}
              {/* Dry run isn't repeated here: the banner above every page says it. */}
              {(!admin || (conns > 0 && !broken)) && data.passkeys >= 2 && data.recoveryCodesLeft >= 3 && (
                <li className="muted">Nothing: all good.</li>
              )}
            </ul>
          </Card>
        </div>
      )}
    </Page>
  );
}

function Stat({ label, value, note, onClick }: { label: string; value: number; note?: string; onClick?: () => void }) {
  // The label row is the same in every card (with or without "View"), so the numbers line up.
  const inner = (
    <>
      <div className="stat-head">
        <span className="muted small">{label}</span>
        {onClick && (
          <span className="go" aria-hidden="true">
            View
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              aria-hidden="true"
            >
              <path d="m9 6 6 6-6 6" />
            </svg>
          </span>
        )}
      </div>
      <div className="stat">{value}</div>
      {note && <div className="small muted">{note}</div>}
    </>
  );
  return onClick ? (
    <button type="button" className="card stat-card" onClick={onClick}>
      {inner}
    </button>
  ) : (
    <div className="card stat-card">{inner}</div>
  );
}

const Todo = ({ text, action, onClick }: { text: string; action?: string; onClick?: () => void }) => (
  <li>
    {text}{" "}
    {onClick && (
      <button type="button" className="link" onClick={onClick}>
        {action}
      </button>
    )}
  </li>
);
