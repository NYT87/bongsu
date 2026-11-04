# Security

## Owner

- One owner per instance, signed in with passkeys (WebAuthn). The relying party is `RP_ID`, the app's hostname.
- The first passkey needs a one-time setup code (15 minutes, stored hashed); later devices get a code from a signed-in
  session.
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

A member's role (owner, admin, approver, editor, viewer) says what they can do: approving and resuming need `approve` /
`resume`, changing the plan `plan` (`agent/auth.ts` `ROLE_SCOPES`), in the app as with a CLI token. In the dashboard,
changing connections, accounts, OAuth apps, agent keys and settings takes an owner or admin; every member reads, and
manages their own passkeys, devices and CLI tokens. A workspace's admins invite people with a one-time link (7
days; only its hash is kept), change roles and remove members; a removed member's sessions, CLI tokens and devices in
that workspace go at once, and a workspace always keeps one admin. Accepting an invite never says whether its email
already has an account.

## Agents

API keys are stored as sha256 only, have scopes, a rate limit (60/min) and can be revoked. No scope allows approving,
resuming or managing keys. The `reschedule` scope, which no default set includes, lets a key move the release date of
a scheduled YouTube video. It never makes a video public (the privacy setting is not touched), the new time must be at
least an hour ahead, and each move is audited (`release_move`) and notified. See [the API reference](api-reference.md).
The `metrics` scope, also in no default set, lets a key upload metrics samples (`ingest_metrics`, audited): numbers
only, at least an hour old, into the series the charts read; it reaches nothing an approval covers.

## Media links

Instagram downloads media from `/m/<drive id>?exp=<unix time>&sig=<HMAC-SHA256>`. Links expire (6 hours) and are
checked in constant time with `MEDIA_SIGNING_KEY`. The Drive files stay private. The local store (Node) never reads
outside its folder: a path is checked as written and where it really leads, so a symlink planted there exposes
nothing.

## Workspaces

Every row of plan data carries its workspace, and the app, the API and the MCP server act within the caller's: items,
drafts, jobs, accounts, the comments inbox and replies, manual post records. Account ids are unique across the
instance.

## Secrets

Only in Cloudflare's secret store (`wrangler secret put`), never in the repository or the wrangler files. `/health`
shows which are missing, by name only.

## Audit

Owner actions (approve, passkey added, setup code, pause/resume…) are written to the `audit` table, kept 180 days.

## Reporting a vulnerability

Report a vulnerability as described in [SECURITY.md](../../SECURITY.md): a private report on GitHub.
