// A pending invite's link, kept so an admin can copy it again until it's used, expires or is revoked: the token,
// encrypted with ENCRYPTION_KEY. The lookup stays on token_hash. NULL: made before this, or without the key.
import type { Step } from "../migrate";

export const steps: Step[] = [
  {
    addColumn: {
      table: "invites",
      name: "token_enc",
      column: { type: "text", description: "the link's token, encrypted (core/crypto.ts); NULL: not kept" },
    },
  },
];
