-- Generated from packages/schema (pnpm --filter @bongsu/schema generate): don't edit by hand.

UPDATE audit SET target = COALESCE((SELECT 'invite:' || substr(i.token_hash, 1, 16) FROM invites i
    WHERE i.email = audit.target AND i.workspace_id = audit.workspace_id AND i.created_at <= audit.at
    ORDER BY i.created_at DESC LIMIT 1),
  'invite:?')
WHERE action IN ('invite_create', 'invite_link_copy', 'invite_revoke') AND target LIKE '%@%';
UPDATE audit SET detail = '{}' WHERE action = 'bootstrap' AND detail LIKE '%@%';
UPDATE audit SET detail = json_set(detail, '$.admin',
    COALESCE((SELECT 'user:' || u.id FROM users u WHERE u.email = json_extract(audit.detail, '$.admin')), 'invite'))
WHERE action = 'workspace_create' AND json_extract(detail, '$.admin') LIKE '%@%';
