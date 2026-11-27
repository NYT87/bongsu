// What the dashboard's sections share (DESIGN.md, Layout). Each section gets the instance state and `go` to move
// to another section; each is in its own file here.

import type { State } from "../App";
import { Field, useLoad } from "../ui";

export interface Props {
  state: State;
  go: (section: string) => void;
}

export const errorText = (e: unknown) => (e as Error).message;

export const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export const STORE_NAME: Record<string, string> = {
  drive: "Google Drive",
  s3: "S3-compatible bucket",
  local: "This server's disk",
};

export const ROLE_HELP: Record<string, string> = {
  admin: "Admin: everything in the workspace, including its people, connections and settings.",
  editor: "Editor: the plan and the texts, in the dashboard and the app; can't approve.",
  creator: "Creator: the plan, the texts and approving, in the Bongsu app.",
};

// ---- Get started (after sign-up)

/** The hours of the day, for the digest hour pickers. */
export const HOURS = Array.from({ length: 24 }, (_, h) => h);

// ---- A new workspace's admin

/** The picker's choice for someone not on the instance yet: they get an invite link. */
const SOMEONE_NEW = "new";

/** What the create request sends as `admin`: "me", an account's email, or the new person's email. */
export const adminOf = (choice: string, email: string) =>
  choice === SOMEONE_NEW ? email.trim().toLowerCase() : choice;

/** Who a new workspace's one admin is, picked by the instance admin: themselves (the default), an account already on
 *  the instance (its admin right away), or someone new, invited by email. */
export function AdminPicker({
  myEmail,
  choice,
  onChoice,
  email,
  onEmail,
}: {
  myEmail: string | null;
  choice: string;
  onChoice: (v: string) => void;
  email: string;
  onEmail: (v: string) => void;
}) {
  const { data } = useLoad<{ users: { id: string; email: string; name: string | null }[] }>("users");
  return (
    <>
      <Field
        label="Its admin"
        help="An account on this instance becomes its admin right away; someone new gets an invite link."
      >
        {(p) => (
          <select {...p} value={choice} onChange={(e) => onChoice(e.target.value)}>
            <option value="me">Me</option>
            {data?.users
              .filter((u) => u.email !== myEmail)
              .map((u) => (
                <option key={u.id} value={u.email}>
                  {u.name ? `${u.name} (${u.email})` : u.email}
                </option>
              ))}
            <option value={SOMEONE_NEW}>Someone new: invite them by email</option>
          </select>
        )}
      </Field>
      {choice === SOMEONE_NEW && (
        <Field label="Their email" help="They get an invite link, to join as its admin.">
          {(p) => <input {...p} type="email" value={email} onChange={(e) => onEmail(e.target.value)} required />}
        </Field>
      )}
    </>
  );
}
