// The comments inbox, in the inbox's cron run: new comments on recent Instagram posts
// (and their Trial Reel copies) and on the YouTube Shorts the scheduler commented on, a few posts per run
// (oldest-checked first), for 14 days after each went out. Ours (the self-comment, replies) are kept but never notified. Replies are sent from the app
// (src/app/routes.ts → replyToComment).

import { ARCHIVED, findAccount, listAccounts } from "./accounts";
import { BudgetSpent, canAfford, noteFetch, type StepDeps } from "./budget";
import type { Env } from "./env";
import { notifier } from "./notify";
import { providerFor } from "./providers/index";
import type { Provider } from "./providers/types";
import { newComments } from "./texts/notifications";

const WINDOW_S = 14 * 86400;
const PER_RUN = 4;
/** The most calls one video's check makes: a YouTube token, the channel's id (once per channel) and the comments; an
 *  Instagram post's is one. */
export const COMMENTS_UNIT_CALLS = 3;

interface Poll {
  media_id: string;
  platform: "ig" | "yt";
  account: string;
  item_key: string | null;
  workspace_id: string;
}
type Found = { id: string; author: string; text: string; at: number; own: boolean };

const unix = (iso: string) => Math.floor(Date.parse(iso.replace(/([+-]\d\d)(\d\d)$/, "$1:$2")) / 1000);

