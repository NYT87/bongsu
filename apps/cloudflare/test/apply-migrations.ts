import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// 0018 drops the baseline's empty seed on a fresh database, so the tests seed their own: workspace `default` and user
// `owner`, an instance admin with an admin membership. The workspace is in Seoul (seedAccounts sets it too): the tests'
// local dates and times are converted to UTC with it, also when an item is planned before testEnv runs.
await env.DB.batch([
  env.DB.prepare(
    "INSERT INTO workspaces (id, name, created_at) VALUES ('default', 'Default', 0) ON CONFLICT DO NOTHING",
  ),
  env.DB.prepare(
    "INSERT INTO workspace_settings (workspace_id, timezone, digest_hour, locale, media_folder, updated_at) VALUES ('default', 'Asia/Seoul', 8, 'en', 'UPLOADS', 0) ON CONFLICT DO NOTHING",
  ),
  env.DB.prepare(
    "INSERT INTO users (id, email, name, created_at, instance_admin) VALUES ('owner', NULL, 'Owner', 0, 1) ON CONFLICT DO NOTHING",
  ),
  env.DB.prepare(
    "INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES ('default', 'owner', 'admin', 0) ON CONFLICT DO NOTHING",
  ),
]);
