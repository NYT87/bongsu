// Web Push to the owner's installed app (RFC 8291 encryption + VAPID, @block65/webcrypto-web-push). A subscription
// the push service no longer knows (404/410) is deleted; the app subscribes again when opened.
import { buildPushPayload, type PushSubscription } from "@block65/webcrypto-web-push";
import type { Env } from "./env";

export interface PushNote {
  title: string;
  body: string;
  url?: string;
  tag?: string;
  actions?: { action: string; title: string; url: string }[];
}

export async function sendPush(
  env: Env,
  fetcher: typeof fetch,
  note: PushNote,
  nowS: number,
): Promise<{ sent: number; removed: number }> {
  if (!env.VAPID_PRIVATE_KEY || !env.VAPID_PUBLIC_KEY) return { sent: 0, removed: 0 };
  const subs = await env.DB.prepare("SELECT id, endpoint, p256dh, auth FROM push_subs").all<{
    id: number;
    endpoint: string;
    p256dh: string;
    auth: string;
  }>();
  const vapid = { subject: env.VAPID_SUBJECT, publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY };
  let sent = 0,
    removed = 0;
  for (const s of subs.results) {
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
      const r = await fetcher(s.endpoint, payload as unknown as RequestInit);
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
