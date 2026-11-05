// A workspace's icon and per-workspace display names (Phase 13 part 3b): the icon is one PNG per workspace (a row only
// while one is set), a person may go by another name in each workspace they belong to, and a draft made in the app
// remembers who made it.
import type { Step } from "../migrate";

export const steps: Step[] = [
  {
    createTable: "workspace_icons",
    table: {
      description: "A workspace's icon: a PNG (base64), its SHA-256 and when it was set; no row, no icon.",
      columns: {
        workspace_id: { type: "text", notNull: true },
        png: { type: "text", notNull: true },
        hash: { type: "text", notNull: true },
        updated_at: { type: "timestamp", notNull: true },
      },
      primaryKey: ["workspace_id"],
    },
  },
  {
    createIndex: {
      table: "workspace_icons",
      // not unique: the same PNG may be the icon of two workspaces
      index: { name: "workspace_icons_hash", columns: ["hash"] },
    },
  },
  {
    addColumn: {
      table: "memberships",
      name: "display_name",
      column: { type: "text", description: "the name people in this workspace see; NULL: the person's name" },
    },
  },
  {
    addColumn: {
      table: "drafts",
      name: "user_id",
      column: { type: "text", description: "the person who made it (app uploads); NULL for an agent key's" },
    },
  },
];
