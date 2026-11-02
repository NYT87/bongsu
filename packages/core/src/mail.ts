// The Mailer port (optional): email for connection alerts, and for invites in Phase 13. Off unless MAILER is set; then
// the other channels (the audit log, ntfy, Web Push) still carry every notice and invite links are copied by hand.
// "resend" (Resend's HTTP API) works everywhere; a runtime can register more: the Node app adds "smtp" (a socket,
// which a Worker can't open), e.g. Mailpit in docker-compose for testing.
import type { Db } from "./db";
import type { Env } from "./env";

export interface Mail {
  to: string[];
  subject: string;
  text: string;
}
export interface Mailer {
  /** "none" when email is off. */
  readonly id: string;
  send(m: Mail): Promise<void>;
}

const NONE: Mailer = { id: "none", send: async () => {} };

export class MailError extends Error {}

const registered = new Map<string, (env: Partial<Env>) => Mailer>();
/** A mailer kind a runtime provides (Node: "smtp"). */
export function registerMailer(kind: string, make: (env: Partial<Env>) => Mailer) {
  registered.set(kind, make);
}

/** The instance's mailer: MAILER ("resend", or one a runtime registered), MAIL_FROM and the provider's settings
 *  (RESEND_API_KEY); none when unset. */
export function mailer(env: Partial<Env>, fetcher: typeof fetch): Mailer {
  const kind = env.MAILER ?? "";
  if (!kind) return NONE;
  const make = registered.get(kind);
  if (make) return make(env);
  if (kind !== "resend") throw new MailError(`unknown MAILER ${kind}`);
  if (!env.MAIL_FROM || !env.RESEND_API_KEY) throw new MailError("MAILER = resend needs MAIL_FROM and RESEND_API_KEY");
  return {
    id: "resend",
    async send(m) {
      if (!m.to.length) return;
      const r = await fetcher("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: env.MAIL_FROM, to: m.to, subject: m.subject, text: m.text }),
      });
      if (!r.ok) throw new MailError(`resend: ${r.status} ${(await r.text()).slice(0, 200)}`);
    },
  };
}

/** The emails of a workspace's owners and admins: who hears about its connections. */
export async function workspaceAdmins(db: Db, workspaceId: string): Promise<string[]> {
  const r = await db
    .prepare(
      `SELECT u.email FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.workspace_id = ?1 AND m.role IN ('owner', 'admin') AND u.email IS NOT NULL ORDER BY u.email`,
    )
    .bind(workspaceId)
    .all<{ email: string }>();
  return r.results.map((x) => x.email);
}
