// Devices: the phones and passkeys that can sign in and approve.

import { startRegistration } from "@simplewebauthn/browser";
import { useEffect, useState } from "react";
import { api, when, withFreshCheck } from "../api";
import { Card, Loading, Page, Pill, QrCode, SecretOnce, useConfirm, useLoad, useToast } from "../ui";
import { errorText, type Props } from "./common";

// ---- Devices & passkeys

interface Passkeys {
  passkeys: { id: string; short: string; name: string | null; created_at: number; last_used_at: number | null }[];
  devices: { device: string | null; created_at: number }[];
  alertMail: boolean;
}

interface DeviceCode {
  id: string;
  code: string;
  link: string;
  expiresAt: number;
}

export function Devices({ state }: Props) {
  const toast = useToast();
  const { data, error, reload } = useLoad<Passkeys>("passkeys");
  const [err, setErr] = useState<string | null>(null);
  const [device, setDevice] = useState<DeviceCode | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const { confirm, dialog } = useConfirm();
  const run = async (fn: () => Promise<void>) => {
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(errorText(e));
    }
  };
  const addPasskey = () =>
    run(async () => {
      const name = window.prompt("Name this passkey (e.g. the computer or key)", "Laptop");
      if (name === null) return;
      await withFreshCheck(async () => {
        const o = await api<{ options: never; challengeId: string }>("passkeys/options", {});
        const response = await startRegistration({ optionsJSON: o.options });
        await api("passkeys/verify", { challengeId: o.challengeId, response, name });
      });
      toast({ ok: true, text: `Passkey "${name}" added.` });
      reload();
    });
  return (
    <Page
      title="Devices & passkeys"
      intro="Your devices approve posts in the Bongsu app; your passkeys sign you in here and in the app."
    >
      {err && (
        <p className="error" role="alert">
          {err}
        </p>
      )}
      <Card
        title="Add a device"
        actions={
          !device && (
            <button
              type="button"
              className="primary"
              onClick={() => run(async () => setDevice(await withFreshCheck(() => api<DeviceCode>("devices", {}))))}
            >
              Add a device
            </button>
          )
        }
      >
        {device ? (
          <DeviceSetup
            device={device}
            onDone={() => {
              setDevice(null);
              reload();
            }}
          />
        ) : (
          <p className="muted">
            Shows a QR code: scan it with the device's camera (a phone or tablet), then it creates its own passkey and
            gets the app.
          </p>
        )}
      </Card>
      <Card
        title="Passkeys"
        actions={
          <button type="button" onClick={addPasskey}>
            Add a passkey here
          </button>
        }
      >
        {!data ? (
          <Loading error={error} retry={reload} />
        ) : (
          <div className="table-wrap">
            <table className="stack">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Added</th>
                  <th>Last used</th>
                  <th className="right">
                    <span className="vh">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.passkeys.map((k) => (
                  <tr key={k.id}>
                    <td>
                      {k.name ?? "passkey"} <span className="muted small mono">{k.short}</span>
                    </td>
                    <td data-label="Added" className="small">
                      {when(k.created_at)}
                    </td>
                    <td data-label="Last used" className="small">
                      {when(k.last_used_at)}
                    </td>
                    <td className="right">
                      <button
                        type="button"
                        className="link"
                        onClick={() => {
                          const name = window.prompt("Rename the passkey", k.name ?? "");
                          if (name)
                            run(async () => {
                              await api(`passkeys/${encodeURIComponent(k.id)}/rename`, { name });
                              reload();
                            });
                        }}
                      >
                        Rename
                      </button>
                      <button
                        type="button"
                        className="link danger"
                        aria-disabled={data.passkeys.length <= 1}
                        title={data.passkeys.length <= 1 ? "Your only passkey: add another one first" : undefined}
                        onClick={() =>
                          data.passkeys.length <= 1
                            ? toast({
                                ok: false,
                                text: "That's your only passkey: add another one (or another device) before removing it.",
                              })
                            : confirm({
                                title: `Remove "${k.name ?? "passkey"}"?`,
                                detail:
                                  "That device can't sign in with it any more (the Bongsu app there stops working too).",
                                verb: "Remove",
                                run: async () => {
                                  await withFreshCheck(() => api(`passkeys/${encodeURIComponent(k.id)}/revoke`, {}));
                                  toast({ ok: true, text: `Passkey "${k.name ?? k.short}" removed.` });
                                  reload();
                                },
                              })
                        }
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data && data.devices.length > 0 && (
          <p className="muted small">
            Devices getting notifications: {data.devices.map((d) => d.device ?? "a device").join(", ")}.
          </p>
        )}
      </Card>
      <Card
        title="Recovery codes"
        actions={
          !codes && (
            <button
              type="button"
              onClick={() =>
                confirm({
                  title: "Make new recovery codes?",
                  detail: "The codes you have now stop working.",
                  verb: "Make new codes",
                  run: async () => {
                    const r = await withFreshCheck(() => api<{ recoveryCodes: string[] }>("recovery-codes", {}));
                    setCodes(r.recoveryCodes);
                  },
                })
              }
            >
              Make new codes
            </button>
          )
        }
      >
        {codes ? (
          <SecretOnce title="Your new recovery codes" lines={codes} onDone={() => setCodes(null)} />
        ) : (
          <p className="muted">Each signs you in once when every passkey is lost.</p>
        )}
      </Card>
      {data && <AlertMailCard on={data.alertMail} onSaved={reload} />}
      {state.workspace && (
        <Card title={`Leave ${state.workspace.name}`}>
          <p className="muted">
            You stop working in it at once, in the dashboard and the app: its pages, its notifications and your CLI
            tokens for it. An admin can invite you again. Its last admin can't leave: make someone else admin first.
          </p>
          <div className="actions">
            <button
              type="button"
              className="danger"
              onClick={() =>
                confirm({
                  title: `Leave ${state.workspace?.name}?`,
                  detail: "You stop working in it at once. An admin can invite you again.",
                  verb: "Leave",
                  // a refusal (the last admin) shows in the dialog; leaving reloads in the next workspace, or none
                  run: async () => {
                    await api("session/leave", {});
                    location.assign("/dashboard/");
                  },
                })
              }
            >
              Leave this workspace
            </button>
          </div>
        </Card>
      )}
      {dialog}
    </Page>
  );
}

/** The QR code and the code itself; polls until the device has used it (or it expires). */
function DeviceSetup({ device, onDone }: { device: DeviceCode; onDone: () => void }) {
  const [status, setStatus] = useState<"waiting" | "used" | "expired">("waiting");
  useEffect(() => {
    if (status !== "waiting") return;
    const t = setInterval(() => {
      api<{ used: boolean; expired: boolean }>(`devices/${device.id}`)
        .then((r) => setStatus(r.used ? "used" : r.expired ? "expired" : "waiting"))
        .catch(() => {});
    }, 3000);
    return () => clearInterval(t);
  }, [device.id, status]);
  if (status === "used")
    return (
      <div role="status">
        <p>
          <Pill status="ok" label="Connected" /> The device has its passkey.
        </p>
        <button type="button" className="primary" onClick={onDone}>
          Done
        </button>
      </div>
    );
  if (status === "expired")
    return (
      <div role="status">
        <p className="error">The code expired before the device used it.</p>
        <button type="button" onClick={onDone}>
          Close
        </button>
      </div>
    );
  return (
    <div className="device-setup">
      <QrCode text={device.link} label="QR code that opens the Bongsu app on the device" />
      <div>
        <ol>
          <li>Open the device's camera and point it at the code.</li>
          <li>Open the link, then create the passkey when asked.</li>
          <li>Add the app to the home screen to get notifications.</li>
        </ol>
        <p className="muted small">
          Or open <span className="mono">{device.link.split("/#")[0]}</span> on the device and enter{" "}
          <span className="mono">{device.code}</span>. It works once, until {when(device.expiresAt)}.
        </p>
        <p className="small" aria-live="polite">
          <Pill status="waiting" label="Waiting for the device…" />
        </p>
        <button type="button" className="link" onClick={onDone}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** The person's own switch for the alert emails: a connection or a media store that broke, for the workspaces they
 *  admin and the instance alike. The dashboard and the app still show those notices. */
function AlertMailCard({ on, onSaved }: { on: boolean; onSaved: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const save = async (next: boolean) => {
    setBusy(true);
    setErr(null);
    try {
      await api("alert-mail", { on: next });
      onSaved();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Alert emails">
      <p className="muted">
        When a connection or a media store you look after breaks, an email tells you, if this instance sends email.
        Turned off, you still see the notice here and in the app.
      </p>
      <label className="check">
        <input type="checkbox" checked={on} disabled={busy} onChange={(e) => save(e.target.checked)} /> Email me these
        alerts
      </label>
      {err && (
        <p className="error" role="alert">
          {err}
        </p>
      )}
    </Card>
  );
}
