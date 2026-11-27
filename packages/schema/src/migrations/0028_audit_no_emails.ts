// The audit log keeps people by id, never by email (#142). New rows already do; this rewrites the old ones:
// - invite rows named the invited email: now `invite:<id>` (the invite's short hash id, as the lists show it), the
//   latest invite of that email in that workspace made by the row's time; `invite:?` when none is left;
// - the bootstrap row kept the first user's email in its detail: the row's user is them already, so it goes;
// - a new workspace's row named an invited admin's email: now `user:<id>` when an account has that email, else
//   "invite".
import type { Step } from "../migrate";

const INVITE_ACTIONS = "('invite_create', 'invite_link_copy', 'invite_revoke')";
const invites = `UPDATE audit SET target = COALESCE((SELECT 'invite:' || substr(i.token_hash, 1, 16) FROM invites i
    WHERE i.email = audit.target AND i.workspace_id = audit.workspace_id AND i.created_at <= audit.at
    ORDER BY i.created_at DESC LIMIT 1),
  'invite:?')
WHERE action IN ${INVITE_ACTIONS} AND target LIKE '%@%';`;
const bootstrap = `UPDATE audit SET detail = '{}' WHERE action = 'bootstrap' AND detail LIKE '%@%';`;

export const steps: Step[] = [
  {
    sql: {
      sqlite: `${invites}
${bootstrap}
UPDATE audit SET detail = json_set(detail, '$.admin',
    COALESCE((SELECT 'user:' || u.id FROM users u WHERE u.email = json_extract(audit.detail, '$.admin')), 'invite'))
WHERE action = 'workspace_create' AND json_extract(detail, '$.admin') LIKE '%@%';`,
      postgres: `${invites}
${bootstrap}
UPDATE audit SET detail = (detail::jsonb || jsonb_build_object('admin',
    COALESCE((SELECT 'user:' || u.id FROM users u WHERE u.email = audit.detail::jsonb->>'admin'), 'invite')))::text
WHERE action = 'workspace_create' AND detail::jsonb->>'admin' LIKE '%@%';`,
    },
  },
];
