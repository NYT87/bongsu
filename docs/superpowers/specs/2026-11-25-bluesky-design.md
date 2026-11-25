# Bluesky (`bluesky-atproto`, issue #26)

## Intent

Bongsu publishes to Instagram and YouTube. Bluesky is the first network that is neither Meta's nor Google's, free with
no app review, and built around text. Adding it proves the platform and provider pattern of `docs/platforms.md` on a
network the code has never named, and gives the owner a second place to post that needs no approval from anyone but
themselves.

## Goals

- Plan, approve (passkey, as always) and publish **text posts and image posts** (up to 4 images, with alt text) to a
  Bluesky account at the due time.
- The first and second comment go out as replies to the post, as Instagram's go out as comments.
- Links and hashtags in the caption are clickable on Bluesky.
- The caption check and the approval page tell the owner before approval what Bluesky would refuse: over 300
  characters, over 4 images, an image over its size limit.
- A connected account is checked weekly, so a revoked app password shows up before a post fails.
- A fake of the AT Protocol endpoints in the Cloudflare test world, and a full-tick test against it. A docs page.

## Non-goals (this issue)

- Video (a separate upload service with its own job states): a later issue.
- OAuth sign-in (AT Protocol OAuth needs DPoP and client metadata hosting).
- Reading comments, replying from the app, results (likes, reposts): `comments` and `insights` stay off.
- Mentions: turning `@handle` into a link needs a handle lookup. Links and hashtags only.
- Resizing images (see Approaches).
- Cross-posting (#30).

## Anti-goals

- A post that goes out different from what was approved. Nothing may change the bytes after approval.
- A second place for the same data: the app password lives in `connections.credentials`, encrypted, like every token.

## Constraints

- `core` and `api` stay runtime-independent: `fetch` and `crypto.subtle` only; the clock and fetch are passed in.
- Approval fingerprints (texts, media, time) are unchanged; no new approval rules.
- Portable SQL, workspace filtering and the personal-data rules of AGENTS.md apply; demo accounts and `example.com` only.
- A tick step retries three times: throw for a retryable error, return a `failed` step for a final refusal.

## Approaches

**Oversized images** (Bluesky refuses an upload over about 1 MB, and photos in a store are usually bigger):

- **A. Refuse at approval (chosen).** The approval page and `plan_add` say which file is too big and by how much; the
  owner exports a smaller one. Simple, and the approved bytes are the published bytes.
- B. Resize in the provider. Needs an image library that runs on both Workers and Node, and changes the bytes after
  approval, which the approval rule forbids.
- C. Skip the images and post the text. Silent loss of what the owner approved. Rejected.

**Sign-in:** an app password pasted in (chosen: no OAuth app, no review, matches the roadmap line) over AT Protocol
OAuth (DPoP, hosted client metadata: a project of its own).

**Session:** `createSession` once per provider instance (one per run per account), no stored JWTs. An app-password
session is cheap, and storing a rotating refresh token would need a write-back path that only Instagram's refresh has.

## Design

- **Platform `bluesky`** (`platforms/bluesky.ts`, registered): formats `text` and `image`; labels "Post"; account noun
  "account"; limits `mediaMax: 4`, `captionMax: 300` (graphemes, counted with `Intl.Segmenter`), `altMax: 2000`, and a
  new optional `Limits.imageBytesMax` (1,000,000); features `firstComment`, `secondComment`, `altText`; no options;
  `lint` gives a LENGTH check in graphemes, `lintDefaults: NO_LINT`.
- **Image size check:** `resolveItem` (`api/pwa/approve.ts`) adds a problem for each image over the platform's
  `imageBytesMax`, next to the existing media-count check, so it blocks approval and shows in the app.
- **Provider `bluesky`** (`providers/bluesky.ts`): `start` signs in, fetches each image from its URL, uploads it
  (`com.atproto.repo.uploadBlob`), builds the post record (text, facets, images with alt) and creates it
  (`com.atproto.repo.createRecord`), returning a `ready` step that carries the post's uri and cid; `finish` returns the
  id, the `bsky.app` link and the time. `comment` creates a reply with the post as root and parent. `verify` returns the
  DID and handle. Facets: byte offsets in UTF-8 for links (`https://…`, with the visible text unchanged) and hashtags.
- **Registration** (`providers/index.ts`, connection provider `bluesky`): `connect` kind `token`, `pasteToken`; the paste
  is `handle:app-password`, checked with `createSession`; the grant stores it encrypted and discovers the one account
  (handle, DID as `externalId`). `keepAlive` runs `createSession` and throws `ConnectionBroken` when Bluesky says the
  password is gone.
- **Fake:** `bsky.social` endpoints in `apps/cloudflare/test/world.ts` (`createSession`, `uploadBlob`, `createRecord`);
  tests in a new `bluesky.test.ts`: a text post, a 2-image post with alt text, a reply, facets, an over-size image
  blocked at approval, a broken password, and workspace isolation of the connection.
- **Docs:** `site/docs/bluesky.md` (creating an app password, what it can do, the limits and the 1 MB rule), the
  platform table in `docs/platforms.md`, `site/docs/nav.json`, the plan's Phase 14 box, a changeset.

## Left to the builder (my calls, marked)

- The service host: `https://bsky.social` for every account (my call; a custom PDS host can be a field later).
- Whether `Limits.imageBytesMax` is checked anywhere besides approval (my call: no, the checksum pins the bytes).
- Exact error mapping from AT Protocol responses to retry or final failure (rate limits retry; a rejected record fails).
