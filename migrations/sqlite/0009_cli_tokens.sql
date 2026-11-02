-- CLI tokens (Phase 4b): a person's own token for the `bongsu` CLI (Phase 6). They live in api_keys beside the agent
-- keys, told apart by user_id:
--   user_id     the person the token acts as (NULL: an agent key). Its rights are that person's role in the token's
--               workspace, read on every request (scopes stays '[]'), so a changed or removed membership changes it
--               at once.
--   expires_at  when it stops working (unix seconds; NULL: never, the agent keys).
ALTER TABLE api_keys ADD COLUMN user_id TEXT REFERENCES users (id);
ALTER TABLE api_keys ADD COLUMN expires_at INTEGER;
