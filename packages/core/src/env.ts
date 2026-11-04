// Bindings and secrets of the scheduler Worker. Secrets are set with
// `bongsu deploy-secrets` or `wrangler secret put`, never written to the repo or wrangler.toml.
import type { Db } from "./db";
export interface Env {
  DB: Db;

  /** "1": every step logs and notifies instead of publishing. */
  DRY_RUN: string;
  /** This Worker's public URL, for the signed media links Instagram fetches. */
  PUBLIC_URL: string;
  /** The app's WebAuthn relying-party id: the Worker's hostname. */
  RP_ID: string;
  /** Web Push (VAPID): public key (base64url, public by design), subject (mailto:). The private key is a secret. */
  VAPID_PUBLIC_KEY: string;
  VAPID_SUBJECT: string;
  VAPID_PRIVATE_KEY?: string;
  /** The app's static files (packages/web/dist), served by Workers assets. */
  ASSETS?: { fetch(request: Request): Promise<Response> };

  /** Composio consumer key (ck_…), used on the consumer MCP endpoint; only for accounts connected through Composio. */
  COMPOSIO_CONSUMER_KEY?: string;
  /** Node only: the directory this server offers as the "local" media store (the stores themselves are set up in the
   *  dashboard, media_store). */
  MEDIA_DIR?: string;
  /** HMAC key for the signed media links Instagram fetches. */
  MEDIA_SIGNING_KEY: string;
  /** Encrypts the credentials stored in the database (connections, OAuth apps, media stores; core/crypto.ts).
   *  Optional until something stores credentials there. */
  ENCRYPTION_KEY?: string;
  /** Asked once by the dashboard to create its first user (site/docs/deploy-cloudflare.md); useless after that. */
  SETUP_TOKEN?: string;
  /** Email (core/mail.ts), optional: "resend", with MAIL_FROM ("Bongsu <bongsu@example.com>") and the RESEND_API_KEY
   *  secret. Unset: no email. */
  MAILER?: string;
  MAIL_FROM?: string;
  RESEND_API_KEY?: string;
  /** MAILER = "smtp" (Node only): the relay, e.g. Mailpit in docker-compose. */
  SMTP_HOST?: string;
  SMTP_PORT?: string;
  SMTP_USER?: string;
  SMTP_PASS?: string;
  /** Publishing jobs advanced per tick (constants.ts JOBS_PER_TICK): unset, 4 on Cloudflare and 20 on Node. */
  JOBS_PER_TICK?: string;
}
