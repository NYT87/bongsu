// Notifications: always the audit log and the Worker log; also NOTIFY_URL when set (an ntfy.sh topic URL: the title
// goes in the Title header, the text in the body), and Web Push to the owner's installed app.
import type { Db } from "./db";
import type { Env } from "./env";
import { sendPush } from "./push";
import type { Note } from "./texts/notifications";

/** A notification button: opens `url` (an app path like "/#/drafts", or a full URL). */
export interface Action {
  label: string;
  url: string;
}
export interface Notifier {
  /** Sends one message built in texts/notifications.ts. */
  send(note: Note): Promise<void>;
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

export function notifier(db: Db, fetcher: typeof fetch, url: string | undefined, nowS: number, env?: Env): Notifier {
  const abs = (u: string) => (u.startsWith("/") ? `${(env?.PUBLIC_URL ?? "").replace(/\/$/, "")}${u}` : u);
  return {
    async send({ title, text, target, actions: extra }) {
      console.log(`notify: ${title}: ${text}`);
      await db
        .prepare("INSERT INTO audit (at, actor, action, target, detail) VALUES (?1, 'cron', 'notify', ?2, ?3)")
        .bind(nowS, target ?? null, JSON.stringify({ title, text }))
        .run();
      const a = actionsFor(target, extra);
      if (url) {
        try {
          // ntfy: "view" buttons (https://docs.ntfy.sh/publish/#action-buttons); labels may not contain , or ;
          const buttons = a.actions
            .map((x) => `view, ${x.label.replace(/[,;]/g, " ")}, ${abs(x.url)}, clear=true`)
            .join("; ");
          await fetcher(url, {
            method: "POST",
            headers: { Title: title, Tags: "calendar", Click: abs(a.url), Actions: buttons },
            body: text,
          });
        } catch (e) {
          console.log(`notify: ${url} failed: ${e}`);
        }
      }
      if (env) {
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
        );
      }
    },
  };
}

export async function audit(db: Db, nowS: number, action: string, target: string | null, detail: unknown) {
  await db
    .prepare("INSERT INTO audit (at, actor, action, target, detail) VALUES (?1, 'cron', ?2, ?3, ?4)")
    .bind(nowS, action, target, JSON.stringify(detail))
    .run();
}
