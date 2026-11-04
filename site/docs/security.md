# Security

## Sign-in

- Everyone signs in with passkeys (WebAuthn). The relying party is `RP_ID`, the app's hostname.
- The first person on a new instance signs up with the `SETUP_TOKEN` and becomes the instance admin. The token is
  useless once a user exists. Anyone else joins through an invite (below).
- Later devices get a one-time code (15 minutes, stored hashed) from a signed-in session.
- Sessions are an HTTP-only cookie (`bongsu_session`).
- Approving an item, resuming a paused scheduler and moving a YouTube release date each need a fresh assertion from
  the signed-in user's own passkey, not only a session.
- A recovery code (stored hashed) signs in once when every passkey is lost; an email gets five tries in 15 minutes,
  right or wrong, so the codes can't be guessed.

## Approvals

An approval stores the account it was given for, the hashes of the caption, comments and alt texts and the store, id
and checksum of each media file. The scheduler checks them again before it creates the post, asks the plan again
(still there, same time, same account, released, the account enabled) before it publishes a container it made
earlier, and hashes the comments again before posting each one under the live post; any change means that part is not
published until it is approved again. A job whose item is put on hold is held aside (it keeps no slot of the tick's
few) and goes on, with a fresh container, once the item is released. A Shorts comment is approved the same way: its text, for its channel. Switching
to dry run stops every outside write, also for a job already under way.

## Roles

A person has a role in each workspace they belong to, and the instance has admins of its own:

| | Instance admin | Admin | Editor | Creator |
|---|---|---|---|---|
| Reaches | every workspace, as its admin | their workspaces | their workspaces | their workspaces |
| Workspaces, media stores, OAuth apps | yes | no | no | no |
| Members: invite, change role, remove | yes | yes | no | no |
| Connections, accounts, settings, agent keys (dashboard) | yes | yes | read accounts only | no |
| Connect their own accounts (app) | yes | yes | no | yes |
| Plan, texts, drafts, release dates | yes | yes | yes | yes |
| Approve, pause, resume | yes | yes | no | yes |
| Dashboard | yes | yes | yes | no, they use the app |

What a signed-in person's app session and CLI token carry comes from the role (`agent/auth.ts` `ROLE_SCOPES`):
approving and resuming need `approve` / `resume`, changing the plan `plan`. In the app, approving and resuming ask for
the person's own passkey. A person's CLI token approves exactly what it was shown (`bongsu approve`, [the CLI](cli.md))
with the rights of that person's role: an admin's or a creator's, in the token's workspace, or an instance admin's, in
whichever workspace they made it. No agent key ever approves or resumes: agent keys sit outside this table, one
workspace each, content only.

The instance admin is a flag on a user, not a membership. The first person has it; an instance admin can give it to
another member or take it away (**Make instance admin** on the dashboard's Members page, with their passkey), never
from the last one. A workspace's admins invite people with a one-time link (7
days; only its hash is kept), change roles and remove members; a removed member's sessions, CLI tokens and devices in
that workspace go at once, and a workspace always keeps one admin. Accepting an invite never says whether its email
already has an account. Archiving a workspace (instance admins) stops it completely: nothing publishes, its keys and
members are refused, its comments and metrics are no longer read, and its data stays. A workspace's audit log shows
only its own rows; the instance's (new workspaces, media stores, OAuth apps, instance admins) only its instance admins
read.

## Agents

API keys are stored as sha256 only, have scopes, a rate limit (60/min) and can be revoked. No scope allows approving,
resuming or managing keys. The `reschedule` scope, which no default set includes, lets a key move the release date of
a scheduled YouTube video. It never makes a video public (the privacy setting is not touched), the new time must be at
least an hour ahead, and each move is audited (`release_move`) and notified. See [the API reference](api-reference.md).
The `metrics` scope, also in no default set, lets a key upload metrics samples (`ingest_metrics`, audited): numbers
only, at least an hour old, into the series the charts read; it reaches nothing an approval covers.

## Connecting accounts

Connect Instagram, Connect YouTube (from the dashboard or the app) and Connect Google Drive are OAuth flows with your
own OAuth apps, whose client secrets are stored encrypted. Each flow keeps its `state` (hashed) and PKCE verifier on
the server, single use, for 15 minutes. It also belongs to the browser that started it: the start sets a random,
HTTP-only cookie (`bongsu_oauth`, `SameSite=Lax`, sent only to that flow's callback, 15 minutes) and keeps its hash, and
the callback finishes the flow only when the cookie comes back and matches, compared in constant time, before the
provider's code is exchanged; it clears the cookie either way. So a provider link sent to someone else connects nothing:
their browser has no cookie, the code is never spent and the flow can still be finished where it started. A flow
started before this check existed is refused; start it again. The connection lands in the workspace the flow started
from, if its starter may still connect there.

## Media links

Instagram downloads media from `/m/<drive id>?exp=<unix time>&sig=<HMAC-SHA256>`. Links expire (6 hours) and are
checked in constant time with `MEDIA_SIGNING_KEY`. The Drive files stay private. The local store (Node) never reads
outside its folder: a path is checked as written and where it really leads, so a symlink planted there exposes
nothing.

## Workspaces

Every row of plan data carries its workspace, and the app, the API and the MCP server act within the caller's: items,
drafts, jobs, accounts, the comments inbox and replies, manual post records. Account ids are unique across the
instance. Pausing is per workspace too. Nothing lands in a workspace nobody chose: a draft from a store's inbox goes
to the workspace of its project's plan, else to the store's **Inbox feeds** workspace, else it waits.

## Secrets

Only in Cloudflare's secret store (`wrangler secret put`), never in the repository or the wrangler files. `/health`
shows which are missing, by name only.

## Audit

Actions by people (approve, passkey added, setup code, pause/resume, members, workspaces…) are written to the `audit`
table, kept 180 days.

## Reporting a vulnerability

Report a vulnerability as described in [SECURITY.md](../../SECURITY.md): a private report on GitHub.
