import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// The tests' workspace is in Seoul (seedAccounts sets it too): their local dates and times are converted to UTC with
// it, also when an item is planned before testEnv runs.
await env.DB.prepare("UPDATE workspace_settings SET timezone = 'Asia/Seoul' WHERE workspace_id = 'default'").run();
