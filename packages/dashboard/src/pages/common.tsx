// What the dashboard's sections share (DESIGN.md, Layout). Each section gets the instance state and `go` to move
// to another section; each is in its own file here.

import type { State } from "../App";

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
