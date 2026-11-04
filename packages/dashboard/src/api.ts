// The dashboard's calls to /admin-api. A 403 with `verify: true` means "confirm with your passkey first": callers
// run verifyPasskey() and retry (withFreshCheck does both). A 403 with `app: true` means a creator, who uses the app:
// it's announced with the APP_ONLY event, and App shows the pointer to the app.
import { startAuthentication } from "@simplewebauthn/browser";
import type { State } from "./App";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public data: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export const APP_ONLY = "bongsu:app-only";

/** Whether this person manages the workspace (its admin, or an instance admin): an editor doesn't see its
 *  connections, agent keys or settings. */
export const manages = (state: State) => state.instanceAdmin || state.role === "admin";

export async function api<T = Record<string, unknown>>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(`/admin-api/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
  });
  const data = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (r.status === 403 && data.app === true) dispatchEvent(new Event(APP_ONLY));
  if (!r.ok) throw new ApiError(r.status, String(data.error ?? r.statusText), data);
  return data as T;
}

/** A fresh passkey check on this session (for changes to who can do what). */
export async function verifyPasskey() {
  const o = await api<{ options: never; challengeId: string }>("verify/options", {});
  const response = await startAuthentication({ optionsJSON: o.options });
  await api("verify/verify", { challengeId: o.challengeId, response });
}

/** Runs a call; when the server asks for a fresh passkey check, does it and runs the call again. */
export async function withFreshCheck<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (e) {
    if (e instanceof ApiError && e.status === 403 && e.data.verify) {
      await verifyPasskey();
      return call();
    }
    throw e;
  }
}

export const when = (unix: number | null | undefined) =>
  unix ? new Date(unix * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "never";
