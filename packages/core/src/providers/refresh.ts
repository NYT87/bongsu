// Keeping connections alive, in the inbox's cron run: every connection whose provider registered a keepAlive
// (providers/index.ts) is renewed or checked weekly, sooner when it runs out within RENEW_BEFORE_S. Instagram tokens
// are renewed and the new one stored encrypted (a token first given as a secret moves into the database); YouTube's
// refresh tokens are checked. A failure marks the connection `expiring`, or `broken` when it can't work any more (a
// revoked grant, a token past its expiry), and notifies once: the usual channels, plus an email to the workspace's
// owners and admins when a Mailer is set (core/mail.ts).
import type { Connection } from "../accounts";
import { BudgetSpent, canAfford, noteFetch, type StepDeps } from "../budget";
import { encryptSecret } from "../crypto";
import type { Env } from "../env";
import { instanceName, mailer, workspaceAdmins } from "../mail";
import { notifier } from "../notify";
import { alertMailFooter } from "../texts/mail";
import { connectionMailSubject, connectionProblem } from "../texts/notifications";
import { workspaceRef } from "../workspaces";
import { providerRegistration } from "./index";
import { ConnectionBroken } from "./types";

export const RENEW_EVERY_S = 7 * 86400;
/** The most calls one connection's renewal makes: Instagram's token refresh, or Google's. */
export const CONNECTIONS_UNIT_CALLS = 1;
/** Renew sooner when the credentials run out within this. */
const RENEW_BEFORE_S = 10 * 86400;

interface Row {
  id: string;
  workspace_id: string;
  provider: string;
  kind: Connection["kind"];
  label: string | null;
  external_ref: string | null;
  credentials: string | null;
  secret_name: string | null;
  status: Connection["status"];
  expires_at: number | null;
  last_checked_at: number | null;
  updated_at: number;
}

export async function refreshConnections(env: Env, deps: StepDeps): Promise<{ renewed: string[]; failed: string[] }> {
  const nowS = Math.floor(deps.now.getTime() / 1000);
  const rows = await env.DB.prepare(
    `SELECT id, workspace_id, provider, kind, label, external_ref, credentials, secret_name, status, expires_at,
       last_checked_at, updated_at FROM connections WHERE status != 'broken'`,
  ).all<Row>();
  const out = { renewed: [] as string[], failed: [] as string[] };
  const problems: { workspaceId: string; text: string }[] = [];
  for (const r of rows.results) {
    const reg = providerRegistration(r.provider);
    if (!reg?.keepAlive) continue;
    const every = reg.keepAliveEveryS ?? RENEW_EVERY_S;
    const due =
      r.last_checked_at === null ||
      r.last_checked_at <= nowS - every ||
      (r.expires_at !== null && r.expires_at <= nowS + RENEW_BEFORE_S);
    if (!due) continue;
    // out of calls for this run: the rest are still due next run
    if (!canAfford(deps, CONNECTIONS_UNIT_CALLS)) break;
    const c: Connection = {
      id: r.id,
      workspaceId: r.workspace_id,
      provider: r.provider,
      kind: r.kind,
      label: r.label,
      externalRef: r.external_ref,
      credentials: r.credentials,
      secretName: r.secret_name,
      status: r.status,
    };
    let error: string;
    let broken = false;
    try {
      const kept = await reg.keepAlive(env, deps.fetch, c, nowS);
      const creds = kept?.credentials ? await encryptSecret(env.ENCRYPTION_KEY, kept.credentials) : null;
      // only the row as it was read (?5): a reconnect while the renewal ran wrote a newer token, which stays
      await env.DB.prepare(
        `UPDATE connections SET credentials = COALESCE(?1, credentials), expires_at = COALESCE(?2, expires_at),
           status = 'ok', last_error = NULL, last_checked_at = ?3, updated_at = ?3 WHERE id = ?4 AND updated_at = ?5`,
      )
        .bind(creds, kept?.expiresAt ?? null, nowS, r.id, r.updated_at)
        .run();
      out.renewed.push(r.id);
      continue;
    } catch (e) {
      // the run's calls, not the connection, ran out: it stays as it is, and the problems found so far are still told
      if (e instanceof BudgetSpent) break;
      error = (e as Error).message.slice(0, 300);
      broken = e instanceof ConnectionBroken;
    }
    const expired = r.expires_at !== null && r.expires_at <= nowS;
    const status = broken || expired ? "broken" : "expiring";
    // the old token's failure says nothing about one reconnected meanwhile: nothing is marked, nobody is told
    const marked = await env.DB.prepare(
      "UPDATE connections SET status = ?1, last_error = ?2, last_checked_at = ?3, updated_at = ?3 WHERE id = ?4 AND updated_at = ?5 RETURNING id",
    )
      .bind(status, error, nowS, r.id, r.updated_at)
      .first();
    if (!marked) continue;
    out.failed.push(r.id);
    if (r.status !== status)
      problems.push({
        workspaceId: r.workspace_id,
        text: `${r.label ?? r.id}: ${error}${expired ? " (the token has run out)" : ""}`,
      });
  }
  if (problems.length) {
    const say = (list: typeof problems) =>
      `${list.map((p) => p.text).join("\n")}\nPosting may stop for it: reconnect it in the dashboard (Connections).`;
    // each workspace hears of its own connections
    const note = notifier(env, noteFetch(deps), nowS);
    for (const ws of new Set(problems.map((p) => p.workspaceId)))
      await note.send(connectionProblem(say(problems.filter((p) => p.workspaceId === ws))), ws);
    // Email, per workspace, to its owners and admins. A mail failure is logged; the notice above already went out.
    try {
      const mail = mailer(env, noteFetch(deps));
      if (mail.id !== "none")
        for (const ws of new Set(problems.map((p) => p.workspaceId))) {
          const to = await workspaceAdmins(env.DB, ws);
          if (!to.length) continue; // every admin turned the emails off: the notice above stands
          const name = (await workspaceRef(env.DB, ws))?.name ?? ws;
          const footer = alertMailFooter({
            who: `an admin of ${name}`,
            instance: instanceName(env.PUBLIC_URL),
            publicUrl: env.PUBLIC_URL,
          });
          await mail.send({
            to,
            subject: connectionMailSubject,
            text: `${say(problems.filter((p) => p.workspaceId === ws))}\n\n${env.PUBLIC_URL.replace(/\/$/, "")}/dashboard/connections\n${footer}`,
          });
        }
    } catch (e) {
      console.log(`mail: ${(e as Error).message}`);
    }
  }
  return out;
}
