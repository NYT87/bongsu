// Get started: the steps from a new instance to the first scheduled post.

import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { api } from "../api";
import { Card, Field, Loading, Page, Pill, useLoad, useToast } from "../ui";
import { errorText, HOURS, type Props } from "./common";
import type { Overview } from "./Overview";

/** The first run, step by step: each step's state comes from the data (overview's `setup`), so the page is right
 *  whatever was done elsewhere, and there's nothing to dismiss. */

// One numbered step of Get started. At module level: defined inside the page, it would be a new component on every
// render and remount its fields (losing focus while typing).
function Step({ n, title, done, children }: { n: number; title: string; done: boolean; children: ReactNode }) {
  return (
    <Card
      title={`${n}. ${title}`}
      actions={done ? <Pill status="ok" label="Done" /> : <Pill status="waiting" label="To do" />}
    >
      {children}
    </Card>
  );
}

/** A Get started step that's the instance's (OAuth apps, media stores): its instance admin's to set up, for every
 *  workspace, so a workspace's admin has nothing to open there. */
const InstanceStep = () => (
  <p className="muted small">Your instance admin sets this up, for every workspace: ask them if it's still to do.</p>
);

export function GetStarted({ state, go }: Props) {
  const { data, error, reload } = useLoad<Overview>("overview");
  const settings = useLoad<{ timezone: string; digestHour: number }>("settings");
  const toast = useToast();
  const [tz, setTz] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [hour, setHour] = useState(8);
  // Once chosen, the form shows the saved zone; before that, this browser's as a suggestion.
  useEffect(() => {
    if (data?.setup.timezone && settings.data) {
      setTz(settings.data.timezone);
      setHour(settings.data.digestHour);
    }
  }, [data?.setup.timezone, settings.data]);
  const [err, setErr] = useState<string | null>(null);
  const zones = Intl.supportedValuesOf?.("timeZone") ?? [];
  const saveZone = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    try {
      await api("settings", { timezone: tz, digestHour: hour });
      toast({ ok: true, text: `Time zone set: ${tz}.` });
      reload();
    } catch (e) {
      setErr(errorText(e));
    }
  };
  return (
    <Page
      title="Get started"
      intro="Five steps from here to your first approved post. Each one can also be done later from its own page."
    >
      {!data ? (
        <Loading error={error} retry={reload} />
      ) : (
        <>
          <Step n={1} title="Your time zone" done={data.setup.timezone}>
            <p className="muted">
              Times in the dashboard, the app and the daily digest use it. Each person can pick their own later.
            </p>
            <form onSubmit={saveZone} className="inline-form">
              <Field label="Time zone">
                {(p) => (
                  <select {...p} value={tz} onChange={(e) => setTz(e.target.value)}>
                    {(zones.includes(tz) ? zones : [tz, ...zones]).map((z) => (
                      <option key={z}>{z}</option>
                    ))}
                  </select>
                )}
              </Field>
              <Field label="Daily digest">
                {(p) => (
                  <select {...p} value={hour} onChange={(e) => setHour(Number(e.target.value))}>
                    {HOURS.map((h) => (
                      <option key={h} value={h}>
                        {String(h).padStart(2, "0")}:00
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <div className="actions">
                {err && (
                  <span className="error" role="alert">
                    {err}
                  </span>
                )}
                <button className={data.setup.timezone ? "" : "primary"} type="submit">
                  {data.setup.timezone ? "Save again" : "Save"}
                </button>
              </div>
            </form>
          </Step>
          <Step n={2} title="Your OAuth apps" done={data.setup.oauthApp}>
            <p className="muted">
              Bongsu talks to Instagram and YouTube through apps you own: paste a Meta app for Instagram and a Google
              app for YouTube (the page shows the exact redirect URLs to register). Connecting through Composio needs
              neither.
            </p>
            {state.instanceAdmin ? (
              <div className="actions">
                <button type="button" className={data.setup.oauthApp ? "" : "primary"} onClick={() => go("admin/apps")}>
                  Open OAuth apps
                </button>
              </div>
            ) : (
              <InstanceStep />
            )}
          </Step>
          <Step n={3} title="Where your media live" done={data.setup.mediaStore}>
            <p className="muted">
              Your Reels and photos stay in a store you control: Google Drive, an S3-compatible bucket (AWS, R2, B2,
              MinIO) or, with Docker, this server's disk. Bongsu reads them from there and publishes them.
            </p>
            {state.instanceAdmin ? (
              <div className="actions">
                <button
                  type="button"
                  className={data.setup.oauthApp && !data.setup.mediaStore ? "primary" : ""}
                  onClick={() => go("admin/media")}
                >
                  Open Media
                </button>
              </div>
            ) : (
              <InstanceStep />
            )}
          </Step>
          <Step n={4} title="Connect an account" done={data.setup.connection}>
            <p className="muted">An Instagram account or a YouTube channel to publish to.</p>
            <div className="actions">
              <button
                type="button"
                className={data.setup.mediaStore && !data.setup.connection ? "primary" : ""}
                onClick={() => go("connections")}
              >
                Open Connections
              </button>
            </div>
          </Step>
          <Step n={5} title="Add the device you approve on" done={data.setup.device}>
            <p className="muted">
              Approving happens in the Bongsu app, with a passkey: add your phone (or another device) and turn on its
              notifications.
            </p>
            <div className="actions">
              <button
                type="button"
                className={data.setup.connection && !data.setup.device ? "primary" : ""}
                onClick={() => go("devices")}
              >
                Open Devices &amp; passkeys
              </button>
            </div>
          </Step>
          <Card title="Then: dry run, and going live">
            <p className="muted">
              {data.dryRun
                ? "This instance is in dry run: every step runs and notifies you, but nothing is published. Try a post end to end, then go live from Settings."
                : "This instance is live: approved posts are published at their time."}
            </p>
            <div className="actions">
              <button type="button" onClick={() => go("settings")}>
                Open Settings
              </button>
              <button type="button" className="link" onClick={() => go("")}>
                Go to the overview
              </button>
            </div>
          </Card>
        </>
      )}
    </Page>
  );
}
