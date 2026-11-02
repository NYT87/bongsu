// Every table of Bongsu's database: the baseline with every later migration applied (migrations/index.ts). Each
// database's SQL is generated from the same source (sqlite.ts, postgres.ts); docs/schema.md is the readable version.

import { applyMigrations } from "./migrate";
import { MIGRATIONS } from "./migrations/index";

export const TABLES = applyMigrations(MIGRATIONS);
