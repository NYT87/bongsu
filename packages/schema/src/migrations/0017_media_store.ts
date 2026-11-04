// The instance's media stores, set up in the dashboard (docs/media-stores.md): one row per kind, with its settings,
// its credentials (encrypted) and how its last check went; one is the default (where nothing names a store). Stores
// belong to the instance, so no workspace_id (like oauth_apps). It replaces the MEDIA_STORE, DRIVE_SA_JSON and
// DRIVE_OWNER_OAUTH variables.
import type { Step } from "../migrate";

export const steps: Step[] = [
  {
    createTable: "media_store",
    table: {
      description:
        "The instance's media stores, one per kind: settings, encrypted credentials, last check, the default.",
      columns: {
        kind: { type: "id", primaryKey: true, values: ["drive", "s3", "local"], description: "MediaRef.store" },
        is_default: { type: "bool", notNull: true, default: 0, description: "where nothing names a store" },
        settings: {
          type: "json",
          notNull: true,
          default: "{}",
          description: "nothing secret: endpoint, bucket, root…",
        },
        credentials: { type: "text", description: "encrypted (core/crypto.ts): the S3 keys or the Drive grant" },
        status: { type: "text", notNull: true, values: ["ok", "broken"], default: "ok" },
        last_error: { type: "text" },
        last_checked_at: { type: "timestamp" },
        updated_at: { type: "timestamp", notNull: true },
        updated_by: { type: "text" },
      },
    },
  },
];
