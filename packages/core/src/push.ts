// Web Push to the installed app (RFC 8291 encryption + VAPID, @block65/webcrypto-web-push). A subscription is one
// device of the user who made it, in no particular workspace. A note about a workspace goes to the devices of its
// members whose setting for the note's group is on (notify-prefs.ts `receivers`: members only, so an instance admin
// who isn't one gets nothing); the test push goes to one user's devices. A subscription the push service no longer
// knows (404/410) is deleted; the app subscribes again when opened.
//
// The endpoint is a URL the browser gave, so Bongsu only sends to the browsers' push services (PUSH_HOSTS), follows no
// redirect and gives up after PUSH_TIMEOUT_MS: a member can't point Bongsu's requests at another server.
import { buildPushPayload, type PushSubscription } from "@block65/webcrypto-web-push";
import type { Env } from "./env";
import { type NoteGroup, receivers } from "./notify-prefs";

export interface PushNote {
  title: string;
  body: string;
  url?: string;
  tag?: string;
  actions?: { action: string; title: string; url: string }[];
}

/** Who a push goes to: the members of a workspace who get the group, or (the test push) one user's devices. */
export type PushAudience = { workspaceId: string; group: NoteGroup } | { userId: string };

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

type Sub = { id: number; endpoint: string; p256dh: string; auth: string; user_id: string };
/** D1 binds at most 100 parameters to a statement, and a workspace can have more members. */
const IN_CHUNK = 90;

/** Every device of these users. */
async function devicesOf(env: Env, users: string[]): Promise<Sub[]> {
  const out: Sub[] = [];
  for (let i = 0; i < users.length; i += IN_CHUNK) {
    const part = users.slice(i, i + IN_CHUNK);
    const r = await env.DB.prepare(
      `SELECT id, endpoint, p256dh, auth, user_id FROM push_subs WHERE user_id IN (${part.map((_, j) => `?${j + 1}`).join(", ")})`,
    )
      .bind(...part)
      .all<Sub>();
    out.push(...r.results);
  }
  return out;
}

export async function sendPush(
  env: Env,
  fetcher: typeof fetch,
  note: PushNote,
  nowS: number,
  to: PushAudience,
  /** The title for one person (notify.ts names the workspace for people in several); `note.title` without it. */
  titleFor?: (userId: string) => Promise<string>,
): Promise<{ sent: number; removed: number }> {
  if (!env.VAPID_PRIVATE_KEY || !env.VAPID_PUBLIC_KEY) return { sent: 0, removed: 0 };
  const users = "userId" in to ? [to.userId] : await receivers(env.DB, to.workspaceId, to.group);
  const subs = await devicesOf(env, users);
  const vapid = { subject: env.VAPID_SUBJECT, publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY };
  let sent = 0,
    removed = 0;
  for (const s of subs) {
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
        {
          data: { ...note, title: titleFor ? await titleFor(s.user_id) : note.title },
          options: { ttl: 3600, urgency: "high" },
        },
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
