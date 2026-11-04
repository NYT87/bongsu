#!/usr/bin/env bash
# A local Bongsu to try things on (docs/development.md, "Local testing"): applies the migrations to the local D1,
# adds a `default` workspace with its owner (an instance admin) and demo accounts, sets the time zone, makes an agent
# key and a one-time setup code for the owner's first passkey.
# Nothing here touches a remote database or a real account. Safe to run again: the demo rows are replaced, the old
# dev key is revoked and a new one printed.
#
#   scripts/dev-seed.sh [--tz <IANA zone>]      (default: UTC)
set -euo pipefail

TZ_NAME=UTC
while [ $# -gt 0 ]; do
  case "$1" in
    --tz) TZ_NAME="$2"; shift 2 ;;
    -h|--help) sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

cd "$(dirname "$0")/../apps/cloudflare"
wr() { pnpm exec wrangler "$@"; }

# Passkeys are tied to the hostname: locally that's localhost. .dev.vars overrides wrangler.toml's [vars].
if [ ! -f .dev.vars ]; then
  cat > .dev.vars <<'EOF'
PUBLIC_URL=http://localhost:8787
RP_ID=localhost
DRY_RUN=1
EOF
  echo "wrote apps/cloudflare/.dev.vars (localhost, dry run)"
fi

wr d1 migrations apply bongsu --local >/dev/null
echo "migrations applied to the local database"

# tr gets SIGPIPE when head has enough: fine here, so the pipeline's status is ignored
rand() { LC_ALL=C tr -dc "$1" </dev/urandom | head -c "$2" || true; }
KEY="bongsu_$(rand 'A-Za-z0-9' 32)"
KEY_HASH=$(printf %s "$KEY" | sha256sum | cut -d' ' -f1)
CODE=$(rand 'A-HJ-NP-Z2-9' 12 | sed 's/\(....\)\(....\)\(....\)/\1-\2-\3/')
CODE_HASH=$(printf %s "$CODE" | sha256sum | cut -d' ' -f1)

# A fresh database has no workspace and no user (migration 0018 removes the baseline's empty ones: on a real
# instance the setup token makes the instance admin, who creates workspaces). The seed makes its own `default`
# workspace and its owner, an instance admin, as scripts/screenshots/seed.mjs does; ON CONFLICT keeps reruns and an
# older .wrangler state that still has them working.
wr d1 execute bongsu --local --command "
INSERT INTO workspaces (id, name, created_at) VALUES ('default', 'Demo Studio', unixepoch()) ON CONFLICT (id) DO NOTHING;
INSERT INTO workspace_settings (workspace_id, timezone, digest_hour, locale, updated_at) VALUES ('default', '$TZ_NAME', 8, 'en', unixepoch())
  ON CONFLICT (workspace_id) DO UPDATE SET timezone = excluded.timezone, updated_at = excluded.updated_at;
INSERT INTO users (id, email, name, created_at, instance_admin) VALUES ('owner', 'owner@example.com', 'Demo Owner', unixepoch(), 1)
  ON CONFLICT (id) DO UPDATE SET instance_admin = 1, email = COALESCE(users.email, excluded.email),
    name = COALESCE(users.name, excluded.name);
INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES ('default', 'owner', 'admin', unixepoch())
  ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = 'admin';
DELETE FROM accounts WHERE id IN ('demo_travel', 'demo_running');
DELETE FROM connections WHERE id IN ('c_demo_travel', 'c_demo_running');
INSERT INTO connections (id, workspace_id, provider, kind, external_ref, created_at, updated_at) VALUES
  ('c_demo_travel', 'default', 'composio', 'composio', 'demo-travel-ref', unixepoch(), unixepoch()),
  ('c_demo_running', 'default', 'composio', 'composio', 'demo-running-ref', unixepoch(), unixepoch());
INSERT INTO accounts (id, workspace_id, platform, handle, external_id, connection_id, capabilities, created_at, updated_at) VALUES
  ('demo_travel', 'default', 'instagram', 'demo_travel', '17841400000000001', 'c_demo_travel', '{\"trialReels\": true}', unixepoch(), unixepoch()),
  ('demo_running', 'default', 'instagram', 'demo_running', '17841400000000002', 'c_demo_running', '{}', unixepoch(), unixepoch());
UPDATE api_keys SET revoked_at = unixepoch() WHERE name = 'dev-seed' AND revoked_at IS NULL;
INSERT INTO api_keys (id, workspace_id, name, key_hash, scopes) VALUES ('dev-seed-$(date +%s)', 'default', 'dev-seed', '$KEY_HASH', '[\"read\",\"draft\",\"plan\"]');
INSERT INTO setup_codes (code_hash, user_id, expires_at) VALUES ('$CODE_HASH', 'owner', unixepoch() + 900);
" >/dev/null

cat <<EOF

Seeded: workspace default (owner@example.com, instance admin), demo_travel, demo_running (Instagram, fake ids),
time zone $TZ_NAME.

  Agent key:   $KEY
  Setup code:  $CODE   (first passkey in the app, valid 15 minutes)

Next:
  pnpm build                                   # the app, served by the Worker
  pnpm --filter @bongsu/cloudflare dev         # http://localhost:8787
  export KEY=$KEY
  curl -s localhost:8787/v1/status -H "Authorization: Bearer \$KEY"
EOF
