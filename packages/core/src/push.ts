// Web Push to the installed app (RFC 8291 encryption + VAPID, @block65/webcrypto-web-push). Each subscription belongs
// to the user who made it and the workspace they made it in; a notification goes only to that workspace's devices
// whose user is still a member of it. A subscription the push service no longer knows (404/410) is deleted; the app
// subscribes again when opened.
//
// The endpoint is a URL the browser gave, so Bongsu only sends to the browsers' push services (PUSH_HOSTS), follows no
// redirect and gives up after PUSH_TIMEOUT_MS: a member can't point Bongsu's requests at another server.
import { buildPushPayload, type PushSubscription } from "@block65/webcrypto-web-push";
import type { Env } from "./env";

export interface PushNote {
  title: string;
  body: string;
  url?: string;
  tag?: string;
  actions?: { action: string; title: string; url: string }[];
}

/** Who a push goes to: a workspace's devices, or (a test) one user's devices in it. */
export type PushAudience = { workspaceId: string; userId?: string };

/** The push services the browsers use: Chrome and Edge's FCM, Firefox's autopush, Safari's, Windows' WNS. */
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /\.push\.services\.mozilla\.com$/,
  /\.push\.apple\.com$/,
  /\.notify\.windows\.com$/,
];
const PUSH_TIMEOUT_MS = 10_000;

/** Whether an endpoint is one of the browsers' push services (https, the default port, a known host). */
export function isPushEndpoint(endpoint: string): boolean {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.port !== "" || u.username || u.password) return false;
  return PUSH_HOSTS.some((h) => h.test(u.hostname));
}

export async function sendPush(
  env: Env,
  fetcher: typeof fetch,
  note: PushNote,
  nowS: number,
  to: PushAudience,
): Promise<{ sent: number; removed: number }> {
  if (!env.VAPID_PRIVATE_KEY || !env.VAPID_PUBLIC_KEY) return { sent: 0, removed: 0 };
  const member = "EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = s.user_id AND m.workspace_id = s.workspace_id)";
  const q = to.userId
    ? env.DB.prepare(
        `SELECT s.id, s.endpoint, s.p256dh, s.auth FROM push_subs s WHERE s.workspace_id = ?1 AND s.user_id = ?2 AND ${member}`,
      ).bind(to.workspaceId, to.userId)
    : env.DB.prepare(
        `SELECT s.id, s.endpoint, s.p256dh, s.auth FROM push_subs s WHERE s.workspace_id = ?1 AND ${member}`,
      ).bind(to.workspaceId);
  const subs = await q.all<{ id: number; endpoint: string; p256dh: string; auth: string }>();
  const vapid = { subject: env.VAPID_SUBJECT, publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY };
  let sent = 0,
    removed = 0;
  for (const s of subs.results) {
    // stored before endpoints were checked: not sent to, and dropped
    if (!isPushEndpoint(s.endpoint)) {
      await env.DB.prepare("DELETE FROM push_subs WHERE id = ?1").bind(s.id).run();
      removed++;
      continue;
    }
    const sub: PushSubscription = {
      endpoint: s.endpoint,
      expirationTime: null,
      keys: { p256dh: s.p256dh, auth: s.auth },
    };
    try {
      const payload = await buildPushPayload(
        { data: { ...note }, options: { ttl: 3600, urgency: "high" } },
        sub,
        vapid,
      );
      const r = await fetcher(s.endpoint, {
        ...(payload as unknown as RequestInit),
        redirect: "manual",
        signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
      });
      if (r.status === 404 || r.status === 410) {
        await env.DB.prepare("DELETE FROM push_subs WHERE id = ?1").bind(s.id).run();
        removed++;
      } else if (r.ok) {
        await env.DB.prepare("UPDATE push_subs SET last_ok_at = ?1 WHERE id = ?2").bind(nowS, s.id).run();
        sent++;
      } else {
        console.log(`push ${s.id}: ${r.status} ${(await r.text()).slice(0, 200)}`);
      }
    } catch (e) {
      console.log(`push ${s.id} failed: ${e}`);
    }
  }
  return { sent, removed };
}
