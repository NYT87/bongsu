// Notifications: always the audit log and the Worker log; also the workspace's ntfy topic when it has one (set in the
// dashboard, core/ntfy.ts: the title goes in the Title header, the text in the body), and Web Push to the installed
// app of the workspace's members. Every message names its workspace, and nothing of one workspace reaches another's
// topic or devices.
import type { Db } from "./db";
import type { Env } from "./env";
import { instanceAdmins, mailer } from "./mail";
import { postNtfy, workspaceNtfy } from "./ntfy";
import { sendPush } from "./push";
import type { Note } from "./texts/notifications";

/** A notification button: opens `url` (an app path like "/#/drafts", or a full URL). */
export interface Action {
  label: string;
  url: string;
}
export interface Notifier {
  /** Sends one message built in texts/notifications.ts, about one workspace (its devices get the push). */
  send(note: Note, workspaceId: string): Promise<void>;
}

/** Where a notification opens, and its buttons (Android shows two at most): the target's own page, plus `extra`. */
export function actionsFor(target: string | undefined, extra: Action[] = []): { url: string; actions: Action[] } {
  let own: Action = { label: "Open app", url: "/#/" };
  // A 24 h result (`results:<key>`) opens its item's Results view, a Trial Reel's (`results:trial:<reel key>`) its
  // Reel's; a bare `trial:<reel key>` is the copy's job (failed, refused…) and opens the Reel's page.
  const results = target?.startsWith("results:");
  const item = target?.replace(/^results:/, "").replace(/^trial:/, "");
  if (item && /^(reel|post):/.test(item))
    own = results
      ? { label: "Open results", url: `/#/item/${encodeURIComponent(item)}/results` }
      : { label: "Open in app", url: `/#/item/${encodeURIComponent(item)}` };
  else if (target === "drafts") own = { label: "Review drafts", url: "/#/drafts" };
  else if (target === "comments") own = { label: "Open comments", url: "/#/comments" };
  else if (target?.startsWith("comment:"))
    own = { label: "Open in Studio", url: `https://studio.youtube.com/video/${target.slice(8)}/comments` };
  return { url: own.url, actions: [...extra, own].slice(0, 2) };
}

export function notifier(env: Env, fetcher: typeof fetch, nowS: number): Notifier {
  const abs = (u: string) => (u.startsWith("/") ? `${env.PUBLIC_URL.replace(/\/$/, "")}${u}` : u);
  /** Each workspace's topic, read once per notifier. */
  const topics = new Map<string, Promise<string | null>>();
  const topic = (ws: string) => {
    if (!topics.has(ws))
      topics.set(
        ws,
        workspaceNtfy(env, ws).catch((e) => {
          console.log(`notify: ${ws}'s ntfy topic can't be read: ${(e as Error).message}`);
          return null;
        }),
      );
    return topics.get(ws) as Promise<string | null>;
  };
  return {
    async send({ title, text, target, actions: extra }, workspaceId) {
      console.log(`notify: ${title}: ${text}`);
      await env.DB.prepare(
        "INSERT INTO audit (at, actor, action, target, detail, workspace_id) VALUES (?1, 'cron', 'notify', ?2, ?3, ?4)",
      )
        .bind(nowS, target ?? null, JSON.stringify({ title, text }), workspaceId)
        .run();
      const a = actionsFor(target, extra);
      const url = await topic(workspaceId);
      if (url) {
        try {
          const buttons = a.actions.map((x) => ({ label: x.label, url: abs(x.url) }));
          if (!(await postNtfy(fetcher, url, { title, text, click: abs(a.url), buttons })))
            console.log(`notify: ${workspaceId}'s ntfy topic refused the message`);
        } catch (e) {
          console.log(`notify: ${workspaceId}'s ntfy topic failed: ${e}`);
        }
      }
      // A push message carries about 4 KB, so the text is cut (ntfy and the audit keep all of it).
      await sendPush(
        env,
        fetcher,
        {
          title,
          body: text.slice(0, 1500),
          url: a.url,
          tag: target ?? undefined,
          actions: a.actions.map((x, i) => ({ action: `a${i}`, title: x.label, url: x.url })),
        },
        nowS,
        { workspaceId },
      );
    },
  };
}

/** A notice about the instance itself (a broken media store), for the instance admins: the audit log in no workspace,
 *  and an email to each of them with an address when a Mailer is set. No workspace's topic or devices get it: the
 *  instance isn't any one workspace's. A mail failure is logged; the audit row is already written. */
export async function notifyInstanceAdmins(env: Env, fetcher: typeof fetch, note: Note, nowS: number) {
  console.log(`notify (instance): ${note.title}: ${note.text}`);
  await env.DB.prepare(
    "INSERT INTO audit (at, actor, action, target, detail, workspace_id) VALUES (?1, 'cron', 'notify', ?2, ?3, NULL)",
  )
    .bind(nowS, note.target ?? null, JSON.stringify({ title: note.title, text: note.text }))
    .run();
  try {
    const mail = mailer(env, fetcher);
    if (mail.id === "none") return;
    const to = await instanceAdmins(env.DB);
    if (!to.length) return; // nobody to write to: the audit row stands
    const link = note.mail ? `\n\n${env.PUBLIC_URL.replace(/\/$/, "")}${note.mail.page}` : "";
    await mail.send({ to, subject: note.mail?.subject ?? `Bongsu: ${note.title}`, text: `${note.text}${link}` });
  } catch (e) {
    console.log(`mail: ${(e as Error).message}`);
  }
}

export async function audit(db: Db, nowS: number, action: string, target: string | null, detail: unknown) {
  await db
    .prepare("INSERT INTO audit (at, actor, action, target, detail) VALUES (?1, 'cron', ?2, ?3, ?4)")
    .bind(nowS, action, target, JSON.stringify(detail))
    .run();
}
