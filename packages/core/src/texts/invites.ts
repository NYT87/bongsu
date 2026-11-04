// The invite email's wording (core/invites.ts sends it when a Mailer is set; the link is always shown in the
// dashboard too). Change wording here, and only here.
import type { Mail } from "../mail";
import type { Role } from "../roles";

const ROLE_WORDS: Record<Role, string> = {
  admin: "an admin (the accounts, connections, members and the plan)",
  editor: "an editor (the plan and the texts; approving stays with the others)",
  creator: "a creator (the plan, the texts and approving, in the Bongsu app)",
};

export const inviteMail = (o: {
  to: string;
  workspace: string;
  role: Role;
  by: string;
  url: string;
  days: number;
}): Mail => ({
  to: [o.to],
  subject: `Bongsu: join ${o.workspace}`,
  text: [
    `${o.by} invites you to the workspace ${o.workspace} on Bongsu, as ${ROLE_WORDS[o.role]}.`,
    "",
    `Open this link to join (it works once, for ${o.days} days):`,
    o.url,
    "",
    "You'll make a passkey (this device's fingerprint, face or PIN), or sign in with yours if you already have one.",
    "If you didn't expect this, ignore it.",
  ].join("\n"),
});
