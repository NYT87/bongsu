// MAILER = "smtp" on Node (core/mail.ts registers it from here): any SMTP relay, e.g. Mailpit in docker-compose
// (SMTP_HOST=mailpit, SMTP_PORT=1025), which catches every email and shows it on its web page.

import type { Env } from "@bongsu/core/env";
import { MailError, type Mailer } from "@bongsu/core/mail";
import nodemailer from "nodemailer";

export function smtpMailer(env: Partial<Env>): Mailer {
  if (!env.SMTP_HOST || !env.MAIL_FROM) throw new MailError("MAILER = smtp needs SMTP_HOST and MAIL_FROM");
  const port = Number(env.SMTP_PORT ?? 587);
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port,
    secure: port === 465,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS ?? "" } : undefined,
  });
  return {
    id: "smtp",
    async send(m) {
      if (!m.to.length) return;
      await transport.sendMail({ from: env.MAIL_FROM, to: m.to, subject: m.subject, text: m.text });
    },
  };
}
