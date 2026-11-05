# Database schema

Generated from the neutral schema in `packages/schema` (`pnpm --filter @bongsu/schema generate`): don't edit by
hand. The same tables exist on every database; `migrations/sqlite/` and `migrations/postgres/` build them. Types:
`id` (a text key), `text`, `int`, `bigint`, `real`, `bool` (0 or 1), `json` (JSON as text), `timestamp` (unix
seconds), `serial` (numbered by the database). [databases.md](databases.md) explains choosing a database.

## `account_metrics`

The account series: one row per sample of an account's follower count (NULL when hidden).

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | serial | no |  | primary key |
| `account` | text | no |  | accounts.id |
| `platform` | text | no |  |  |
| `taken_at` | timestamp | no |  |  |
| `followers` | int | yes |  | followers (Instagram) or subscribers (YouTube, rounded by YouTube) |
| `workspace_id` | text | no | "default" |  |

Index `account_metrics_account`: (account, taken_at).
Index `account_metrics_ws`: (workspace_id, taken_at).

## `account_settings`

Legacy: the Trial Reels default per Instagram account before accounts.settings held it; nothing reads it now.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `account` | id | no |  | primary key; Instagram username |
| `trial_reels` | int: 0 / 1 | no |  |  |
| `updated_at` | timestamp | no | now |  |

## `accounts`

The profiles and channels Bongsu publishes to, per workspace: what the platform allows (capabilities) and the owner's choices (settings).

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | id | no |  | primary key |
| `workspace_id` | id | no |  | → `workspaces.id` |
| `platform` | text | no |  |  |
| `handle` | text | no |  |  |
| `display_name` | text | yes |  |  |
| `external_id` | text | yes |  |  |
| `connection_id` | id | yes |  | → `connections.id` |
| `capabilities` | json | no | "{}" |  |
| `settings` | json | no | "{}" |  |
| `status` | text: active / disabled | no | "active" |  |
| `sort` | int | no | 0 |  |
| `created_at` | timestamp | no |  |  |
| `updated_at` | timestamp | no |  |  |

Unique: (workspace_id, platform, handle).
Index `accounts_workspace`: (workspace_id, platform).

## `api_keys`

Agent keys and CLI tokens: only their sha256 is kept. A CLI token names its person (user_id) and runs out (expires_at).

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | id | no |  | primary key |
| `name` | text | no |  |  |
| `key_hash` | text | no |  | unique |
| `scopes` | json | no |  | JSON array |
| `created_at` | timestamp | no | now |  |
| `last_used_at` | timestamp | yes |  |  |
| `revoked_at` | timestamp | yes |  |  |
| `workspace_id` | text | no | "default" |  |
| `created_by` | text | yes |  |  |
| `user_id` | id | yes |  | → `users.id` |
| `expires_at` | timestamp | yes |  |  |

## `approvals`

What was approved, as fingerprints: the texts' sha256 and the media references, compared again before publishing.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | serial | no |  | primary key |
| `item_key` | text | no |  |  |
| `caption_sha` | text | yes |  |  |
| `comment_sha` | text | yes |  |  |
| `alt_sha` | text | yes |  |  |
| `media` | json | no | "[]" | JSON [{"driveId","md5"}], slide order |
| `approved_at` | text | no |  | UTC ISO 8601 |
| `approved_by` | text | no |  |  |
| `comment2_sha` | text | yes |  |  |
| `user_id` | text | yes |  |  |
| `due_at` | timestamp | yes |  |  |
| `account` | text | yes |  | The account (its id) the approval is for; a Shorts comment's channel. NULL only on one older than this column whose item was gone: never valid. |

Index `approvals_key`: (item_key, id).

## `audit`

Who did what, when: approvals, connections, keys, settings, notifications.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | serial | no |  | primary key |
| `at` | timestamp | no | now |  |
| `actor` | text | no |  | 'cron', 'user:<id>' (a person) or 'key:<id>' (an agent key) |
| `action` | text | no |  |  |
| `target` | text | yes |  |  |
| `detail` | json | yes |  | JSON |
| `user_id` | text | yes |  |  |
| `workspace_id` | text | yes |  |  |

Index `audit_actor_at`: (actor, at).
Index `audit_at`: (at).

## `challenges`

WebAuthn challenges in flight (sign-up, sign-in, approve), each used once.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | id | no |  | primary key |
| `challenge` | text | no |  |  |
| `purpose` | text: setup / login / approve | no |  |  |
| `data` | text | yes |  |  |
| `expires_at` | timestamp | no |  |  |

