-- The dashboard (docs/PLAN.md 2.8, Phase 4b): people sign in with an email and a passkey.
--   recovery_codes  one-time codes shown at sign-up, for a user who lost every passkey (stored hashed)
--   sessions        verified_at: the last passkey check, so changes to who can do what can ask for a fresh one
--   api_keys        created_by: the user who made the key in the dashboard

CREATE TABLE recovery_codes (
  code_hash   TEXT    PRIMARY KEY,
  user_id     TEXT    NOT NULL REFERENCES users (id),
  created_at  INTEGER NOT NULL,
  used_at     INTEGER
);
CREATE INDEX recovery_codes_user ON recovery_codes (user_id);

ALTER TABLE sessions ADD COLUMN verified_at INTEGER;
ALTER TABLE api_keys ADD COLUMN created_by TEXT;
