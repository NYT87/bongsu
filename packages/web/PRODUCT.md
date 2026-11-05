# Product

<!-- impeccable:product-schema 1 -->

Scope: the **Bongsu app** (`packages/web`, served by the `bongsu` Worker at
https://bongsu.example.com).

## Platform

web

Installable PWA (`public/manifest.webmanifest`, `display: standalone`, service worker `public/sw.js`), used mostly on a phone.

## Users

One user: the creator who owns the channels and accounts. Confirmed 2026-10-21: no helpers, editors or other creators use
it. Mostly on the phone, away from the computer: checking what goes out today, approving, and scheduling drafts on the go.

## Product Purpose

Publishes the creator's approved content on time without a computer switched on: Instagram Reels, photo and carousel posts,
and the self-comments on YouTube Shorts. The app is where the creator sees what is planned and what went out, approves
items, turns Drive-inbox or phone uploads into scheduled drafts, and stops publishing if something is wrong.

Success: nothing posts that wasn't approved, nothing approved is missed, and the creator can check and act from the phone
in seconds.

## Positioning

A one-person control room for the creator's own pipeline, not a general social-media scheduler. Its plan comes from the
creator's repo and Drive (captions, `*.comment.txt`, `alt.txt`, media), every post needs a person's passkey approval,
and it covers both YouTube (Shorts comments) and Instagram in one queue.

## Operating Context

- **Sections:** Today, Calendar, Queue, Drafts, Stats, Settings, plus an item page for approving.
- **Results:** a published Instagram item's page splits into **Results | Post** (Results first once it has its 24 h
  numbers; `#/item/<key>/results` opens it, and the 24 h notification's button lands there, a Trial Reel's on its
  Reel). Results is the 24 h numbers (with the followers and profile visits the post brought, when Instagram reports
  them), then a chart of the metrics series (Total | Daily; views, reach, likes, comments, saves, shares, followers,
  profile visits) with the Trial Reel copy as a second line. A YouTube video's page splits into **Results | Video**
  once its series has samples (views, likes, comments, and the subscribers it gained when the channel was connected
  with the analytics scope; otherwise a line says to reconnect it).
- **Stats and the channel page:** the Stats page lists each account with its follower count and the change since a
  day before (from the account series, sampled once a day), then the posts and videos of the last 7 days, most viewed
  first, each opening its Results or video page. An account's page charts its followers (Total | Daily) and
  the views its posts added per day over 7, 30 or 90 days, and ranks the posts and videos that brought followers, each
  opening its Results or video page.
- **Accounts:** a few Instagram accounts (Reels, posts, stories) and YouTube channels (Shorts comments, and moving a scheduled video's release date), configured
  per instance.
- **Inputs:** plan items in D1 (added through the `bongsu` MCP tools or `/v1`, or in the app), the Drive inbox
  (the workspace's folder, shown in Settings → Media: `inbox/<project>/`, becomes a draft within ~25 min), and **New draft** uploads from the device.
- **Rituals:** the daily digest (from the workspace's digest hour), push and ntfy notifications with action buttons, approving from the
  notification or the item page, recording manual posts so they are never posted twice.
- **Languages in the content:** English, Spanish and Korean captions and comments. The interface is English; its text lives in `src/i18n.ts` (a catalogue per locale, the workspace's locale from `/app-api/me`).
- **Time zone:** the schedule is in the workspace's time zone, shown next to every time.

## Capabilities and Constraints

- Passkey sign-in (WebAuthn). **Only a person approves and resumes** (the workspace's admins and creators; never an
  editor), each with a fresh passkey assertion; agent keys can plan but never approve. Holding a single item needs no
  passkey (it only stops it; the approval is kept).
- Rescheduling an approved item needs a new approval.
- A person moves a YouTube video's release date with a passkey. Agent keys can only with the `reschedule` scope and at
  least an hour's lead.
- **Pause** stops publishing in this workspace (the others go on); only an admin or creator resumes, in the app.
- Publishing is immediate on Instagram's side and can't be undone through the API, so approval and the preview of
  exactly what will go out (media, caption, alt text, comment, account, time) matter more than speed.
- Cloudflare Workers + D1 on the free plan; media reaches Instagram through signed links to Drive. Posted media moves to
  the folder's `_posted/` a day later (move only, never deleted).
- Stack: React 19 + Vite + TypeScript (`packages/web`), served by the Worker (`apps/cloudflare`) or the Node app. Light and dark themes
  follow the device (`prefers-color-scheme`).

## Evidence on Hand

- Live since 2026-10-18; plan, approvals, posted history and jobs in D1.
- Real content to show in the UI: the repo's captions and comments under `channels/*/CONTENT/` and the media on Drive.
- Performance numbers come only from the metrics Bongsu samples or receives (`ingest_metrics`) and imported snapshots;
  nothing else may be presented as stats.

## Product Principles

1. **Nothing goes out unseen.** Show exactly what will be published, where and when, before it can be approved.
2. **Phone first, seconds per check.** Today's state and the next action are reachable with one thumb.
3. **People hold the keys.** Approve, resume and anything irreversible need a person's passkey; automation proposes,
   people decide.
4. **Honest state.** Failures, holds, missing media and paused publishing are shown plainly, never hidden behind success.
