-- Generated from packages/schema (pnpm --filter @bongsu/schema generate): don't edit by hand.

UPDATE audit SET target = COALESCE((SELECT 'invite:' || substr(i.token_hash, 1, 16) FROM invites i
    WHERE i.email = audit.target AND i.workspace_id = audit.workspace_id AND i.created_at <= audit.at
    ORDER BY i.created_at DESC LIMIT 1),
  'invite:?')
WHERE action IN ('invite_create', 'invite_link_copy', 'invite_revoke') AND target LIKE '%@%';
UPDATE audit SET detail = '{}' WHERE action = 'bootstrap' AND detail LIKE '%@%';
UPDATE audit SET detail = (detail::jsonb || jsonb_build_object('admin',
    COALESCE((SELECT 'user:' || u.id FROM users u WHERE u.email = audit.detail::jsonb->>'admin'), 'invite')))::text
WHERE action = 'workspace_create' AND detail::jsonb->>'admin' LIKE '%@%';