export async function pollComments(env: Env, deps: StepDeps): Promise<{ checked: number; fresh: number }> {
  const nowS = Math.floor(deps.now.getTime() / 1000);
  const since = nowS - WINDOW_S;
  // What to watch: posts and commented Shorts from the last 14 days (new ones join with checked_at 0, so first).
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO comment_polls (media_id, platform, account, item_key, since, workspace_id)
      SELECT x.media_id, 'ig', x.account, x.item_key, COALESCE(x.published_at, x.at), x.workspace_id FROM posted x LEFT JOIN plan_items p ON p.item_key = x.item_key
       WHERE x.media_id IS NOT NULL AND COALESCE(x.published_at, x.at) >= ?1 AND COALESCE(p.format, 'feed') != 'story'
       ON CONFLICT (media_id) DO NOTHING`).bind(since),
    env.DB.prepare(`INSERT INTO comment_polls (media_id, platform, account, item_key, since, workspace_id)
      SELECT media_id, 'ig', account, item_key, COALESCE(published_at, at), workspace_id FROM trial_posts
       WHERE media_id IS NOT NULL AND COALESCE(published_at, at) >= ?1 ON CONFLICT (media_id) DO NOTHING`).bind(since),
    env.DB.prepare(`INSERT INTO comment_polls (media_id, platform, account, item_key, since, workspace_id)
      SELECT video_id, 'yt', channel, 'comment:' || video_id, at, workspace_id FROM shorts_commented
       WHERE at >= ?1 ON CONFLICT (media_id) DO NOTHING`).bind(since),
    env.DB.prepare("DELETE FROM comment_polls WHERE since < ?1").bind(since),
  ]);
  // an archived workspace stops completely: its posts aren't watched (and don't take a run's places)
  const polls = await env.DB.prepare(
    `SELECT media_id, platform, account, item_key, workspace_id FROM comment_polls
     WHERE workspace_id NOT IN (${ARCHIVED}) ORDER BY checked_at LIMIT ?1`,
  )
    .bind(PER_RUN)
    .all<Poll>();
  if (!polls.results.length) return { checked: 0, fresh: 0 };

  const yt = new Map<string, { pr: Provider; me: string | null }>();
  const accounts = new Map((await listAccounts(env.DB, { all: true, working: true })).map((a) => [a.id, a]));
  const fresh: { who: string; text: string; item: string | null; workspaceId: string }[] = [];
  for (const p of polls.results) {
    // out of calls for this run: the rest, checked least recently, come first next run
    if (!canAfford(deps, COMMENTS_UNIT_CALLS)) break;
    let found: Found[] = [];
    try {
      if (p.platform === "ig") {
        const acc = accounts.get(p.account);
        const pr = acc && (await providerFor(env, deps.fetch, acc));
        if (!pr?.comments) continue;
        found = (await pr.comments(p.media_id)).map((c) => ({
          id: `ig:${c.id}`,
          author: c.author,
          text: c.text,
          at: unix(c.at),
          own: c.author === p.account,
        }));
      } else {
        const acc = accounts.get(p.account);
        if (acc && !yt.has(p.account)) {
          const pr = await providerFor(env, deps.fetch, acc);
          if (pr?.comments) yt.set(p.account, { pr, me: (await pr.verify()).id || null });
        }
        const got = yt.get(p.account);
        if (!got?.pr.comments) continue;
        found = (await got.pr.comments(p.media_id)).map((c) => ({
          id: `yt:${c.id}`,
          author: c.author,
          text: c.text,
          at: unix(c.at),
          own: !!got.me && c.authorId === got.me,
        }));
      }
    } catch (e) {
      // the run's calls ran out: this post isn't marked checked, and what was found so far is still told
      if (e instanceof BudgetSpent) break;
      console.log(`comments ${p.media_id}: ${(e as Error).message}`);
    }
    // one read of what's stored, then one batch of the new ones: a check with nothing new writes nothing
    const stored = found.length
      ? await env.DB.prepare("SELECT id FROM comments WHERE media_id = ?1").bind(p.media_id).all<{ id: string }>()
      : { results: [] };
    const known = new Set(stored.results.map((r) => r.id));
    const added = found.filter((c) => !known.has(c.id));
    if (added.length)
      await env.DB.batch(
        added.map((c) =>
          env.DB.prepare(
            `INSERT INTO comments (id, platform, account, media_id, item_key, author, text, at, own, seen, workspace_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9, ?10) ON CONFLICT (id) DO NOTHING`,
          ).bind(
            c.id,
            p.platform,
            p.account,
            p.media_id,
            p.item_key,
            c.author,
            c.text.slice(0, 2000),
            c.at,
            c.own ? 1 : 0,
            p.workspace_id,
          ),
        ),
      );
    for (const c of added)
      if (!c.own)
        fresh.push({
          who: `${p.platform === "yt" ? "" : "@"}${c.author}`,
          text: c.text,
          item: p.item_key,
          workspaceId: p.workspace_id,
        });
    await env.DB.prepare("UPDATE comment_polls SET checked_at = ?1 WHERE media_id = ?2").bind(nowS, p.media_id).run();
  }
  // one message per workspace: its members see only its comments
  const note = notifier(env, noteFetch(deps), nowS);
  for (const ws of new Set(fresh.map((f) => f.workspaceId))) {
    const mine = fresh.filter((f) => f.workspaceId === ws);
    const lines = mine.slice(0, 4).map((f) => `${f.who}: ${f.text.replace(/\s+/g, " ").slice(0, 90)}`);
    if (mine.length > 4) lines.push(`…and ${mine.length - 4} more`);
    await note.send(newComments(lines, mine.length), ws);
  }
  return { checked: polls.results.length, fresh: fresh.length };
}

/** Reply from the app: an Instagram comment reply, or a YouTube reply as the channel; kept with the comment. Only a
 *  comment of the caller's workspace, through that workspace's account. */
export async function replyToComment(
  env: Env,
  fetcher: typeof fetch,
  id: string,
  text: string,
  nowS: number,
  workspaceId: string,
): Promise<{ id: string }> {
  const c = await env.DB.prepare(
    "SELECT id, platform, account, workspace_id FROM comments WHERE id = ?1 AND workspace_id = ?2",
  )
    .bind(id, workspaceId)
    .first<{ id: string; platform: "ig" | "yt"; account: string; workspace_id: string }>();
  if (!c) throw new Error(`no comment ${id}`);
  const acc = await findAccount(env.DB, c.account, c.workspace_id);
  const raw = id.replace(/^(ig|yt):/, "");
  const pr = acc && (await providerFor(env, fetcher, acc));
  if (!pr?.reply) throw new Error(`no working connection for ${c.account}`);
  await pr.reply(raw, text);
  await env.DB.prepare("UPDATE comments SET reply_text = ?1, replied_at = ?2, seen = 1 WHERE id = ?3")
    .bind(text, nowS, id)
    .run();
  return { id };
}