## `comment_polls`

Published posts whose new comments are checked, for 14 days after they went out.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `media_id` | id | no |  | primary key |
| `platform` | text | no |  |  |
| `account` | text | no |  |  |
| `item_key` | text | yes |  |  |
| `since` | timestamp | no |  | when it went out (polled for 14 days) |
| `checked_at` | timestamp | no | 0 |  |
| `workspace_id` | text | no | "default" |  |

## `comments`

Comments on published posts, fetched from the platforms: what the app's inbox shows.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | id | no |  | primary key; "ig:<comment id>" / "yt:<comment id>" |
| `platform` | text: ig / yt | no |  |  |
| `account` | text | no |  | Instagram username, or main / vlogs |
| `media_id` | text | no |  | Instagram media id, or YouTube video id |
| `item_key` | text | yes |  | the plan item (Instagram), or comment:<video id> (YouTube) |
| `author` | text | no |  |  |
| `text` | text | no |  |  |
| `at` | timestamp | no |  | unix seconds, when it was written |
| `own` | bool | no | 0 | ours (the self-comment, our replies): never notified |
| `seen` | bool | no | 0 |  |
| `reply_text` | text | yes |  |  |
| `replied_at` | timestamp | yes |  |  |
| `workspace_id` | text | no | "default" |  |

Index `comments_unseen`: (seen, own, at).

## `connections`

How Bongsu reaches a platform for one or more accounts: a Composio connection, an OAuth grant (encrypted credentials) or a named secret.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | id | no |  | primary key |
| `workspace_id` | id | no |  | → `workspaces.id` |
| `provider` | text | no |  |  |
| `kind` | text: composio / oauth / service | no |  |  |
| `label` | text | yes |  |  |
| `external_ref` | text | yes |  |  |
| `credentials` | text | yes |  |  |
| `secret_name` | text | yes |  |  |
| `status` | text: ok / expiring / broken | no | "ok" |  |
| `expires_at` | timestamp | yes |  |  |
| `last_error` | text | yes |  |  |
| `last_checked_at` | timestamp | yes |  |  |
| `created_at` | timestamp | no |  |  |
| `updated_at` | timestamp | no |  |  |

Index `connections_workspace`: (workspace_id).

## `drafts`

Proposed posts (from agents, the app, the Drive inbox) waiting to be scheduled or refused.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | id | no |  | primary key; random id |
| `kind` | text: reel / photo / carousel / shorts_comment | no |  |  |
| `account` | text | no |  |  |
| `payload` | json | no |  | JSON: caption, comment, time, location, media refs (Drive ids) |
| `fingerprints` | json | yes |  | JSON: caption sha256, Drive md5 per media file |
| `checks` | json | yes |  | JSON: caption lint and dry-run results |
| `source` | text: api / pwa / drive / pc | no |  |  |
| `created_by` | text | no |  | api key id, or 'owner' |
| `status` | text: draft / approved / refused / withdrawn | no | "draft" |  |
| `created_at` | timestamp | no | now |  |
| `updated_at` | timestamp | no | now |  |
| `workspace_id` | text | no | "default" |  |

Index `drafts_workspace`: (workspace_id, status).
Index `drafts_status_created`: (status, created_at).

## `inbox_seen`

Files the Drive inbox already turned into drafts, so they aren't drafted twice.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `store` | text | no |  | primary key |
| `media_id` | text | no |  | primary key |
| `draft_id` | text | no |  |  |
| `at` | timestamp | no |  |  |

Primary key: (store, media_id).

## `invites`

Invitations to a workspace: the link's token (its sha256), for one email and role, single use.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `token_hash` | id | no |  | primary key |
| `workspace_id` | id | no |  | → `workspaces.id` |
| `email` | text | no |  |  |
| `role` | text: admin / editor / creator | no |  |  |
| `invited_by` | text | no |  | users.id |
| `created_at` | timestamp | no |  |  |
| `expires_at` | timestamp | no |  |  |
| `used_at` | timestamp | yes |  |  |
| `used_by` | text | yes |  | users.id |
| `revoked_at` | timestamp | yes |  |  |

Index `invites_workspace`: (workspace_id).

## `jobs`

