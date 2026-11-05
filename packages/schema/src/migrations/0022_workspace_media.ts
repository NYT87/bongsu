// Media, stores and OAuth apps per workspace (Phase 13 part 3a): each workspace gets its own media folder (a top folder
// of the media store its files live in), a workspace may have its own stores next to the instance's, and its own OAuth
// apps next to the instance's.
//
// `media_store` is rebuilt: its key was the kind, so one store per kind; now `id` is (`drive`, `s3`, `local` for the
// instance's, `drive-<workspace>`, `s3-<workspace>` for a workspace's own) and `workspace_id` says whose it is. The
// inbox no longer feeds one chosen workspace (`inbox_workspace` goes): each workspace's folder feeds itself.
import type { Step } from "../migrate";

const rebuild = (int: string, time: string) => `CREATE TABLE media_store_new (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('drive', 's3', 'local')),
  workspace_id TEXT,
  is_default ${int} NOT NULL DEFAULT 0,
  settings TEXT NOT NULL DEFAULT '{}',
  credentials TEXT,
  status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'broken')),
  last_error TEXT,
  last_checked_at ${time},
  updated_at ${time} NOT NULL,
  updated_by TEXT
);
INSERT INTO media_store_new (id, kind, workspace_id, is_default, settings, credentials, status, last_error, last_checked_at, updated_at, updated_by)
  SELECT kind, kind, NULL, is_default, settings, credentials, status, last_error, last_checked_at, updated_at, updated_by FROM media_store;
DROP TABLE media_store;
ALTER TABLE media_store_new RENAME TO media_store;`;

// portable SQL can't slug a name: the seeded workspace keeps the folder its files are in, another gets its id
const folders =
  "UPDATE workspace_settings SET media_folder = CASE WHEN workspace_id = 'default' THEN 'UPLOADS' ELSE workspace_id END;";

export const steps: Step[] = [
  {
    sql: { sqlite: rebuild("INTEGER", "INTEGER"), postgres: rebuild("SMALLINT", "BIGINT") },
    apply: (t) => {
      t.media_cleanup.description =
        "Media moved aside after publishing (to the workspace folder's `_posted/`, `UPLOADS` in the first), or refused by the store.";
      const s = t.media_store;
      s.description =
        "Media stores: the instance's (one per kind) and each workspace's own, settings, encrypted credentials, last check, the default.";
      delete s.columns.inbox_workspace;
      const { kind, ...rest } = s.columns;
      s.columns = {
        id: {
          type: "id",
          primaryKey: true,
          description: "drive, s3, local (the instance's); drive-<workspace>, s3-<workspace>",
        },
        kind: { ...kind, primaryKey: false, notNull: true, description: "MediaRef.store's kind" },
        workspace_id: { type: "text", description: "the workspace it belongs to; NULL: the instance's" },
        ...rest,
      };
    },
  },
  {
    addColumn: {
      table: "workspace_settings",
      name: "media_folder",
      column: { type: "text", description: "the workspace's top folder in the media store; unique, ignoring case" },
    },
  },
  { sql: { sqlite: folders, postgres: folders } },
  {
    createIndex: {
      table: "workspace_settings",
      // without case: two folders that differ only in case are one folder on a disk or a Drive that ignores it
      index: { name: "workspace_settings_media_folder", columns: ["media_folder"], unique: true, lower: true },
    },
  },
  {
    createTable: "workspace_oauth_apps",
    table: {
      description: "A workspace's own OAuth apps (Google, Meta), used instead of the instance's for its connections.",
      columns: {
        workspace_id: { type: "text", notNull: true },
        id: { type: "text", notNull: true, description: "the provider's app id, as oauth_apps.id" },
        client_id: { type: "text", notNull: true },
        client_secret: { type: "text", notNull: true, description: "encrypted (core/crypto.ts)" },
        updated_at: { type: "timestamp", notNull: true },
        updated_by: { type: "text" },
      },
      primaryKey: ["workspace_id", "id"],
    },
  },
  {
    addColumn: {
      table: "oauth_states",
      name: "app_scope",
      column: {
        type: "text",
        values: ["workspace", "instance"],
        description: "whose OAuth app the flow used; NULL: the instance's",
      },
    },
  },
];
