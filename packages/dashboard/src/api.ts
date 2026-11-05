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
/** The dashboard moved to another path (App's `go`): pages that read more of the path than the section follow it. */
export const NAVIGATED = "bongsu:navigated";

/** Whether this person manages the workspace (its admin, or an instance admin): an editor doesn't see its
 *  connections, agent keys or settings. */
export const manages = (state: State) => state.instanceAdmin || state.role === "admin";

/** Something the sidebar shows changed (the workspace's name or icon): App loads the state again. */
export const STATE_STALE = "bongsu:state-stale";

async function request<T>(path: string, init: { method: string; headers: Record<string, string>; body?: BodyInit }) {
  const r = await fetch(`/admin-api/${path}`, { ...init, credentials: "same-origin" });
  const data = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (r.status === 403 && data.app === true) dispatchEvent(new Event(APP_ONLY));
  if (!r.ok) throw new ApiError(r.status, String(data.error ?? r.statusText), data);
  return data as T;
}

export const api = <T = Record<string, unknown>>(path: string, body?: unknown, method?: "PUT" | "DELETE") =>
  request<T>(path, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

/** Sends a file as the raw body (the workspace icon): the content type is the file's own. */
export const apiFile = <T = Record<string, unknown>>(path: string, file: File, method: "PUT") =>
  request<T>(path, { method, headers: { "Content-Type": file.type }, body: file });

/** Opens a workspace in this session (the server refuses one the person can't open). */
export const switchWorkspace = (id: string) => api("session/workspace", { id });

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
