# What agents can do

An agent works through an agent key, and the key's scopes decide what it may do. What it can never do doesn't depend on
the scopes: **approve, resume publishing, and manage keys are yours alone**, and they need your passkey.

## What a key can do

| Scope | What the agent can do |
|---|---|
| `read` | See the accounts, status, queue, items, jobs, notifications and drafts, and the stats (`get_metrics`, `get_account_metrics`, `list_performance`) |
| `draft` | Propose a draft (`create_draft`) and withdraw any open draft of the workspace (`withdraw_draft`) |
| `plan` | Add, change and remove plan items and their texts (`plan_add`, `plan_update`, `plan_remove`), add a YouTube Short to the comment list (`shorts_add`), record a post or comment you made by hand (`record_posted`, `record_commented`) |
| `pause` | Pause publishing (`pause_scheduler`). Resuming is yours |
| `reschedule` | Move a scheduled YouTube video's release date (`youtube_reschedule`). Not given by default |
| `metrics` | Upload metrics samples collected elsewhere (`ingest_metrics`): numbers only, at least an hour old, never the plan, texts or approvals; they show in the app's charts like sampled ones. Not given by default |

A video is never made public by an agent: the move only changes the release date, and the new time must be at least an
hour ahead. Each move is recorded and you are notified.

## What it can never do

- **Approve.** There is no tool for it, and the approval routes answer 403 to an agent key whatever its scopes.
- **Resume** after a pause, or create, change or revoke keys.
- **Publish.** The scheduler publishes, and only what you approved.

A person's CLI token is different: it acts as its person ([The command line](cli.md)). An owner's token can approve
from a terminal; an agent key never can.

## Why a change needs a new approval

Your approval covers the exact texts and media of a post (caption, comments and alt texts, and the media files'
checksums), its account and its time. When an agent changes any of them, what you approved is no longer what would go
out, so the post goes back to **Re-approve** and nothing is published until you look again. If only the comments
change, the post stays approved and you approve the comments.

An approval is also good for one account: removing a post and planning it again for another account needs a new one.
The owner's view of this is in [The phone app](the-app.md#after-a-change) and [How it works](how-it-works.md).

## Drafts

An agent that isn't sure can propose instead of planning: `create_draft` leaves a draft for you, and you schedule it or
refuse it from **Drafts** in the app ([The phone app](the-app.md#drafts)). Nothing in Drafts is published until you
schedule and approve it. A key can withdraw an open draft with `withdraw_draft`: any open draft of its workspace,
including ones it didn't create (yours, the inbox's or another key's), never one of another workspace.

## Texts

`plan_add` and `plan_update` set the caption, the comment from your own account, an optional second comment and the
alt texts; `shorts_add` sets the text of a comment on a YouTube Short. They are the texts Bongsu posts: an agent
can't fix a caption by editing a file in a repository, because Bongsu reads only its own copy. The caption check
([Captions and checks](captions-and-checks.md)) runs on them like on yours, and a post that fails it can't be approved.

## Times and zones

Times are stored in UTC and shown in the zone of your workspace. An agent reads each time twice:

- `due`, on the workspace's clock: `2026-10-20 18:00 Asia/Seoul`.
- `due_at`, ISO 8601 in UTC: `2026-10-20T09:00:00Z`.

To write a time it gives either `at`, an instant with its zone (`2026-10-20T18:00+09:00` or `2026-10-20T09:00:00Z`; one
without a zone is refused), or `date` (`YYYY-MM-DD`) and `time` (`HH:MM`) on the workspace's clock. With no time, Reels
go at 18:00 and posts at 19:00. `get_status` tells an agent your zone and today's date.

## Limits

- **One post per account per hour.** Planning into a taken hour is refused (409) and the answer lists free hours.
- **Rate limit:** 60 requests a minute per key.
- **Your workspace only.** A key belongs to one workspace and sees only its accounts, plan, drafts and jobs. An item of
  another workspace looks as if it didn't exist (404).
- **Unknown options are refused.** The account's platform decides which `format` and `options` a post may have.

## Seeing what happened

An agent's changes show up in the queue and on the item pages like yours, and the dashboard's Audit page lists them. If you don't trust
a key any more, revoke it in **Keys & tokens**.

Agents work best when you tell them the plan: which account, which day, what the post is for. A post's media are files in your own
storage, and you check them when you approve. Several posts a day on one account are fine, at different hours.

Next: [Connect Claude](connect-claude.md), the [API reference](api-reference.md).
