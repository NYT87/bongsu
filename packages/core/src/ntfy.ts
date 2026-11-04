// A workspace's ntfy topic (https://ntfy.sh or a self-hosted server), set in the dashboard: the workspace's notifications
// are also posted there. Kept encrypted in workspace_settings.notify_url: whoever knows a topic's URL can read it. Only
// owners and admins set it; Bongsu posts to it over https, follows no redirect and gives up after NTFY_TIMEOUT_MS.
import { decryptSecret, encryptSecret } from "./crypto";
import type { Env } from "./env";

const NTFY_TIMEOUT_MS = 10_000;

export class NtfyError extends Error {}

/** A topic URL as the dashboard takes it: https, no user info (a protected topic's token goes in `?auth=`). */
export function checkNtfyUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new NtfyError("the topic's address: https://ntfy.sh/<topic>, or your own server's");
  }
  if (u.protocol !== "https:") throw new NtfyError("the topic's address starts with https://");
  if (u.username || u.password || u.hash) throw new NtfyError("no user or #fragment in the address");
  if (u.pathname.split("/").filter(Boolean).length === 0) throw new NtfyError("the address ends with the topic's name");
  if (u.toString().length > 500) throw new NtfyError("the address is too long");
  return u.toString();
}

/** The workspace's topic, decrypted, or null. */
export async function workspaceNtfy(env: Env, workspaceId: string): Promise<string | null> {
  const r = await env.DB.prepare("SELECT notify_url FROM workspace_settings WHERE workspace_id = ?1")
    .bind(workspaceId)
    .first<{ notify_url: string | null }>();
  return r?.notify_url ? decryptSecret(env.ENCRYPTION_KEY, r.notify_url) : null;
}

/** Sets (a checked URL) or removes (null) the workspace's topic. */
export async function setWorkspaceNtfy(env: Env, workspaceId: string, url: string | null, nowS: number) {
  const stored = url === null ? null : await encryptSecret(env.ENCRYPTION_KEY, checkNtfyUrl(url));
  await env.DB.prepare("UPDATE workspace_settings SET notify_url = ?1, updated_at = ?2 WHERE workspace_id = ?3")
    .bind(stored, nowS, workspaceId)
    .run();
}

/** Posts one message to a topic: its title and buttons in ntfy's headers (https://docs.ntfy.sh/publish/). */
export async function postNtfy(
  fetcher: typeof fetch,
  url: string,
  m: { title: string; text: string; click: string; buttons: { label: string; url: string }[] },
): Promise<boolean> {
  // "view" buttons; labels may not contain , or ;
  const actions = m.buttons.map((x) => `view, ${x.label.replace(/[,;]/g, " ")}, ${x.url}, clear=true`).join("; ");
  const r = await fetcher(url, {
    method: "POST",
    headers: { Title: m.title, Tags: "calendar", Click: m.click, Actions: actions },
    body: m.text,
    redirect: "manual",
    signal: AbortSignal.timeout(NTFY_TIMEOUT_MS),
  });
  return r.ok;
}