One per plan item due to go out: the publishing state machine the tick advances.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | serial | no |  | primary key |
| `item_key` | text | no |  | unique |
| `kind` | text | no |  |  |
| `account` | text | no |  |  |
| `due_at` | timestamp | no |  |  |
| `state` | text: pending / container_created / published / done / refused / failed / held | no | "pending" |  |
| `container_id` | text | yes |  |  |
| `children` | text | yes |  |  |
| `media_id` | text | yes |  |  |
| `permalink` | text | yes |  |  |
| `attempts` | int | no | 0 |  |
| `last_error` | text | yes |  |  |
| `dry_run` | bool | no | 1 |  |
| `created_at` | timestamp | no |  |  |
| `updated_at` | timestamp | no |  |  |
| `payload` | json | no | "{}" |  |
| `notified_at` | timestamp | yes |  |  |
| `workspace_id` | text | no | "default" |  |

Index `jobs_workspace`: (workspace_id, state).
Index `jobs_state_due`: (state, due_at).

## `locks`

Named locks with an expiry, so a slow run can't overlap the next.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `name` | id | no |  | primary key |
| `holder` | text | no |  |  |
| `expires_at` | timestamp | no |  |  |

## `media_cleanup`

Media moved aside after publishing (to the workspace folder's `_posted/`, `UPLOADS` in the first), or refused by the store.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `store` | text | no |  | primary key |
| `media_id` | text | no |  | primary key |
| `item_key` | text | no |  |  |
| `moved_at` | timestamp | yes |  |  |
| `refused` | text | yes |  |  |

Primary key: (store, media_id).
Index `media_cleanup_item`: (item_key).

## `media_store`

Media stores: the instance's (one per kind) and each workspace's own, settings, encrypted credentials, last check, the default.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | id | no |  | primary key; drive, s3, local (the instance's); drive-<workspace>, s3-<workspace> |
| `kind` | id: drive / s3 / local | no |  | MediaRef.store's kind |
| `workspace_id` | text | yes |  | the workspace it belongs to; NULL: the instance's |
| `is_default` | bool | no | 0 | where nothing names a store |
| `settings` | json | no | "{}" | nothing secret: endpoint, bucket, root… |
| `credentials` | text | yes |  | encrypted (core/crypto.ts): the S3 keys or the Drive grant |
| `status` | text: ok / broken | no | "ok" |  |
| `last_error` | text | yes |  |  |
| `last_checked_at` | timestamp | yes |  |  |
| `updated_at` | timestamp | no |  |  |
| `updated_by` | text | yes |  |  |

## `memberships`

Who belongs to which workspace, and with what role.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `workspace_id` | id | no |  | primary key; → `workspaces.id` |
| `user_id` | id | no |  | primary key; → `users.id` |
| `role` | text: admin / editor / creator | no |  |  |
| `created_at` | timestamp | no |  |  |

Primary key: (workspace_id, user_id).

## `notify_prefs`

A person's notification settings in a workspace: only the groups they changed from their role's default.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `workspace_id` | text | no |  | primary key |
| `user_id` | text | no |  | primary key |
| `grp` | text: needs_you / problems / published / inbox / digest | no |  | primary key |
| `enabled` | int | no |  | 1 or 0 |
| `updated_at` | timestamp | no |  |  |

Primary key: (workspace_id, user_id, grp).

## `oauth_apps`

The owner's own OAuth apps (Meta, Google): client id and encrypted secret.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | id | no |  | primary key; "meta", "google" (ConnectSpec.app) |
| `client_id` | text | no |  |  |
| `client_secret` | text | no |  | encrypted (core/crypto.ts) |
| `updated_at` | timestamp | no |  |  |
| `updated_by` | text | yes |  |  |

## `oauth_states`

OAuth flows in progress: the state's hash, the PKCE verifier, who started it. Single use, 15 minutes.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `state_hash` | id | no |  | primary key |
| `provider` | text | no |  |  |
| `user_id` | text | no |  |  |
| `verifier` | text | yes |  |  |
| `connection_id` | text | yes |  |  |
| `created_at` | timestamp | no |  |  |
| `expires_at` | timestamp | no |  |  |
| `used_at` | timestamp | yes |  |  |
| `workspace_id` | text | yes |  | the workspace the flow connects into; NULL: the instance's (Drive) |
| `browser_hash` | text | yes |  | sha256 of the cookie set in the browser that started the flow |
| `app_scope` | text: workspace / instance | yes |  | whose OAuth app the flow used; NULL: the instance's |

## `passkeys`

Each person's passkeys (WebAuthn credentials), with a name and last use.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | id | no |  | primary key; credential id (base64url) |
| `public_key` | text | no |  | COSE public key (base64url) |
| `counter` | int | no | 0 |  |
| `transports` | json | yes |  | JSON array |
| `name` | text | yes |  |  |
| `created_at` | timestamp | no | now |  |
| `last_used_at` | timestamp | yes |  |  |
| `user_id` | text | no | "owner" |  |

## `plan_items`

The plan: every post to publish, with its time, texts, media and options.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `item_key` | id | no |  | primary key |
| `account` | text | no |  |  |
| `folder` | text | no |  |  |
| `name` | text | no |  |  |
| `format` | text | yes |  |  |
| `options` | json | no | "{}" |  |
| `due_at` | timestamp | yes |  |  |
| `hold` | bool | no | 0 |  |
| `note` | text | yes |  |  |
| `sort` | int | no | 0 |  |
| `created_at` | timestamp | no |  |  |
| `updated_at` | timestamp | no |  |  |
| `updated_by` | text | yes |  |  |
| `content` | text: repo / db | no | "repo" |  |
| `caption` | text | yes |  |  |
| `comment` | text | yes |  |  |
| `comment2` | text | yes |  |  |
| `alt` | text | yes |  |  |
| `media` | text | yes |  |  |
| `draft_id` | text | yes |  |  |
| `title` | text | yes |  |  |
| `texts_at` | timestamp | yes |  |  |
| `texts_by` | text | yes |  |  |
| `workspace_id` | text | no | "default" |  |

Index `plan_items_workspace_due`: (workspace_id, due_at).
Index `plan_items_account_due`: (account, due_at).

## `post_metrics`

The metrics series: one row per sample of a published post's lifetime counts (NULL when the platform gives none).

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | serial | no |  | primary key |
| `item_key` | text | no |  | The plan key; 'trial:<key>' for a Trial Reel copy, 'video:<id>' for a YouTube upload |
| `account` | text | no |  |  |
| `platform` | text | no |  |  |
| `media_id` | text | no |  |  |
| `taken_at` | timestamp | no |  |  |
| `views` | int | yes |  |  |
| `reach` | int | yes |  |  |
| `likes` | int | yes |  |  |
| `comments` | int | yes |  |  |
| `saves` | int | yes |  |  |
| `shares` | int | yes |  |  |
| `workspace_id` | text | no | "default" |  |
| `follows` | int | yes |  | accounts that followed or subscribed because of this post, lifetime (NULL: not reported) |
| `profile_visits` | int | yes |  | profile visits from this post, lifetime (Instagram; NULL: not reported) |

Index `post_metrics_item`: (item_key, taken_at).
Index `post_metrics_ws`: (workspace_id, taken_at).

## `post_results`

The 24 hours result of each published post: the marker that its notification went out, and the account's median views at that time.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `item_key` | id | no |  | primary key |
| `account` | text | no |  | Instagram username |
| `media_id` | text | no |  |  |
| `median_views` | real | yes |  | the account's median views over earlier results (NULL: none yet) |
| `fetched_at` | timestamp | no |  |  |
| `workspace_id` | text | no | "default" |  |

## `posted`

What was published: by the scheduler, recorded by hand, or imported.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `item_key` | id | no |  | primary key |
| `account` | text | no |  |  |
| `media_id` | text | yes |  |  |
| `permalink` | text | yes |  |  |
| `source` | text: scheduler / manual / import | no | "scheduler" |  |
| `at` | timestamp | no | now |  |
| `published_at` | timestamp | yes |  |  |
| `workspace_id` | text | no | "default" |  |

Index `posted_account_published`: (account, published_at).

## `push_subs`

Web Push subscriptions: the devices notifications go to.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | serial | no |  | primary key |
| `endpoint` | text | no |  | unique |
| `p256dh` | text | no |  |  |
| `auth` | text | no |  |  |
| `device` | text | yes |  |  |
| `created_at` | timestamp | no | now |  |
| `last_ok_at` | timestamp | yes |  |  |
| `user_id` | text | no | "owner" |  |

## `rate_limits`

Requests per agent key per minute.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `key_id` | text | no |  | primary key |
| `window` | int | no |  | primary key; unix minute |
| `n` | int | no | 0 |  |

Primary key: (key_id, window).

## `recovery_codes`

One-time recovery codes (sha256), for signing in after every passkey is lost.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `code_hash` | id | no |  | primary key |
| `user_id` | id | no |  | → `users.id` |
| `created_at` | timestamp | no |  |  |
| `used_at` | timestamp | yes |  |  |

Index `recovery_codes_user`: (user_id).

## `sessions`

Signed-in sessions of the app and the dashboard (the token's sha256).

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `token_hash` | id | no |  | primary key |
| `created_at` | timestamp | no | now |  |
| `expires_at` | timestamp | no |  |  |
| `user_id` | text | no | "owner" |  |
| `app` | text: pwa / dashboard | no | "pwa" |  |
| `verified_at` | timestamp | yes |  |  |
| `workspace_id` | text | yes |  | the workspace the session works in; NULL: the user's first |

Index `sessions_expires`: (expires_at).

## `settings`

Instance-wide key/value settings (pause, bootstrap done, caches).

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `key` | id | no |  | primary key |
| `value` | text | no |  |  |
| `updated_at` | timestamp | no | now |  |

## `setup_codes`

One-time codes that add a device: the device creates its passkey with one.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `code_hash` | id | no |  | primary key |
| `expires_at` | timestamp | no |  |  |
| `used_at` | timestamp | yes |  |  |
| `user_id` | text | no | "owner" |  |

## `shorts_commented`

YouTube videos the Shorts comment was posted on.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `video_id` | id | no |  | primary key |
| `channel` | text | no |  |  |
| `date_pt` | text | no |  | the day in Pacific time, as yt.py logged it |
| `thread_id` | text | yes |  |  |
| `label` | text | yes |  |  |
| `source` | text: scheduler / manual / import | no | "scheduler" |  |
| `at` | timestamp | no | now |  |
| `workspace_id` | text | no | "default" |  |

## `shorts_comments`

The Shorts comment list: which video gets which comment, in order.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `video_id` | id | no |  | primary key |
| `channel` | text | no |  | the YouTube account's id |
| `file` | text | no |  |  |
| `label` | text | yes |  |  |
| `sort` | int | no | 0 |  |
| `created_at` | timestamp | no | 0 |  |
| `text` | text | yes |  |  |
| `workspace_id` | text | no | "default" |  |

## `snapshots`

Daily stats snapshots, as collected.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `day` | id | no |  | primary key; YYYY-MM-DD, the day the snapshot is for |
| `taken` | text | no |  | the snapshot's own "taken" time |
| `source` | text | no |  | 'ci' (the nightly collect), 'pc', 'backfill' |
| `data` | json | no |  | the snapshot JSON as collect.py wrote it |
| `saved_at` | timestamp | no | now |  |
| `workspace_id` | text | no | "default" |  |

## `trial_posts`

The Trial Reel copies published after their regular Reel.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `item_key` | id | no |  | primary key; the regular Reel's plan key |
| `account` | text | no |  | Instagram username |
| `media_id` | text | yes |  |  |
| `permalink` | text | yes |  |  |
| `published_at` | timestamp | yes |  |  |
| `at` | timestamp | no | now |  |
| `workspace_id` | text | no | "default" |  |

## `users`

People: the first one owns the instance. Email identifies them; passkeys sign them in.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | id | no |  | primary key |
| `email` | text | yes |  | unique |
| `name` | text | yes |  |  |
| `created_at` | timestamp | no |  |  |
| `timezone` | text | yes |  |  |
| `instance_admin` | bool | no | 0 | runs the instance: workspaces, media stores, OAuth apps |

## `workspace_oauth_apps`

A workspace's own OAuth apps (Google, Meta), used instead of the instance's for its connections.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `workspace_id` | text | no |  | primary key |
| `id` | text | no |  | primary key; the provider's app id, as oauth_apps.id |
| `client_id` | text | no |  |  |
| `client_secret` | text | no |  | encrypted (core/crypto.ts) |
| `updated_at` | timestamp | no |  |  |
| `updated_by` | text | yes |  |  |

Primary key: (workspace_id, id).

## `workspace_settings`

A workspace's time zone, daily digest hour and locale.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `workspace_id` | id | no |  | primary key; → `workspaces.id` |
| `timezone` | text | no |  | IANA name, e.g. Asia/Seoul; dates and times in the plan are in it |
| `digest_hour` | int | no |  | 0–23 |
| `locale` | text | no |  |  |
| `updated_at` | timestamp | no |  |  |
| `notify_url` | text | yes |  | the workspace's ntfy topic URL, encrypted; NULL: none |
| `paused` | json | yes |  | {reason, by, at} while the workspace's publishing is paused; NULL: running |
| `media_folder` | text | yes |  | the workspace's top folder in the media store; unique, ignoring case |

Index `workspace_settings_media_folder`: (LOWER(media_folder)), unique.

## `workspaces`

Separate sets of accounts, each with its own people.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | id | no |  | primary key |
| `name` | text | no |  |  |
| `created_at` | timestamp | no |  |  |
| `archived_at` | timestamp | yes |  | archived: nothing publishes, no one signs in to it; NULL: active |
