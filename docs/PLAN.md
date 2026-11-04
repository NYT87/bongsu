# Bongsu: implementation plan

Status: public on GitHub (https://github.com/NYT87/bongsu) since 2026-11-02; the private GitLab project is a mirror
that keeps the history from before then. Decisions D1–D3 made: name **Bongsu**, MIT, private on GitLab until the
public release on GitHub.

Goal: a standalone, open-source publishing scheduler that anyone can deploy for their own accounts, built from a
private scheduler's code.

---

## 0. Decisions to make first

| # | Decision | Options | Recommendation |
|---|---|---|---|
| D1 | Name | — | **decided: Bongsu** (check the npm name and GitHub org before Phase 10) |
| D2 | License | — | **decided: MIT** |
| D3 | Host | — | **decided: private on GitLab while building; public on GitHub at release (Phase 10)** |
| D4 | Scope of v1 | Instagram (Reels, posts, carousels, stories, Trial Reels, comments) + YouTube Shorts comments, as today / also TikTok, X… | today's scope; platforms stay pluggable (section 2.3) |
| D5 | Instagram access | Composio (as now) / Instagram Graph API directly / both | both: Graph API as the default, Composio as an option (section 2.3) |
| D6 | Runtimes | Cloudflare only / Cloudflare + Node (Docker) | both, Cloudflare first-class (section 2.1) |
| D7 | PC tooling language | keep Python / one TypeScript CLI | TypeScript CLI: one language, one install (`npx bongsu`) |
| D8 | Stats module in v1 | ship the Stats page + snapshot API / leave out until later | later phase (Phase 9); v1 ships without it |
| D9 | How accounts get connected | CLI and pasted secrets / a management dashboard in the app | **decided: a management dashboard** (Phase 4b): the owner connects Instagram, YouTube and Drive with buttons, and manages devices and agent keys there. The CLI is for scripting |
| D10 | Whose OAuth apps | bring your own Meta/Google app / connect through Composio / a hosted Bongsu Connect | **decided: the first two** for v1. A hosted connect service would make Bongsu a SaaS (D11) |
| D11 | SaaS | — | **not in the plan.** Bongsu is self-hosted, with a management dashboard. A hosted service may come later; until then, avoid choices that would block it (section 2.7) |
| D12 | Apps | one app / **two apps** | **decided: two apps** (section 2.8). The **dashboard** does everything that's scripts or manual setup today (connections, accounts, settings, keys, members) and registers the phones. The **PWA** stays as it is: see the plan, edit, approve |
| D13 | Dashboard sign-in | passkey only / **email + passkey** | **decided: email + passkey.** The email identifies the user (sign-in, invites, member lists); the passkey is the credential. Sending email is optional |
| D14 | Workspaces | one set of accounts per deployment / **workspaces with members** | **decided: workspaces.** The data model lands in Phase 3 (one default workspace); the feature (several workspaces, invites, roles) comes after v1 (Phase 13) |
| D15 | Databases | SQLite family only / **SQLite family + Postgres, from one neutral schema** | **decided: one neutral schema** (section 2.9) generating the SQL for SQLite/D1/Turso and Postgres; other databases get a generator or the documented schema. MySQL only if someone needs it |

---

## 1. Principles

1. **Fresh history.** The original code's history held captions, approvals, account IDs and planning
   notes. The new repository starts from cleaned code. Personal data is scrubbed before the first commit (Phase 1); as
   a safety net, the history is squashed again before it goes public (Phase 10).
2. **Running instances keep running.** An update never needs a change by hand to a live instance: migrations are
   tested on a copy of a database first and can be rolled back (Phase 11).
3. **One source of truth.** The database holds the plan, texts, approvals, accounts and settings. Media stays in the
   media store (Drive). No component reads the same data from two places.
4. **No personal data in code.** Accounts, time zone, URLs, IDs and wording come from the instance's configuration or
   database. The code ships with none.
5. **Approval stays human.** Agent keys can plan, edit and propose; only a person with the approve right (a passkey,
   or a CLI token created with one) can approve or resume.
6. **The dashboard sets up, the PWA runs the day, the CLI scripts.** Connections, accounts, settings, devices, agent
   keys and members are managed in the dashboard after one bootstrap step; the phone app only sees, edits and
   approves; nothing needs a terminal once the instance is deployed.
7. **The free tier stays possible.** The Cloudflare build keeps the current limits in mind (10 ms CPU per cron
   invocation, 50 subrequests, separate cron Worker).

---

## 2. Target architecture

### 2.1 Repository layout

```
bongsu/
  packages/
    core/          runtime-agnostic logic: plan, jobs, tick, approvals, texts, trial switch, caption lint,
                   notifications, digest, results, comments, clients. Depends only on the ports in 2.2.
    api/           the Hono app (createApp): /app-api (pwa/, today's owner/), /admin-api (dashboard/), /v1 + /mcp
                   (agent/, one set of tool definitions), /m (signed media links), /health
    web/           the PWA (React + Vite), as today: today, calendar, queue, drafts, item pages, approve, comments
    dashboard/     the management dashboard (React + Vite, desktop first): setup wizard, connections, accounts,
                   settings, phones, agent keys, CLI tokens, audit; later workspaces and members (Phase 4b, 13)
    cli/           npm package `bongsu` for scripting: login (owner token), approve, texts, status, export,
                   deploy-secrets; `bongsu mcp` as a local stdio bridge to /mcp (Phase 6). Setup lives in the dashboard
    providers/     instagram-graph, instagram-composio, youtube, drive (starts inside core/clients; split in Phase 4)
  apps/
    cloudflare/    the two Workers (fetch + scheduled), wrangler configs, setup-secrets.sh, integration tests
    node/          @hono/node-server, SQLite adapter (better-sqlite3), node-cron, Dockerfile, docker-compose.yml
  schema/          the neutral schema (tables.ts) and its migration steps: the one source for every database (2.9)
  migrations/      generated SQL per dialect: sqlite/ (D1, SQLite, Turso) and postgres/; never edited by hand
  site/docs/       the public guides (built into the site and the dashboard)
  docs/            the internal documentation (the README stays short and links here)
  examples/        example config, a sample repo importer script (copying texts from a content repository)
```

pnpm workspaces (no Turborepo/Nx until CI needs a build cache). Packages export their TypeScript sources by path
(`@bongsu/core/tick`); the runtimes' bundlers compile them, so there is no package build step. TypeScript strict
everywhere. Hono already runs on both runtimes.

### 2.2 Ports (the only things a runtime provides)

| Port | Interface | Cloudflare | Node |
|---|---|---|---|
| `Db` | `prepare(sql).bind(...).first/all/run`, `batch([...])` (the subset of D1 the code uses today: ~250 `prepare` calls, `batch` in 4 files) | D1 binding, passed through | better-sqlite3 wrapped to the same shape; `batch` = a transaction |
| `Clock` | `now()`; schedule entry `runSchedule(name, at)` | `scheduled()` with the three cron expressions | node-cron calling the same `runSchedule` |
| `Fetch` | `fetch` (already injected as `realFetch` / `deps.fetch`) | global fetch, unbound | global fetch (Node 22) |
| `Secrets` | typed `Config` object built once at startup | `env` bindings | `process.env` / `.env` |
| `Assets` | serve the PWA's static files | Workers assets | `serveStatic` from `packages/web/dist` |
| `Crypto` | WebCrypto (HMAC links, WebAuthn, VAPID) | built in | built in (`globalThis.crypto`, Node 22) |

Done in Phase 2 without a new `Ctx` type: `Env` (core/env.ts) is already runtime-neutral (its `DB` is the `Db` port,
the rest are strings), the fetch is injected (`deps.fetch`, `createApp(fetcher)`) and so is the clock (`deps.now`). A
runtime builds an `Env` object and calls the same functions.

A **Db conformance test suite** runs the same core tests against D1 (vitest Workers pool) and against better-sqlite3
(plain vitest), so the two runtimes can't drift.

### 2.3 Providers

The first design, kept for history: Phase 4 built `InstagramApi` (`providers/instagram.ts`) for the two ways to reach
Instagram. **Section 2.10 generalizes it** to any platform (platforms with capabilities, providers as resumable
publishers); new work follows 2.10.

```ts
interface SocialProvider {
  id: "instagram-graph" | "instagram-composio" | "youtube";
  capabilities(account): { reels; posts; carousels; stories; trialReels; comments; insights };
  publish(account, item, media): Promise<PublishStep>;   // container create → poll → publish, resumable per tick
  comment(account, mediaId, text): Promise<string>;
  results(account, mediaId): Promise<Results>;
  listComments(account, since): Promise<Comment[]>;
  verify(account): Promise<{ ok; username; followers? }>;
}
interface MediaStore { ... }   // see 2.4 below
```

- **instagram-graph** (new): Instagram API with Instagram Login. The owner pastes a long-lived token (or does an OAuth
  flow from the app), and the cron refreshes it before its 60 days run out. `trial_params` is a plain field here, so
  the Composio workbench workaround (and its "default account only" limit) disappears.
- **instagram-composio** (today's `clients/composio.ts`): kept for people who already use Composio. Document the
  default-connection limit for Trial Reels.
- **youtube** (today's `clients/youtube.ts`): Shorts comments, per-channel OAuth.
- **drive** (today's `clients/drive.ts`, `clients/google.ts`): service account for reads, optional owner OAuth
  (`drive.file`) for uploads from the app.

### 2.4 Media stores

Media (the Reels, photos and covers) stays in a store the owner controls; the database only references it. Drive is
the first store; the interface is written so others can be added without touching the core.

**Where Drive is wired in today** (what Phase 4 has to route through the interface):

| Use | Code | Drive calls |
|---|---|---|
| Verify media before publishing | `core/tick.ts` | `meta` |
| Stream media to Instagram through `/m/` | `core/media.ts` | `meta`, `media(range)` |
| Drive inbox → drafts | `core/inbox.ts` | `findPath`, `list`, `text` (caption files dropped with the media) |
| Move posted media aside | `core/cleanup.ts` | `findPath`, `parents`, `mkdir`, `move` |
| Item media and previews | `api/owner/approve.ts` | `findPath`, `list`, `meta` |
| Uploads from the app | `api/owner/uploads.ts` | Drive REST directly: resumable upload session, folder create and share |
| References in the database | `plan_items.media`, `approvals`, `drafts`, `inbox_seen`, `drive_cleanup` | `[{driveId, md5}]`, Drive ids as keys |

**The interface** (`packages/core/src/media/store.ts`):

```ts
interface MediaRef { store: string; id: string; checksum: string }   // checksum: whatever the store guarantees
interface MediaEntry { id: string; name: string; mime: string; size: number; checksum: string; modifiedAt: string; folder: boolean }

interface MediaStore {
  id: "drive" | "r2" | "s3" | "local" | string;
  stat(id): Promise<MediaEntry | null>;                    // null when missing or trashed
  stream(id, range?: string): Promise<Response>;           // supports Range (Instagram requests ranges)
  readText(id): Promise<string>;                           // caption / comment files in the inbox
  resolve(path): Promise<MediaEntry | null>;               // "UPLOADS/inbox/<project>" relative to the store's root
  list(folderId): Promise<MediaEntry[]>;
  ensureFolder(path): Promise<string>;
  move(id, toFolderPath): Promise<void>;                   // move only: nothing is ever deleted by Bongsu
  // optional capabilities
  publicUrl?(id, ttlS): Promise<string>;                   // presigned URL: Instagram fetches the store directly
  createUpload?(name, folderPath, mime, origin): Promise<{ url: string; method: "PUT" | "POST"; headers: Record<string, string> }>;
}
```

- **Paths are logical** (`UPLOADS/inbox/<project>/`, `UPLOADS/_posted/`) and relative to a root the store is
  configured with: a Drive folder, a bucket prefix, a directory.
- **Checksums are opaque.** An approval stores the store id, file id and checksum (Drive md5, S3/R2 ETag or md5, a
  sha256 for local files). The tick only compares them for equality, so any store works; switching stores means
  approving again.
- **Instagram's fetch:** if the store has `publicUrl` (R2, S3), the container is created with a presigned URL and the
  media never passes through the Worker; otherwise the signed `/m/` proxy streams it (as Drive does now).
- **Uploads from the app:** if the store has `createUpload`, the browser uploads straight to it (Drive resumable
  session, S3/R2 presigned PUT); otherwise the app hides the upload button.
- **Move semantics:** stores without a native move (S3, R2) copy then remove the original; it is still a move, and no
  file leaves the store.
- **Several stores per instance, one of each kind** (Phase 12), set up in the dashboard and kept in `media_store`;
  every reference names its store, one store is the default. Per-account stores only if someone needs them.

**Stores, in order:**

| Store | When | Notes |
|---|---|---|
| `drive` | Phase 4; Phase 12 | the owner's OAuth grant (Connect Google Drive, scope `drive`) for reads, moves and uploads |
| `s3` | Phase 12 | any S3-compatible service (AWS, Cloudflare R2, Backblaze B2, MinIO), signed with `aws4fetch` (web-standard, runs on both runtimes); presigned GETs and PUTs. R2 goes through its S3 API: its Worker binding can't presign |
| `local` | with the Node runtime (Phase 5) | a directory on the server's disk; `/m/` serves it |
| Dropbox, OneDrive… | community | the same interface; the conformance tests define what "works" means |

**Tests:** one conformance suite (stat, ranged stream, list, resolve, move, upload when offered) runs against every
store: the fake Drive in `test/world.ts`, an in-memory store, Miniflare's R2 and a temporary directory.

### 2.5 Configuration moves into the database

| Today (hardcoded) | New home |
|---|---|
| `config.ts` `IG_QUEUES` (dir, Composio connection, IG user id, username, `trialCapable`) | `accounts` table: id, platform, provider, handle, external id, connection ref, capabilities, settings JSON. Managed in the dashboard (Phase 4b) |
| `config.ts` `SHORTS_CHANNELS`, one YouTube OAuth secret per channel | `accounts` rows (platform `youtube`) and a `connections` row each; OAuth refresh tokens stored **encrypted** with a single `ENCRYPTION_KEY` secret, made by the dashboard's **Connect YouTube** (Phase 4b), so adding an account needs no redeploy |
| `DRIVE_SA_JSON`, `DRIVE_OWNER_OAUTH` secrets | a Drive connection made with **Connect Google Drive** (owner OAuth); the service account stays as an option |
| `COMPOSIO_CONSUMER_KEY` secret | a Composio connection (its key stored encrypted), only when Composio is used |
| `account_settings` (trial default) | merged into `accounts.settings` |
| a fixed time zone and digest hour | `workspace_settings`: `timezone`, `digest_hour`, `locale` |
| `PUBLIC_URL`, `RP_ID`, VAPID subject in `wrangler.toml` | runtime config (env), documented in the example files |
| `App.tsx` `CHANNEL_NAME`, `performance.ts` `accountUrl` | derived from `accounts` (display name, profile URL) |
| MCP tool descriptions naming accounts (`api/tools.ts`) | generic text; the account list is returned by a `list_accounts` tool |
| `dir` = repo folder (`channels/<ch>/INSTAGRAM`) | gone. Items belong to an account and an optional `project` label |
| `CATCH_UP_S`, `MAX_POLLS`, `JOBS_PER_TICK`, `LINK_TTL_S` | constants with env overrides |

### 2.6 What stays out of the project

Importers for one person's repository layout, file mirrors of the plan, one-off scripts and fixtures with real
captions. The project offers the API (`plan_update` with texts), `examples/repo-importer` and `bongsu export` (JSON,
CSV) for the same jobs.

---

### 2.7 Staying SaaS-ready without building a SaaS

A hosted, multi-customer Bongsu is not a goal now (D11). The design only avoids closing that door:

- No code assumes a single account, connection or device: everything is a row, looked up by id.
- Connections and their tokens sit behind one module (`core/connections.ts`), so a hosted "Bongsu Connect" with verified
  Meta/Google apps could be added later as a third way to connect (D10).
- Users, workspaces and memberships are in the data model from Phase 3 (D14), so a hosted version wouldn't need a
  schema rewrite.
- Not now: open sign-up, per-customer limits, billing, Meta app review and Google verification for other people's
  accounts, a privacy policy for holding their tokens.

### 2.8 Two apps: the dashboard and the PWA

| | Dashboard | PWA |
|---|---|---|
| For | setting up and managing (what scripts and manual steps do today) | the daily work, mostly on the phone |
| Pages | setup wizard, connections, OAuth apps, accounts (capabilities, Trial Reels default, caption rules), videos (YouTube release dates), media store, instance settings, phones and passkeys, agent keys, CLI tokens, audit; later workspaces, members, invites | today, calendar, queue, drafts, item page (texts, cover, location, per-Reel Trial switch, approve), comments, this device's notifications |
| Sign-in | email + passkey | a passkey registered from the dashboard |
| Session | shorter; connecting accounts, keys, members and passkeys need a fresh passkey check | long-lived on the phone; approving needs a fresh passkey check (as today) |
| Package | `packages/dashboard` | `packages/web` |
| API | `/admin-api` | `/app-api` |

- **One deployment, one hostname.** The Worker serves the PWA at `/` and the dashboard at `/dashboard`. Same host means
  the same passkey relying party (`RP_ID`), so a user's passkeys work in both.
- **Users are people.** A user has an email, a name and passkeys. The first user is created by the bootstrap
  (`SETUP_TOKEN`): email, then a passkey.
- **Registering a phone:** dashboard → Phones → **Add a phone** shows a QR code and a one-time code (today's setup code,
  now tied to a user). The phone opens it, creates a passkey and lands signed in to the PWA. The phone is listed under
  that user, with its push subscription, and can be renamed or revoked from the dashboard.
- **Email** is the identifier, not a password. Sending it is optional: with an email provider configured (a small
  `Mailer` port: Resend, SMTP relay…), invites and connection alerts go by email; without one, invite links are copied
  by hand.
- **Recovery:** several passkeys per user (laptop, phone, a security key), one-time recovery codes shown at sign-up,
  and an owner can reset another member's passkeys.
- What moves out of today's PWA: **Add another device**, the account page (Trial Reels default) and any setup pages.
  The PWA keeps everything about items, including the per-Reel switches.

---

### 2.9 Databases: one neutral schema

The database is reached only through the `Db` port (2.2). To support more than the SQLite family, the schema itself is
written once, without any database's SQL, and each database's SQL is generated from it.

- **`schema/tables.ts`:** every table, column, index, unique key and check, with a few abstract types: `id` (text),
  `text`, `int`, `bigint`, `bool`, `json`, `timestamp` (unix seconds as `bigint`), `enum(...)` (a check constraint).
  Each table and column carries a one-line description.
- **`schema/migrations/NNNN_<name>.ts`:** each schema change as neutral steps (`createTable`, `addColumn`,
  `createIndex`, `renameColumn`, data steps written per dialect only when unavoidable). `tables.ts` is the result of
  applying them all; a test checks the two agree.
- **`pnpm schema:generate`** writes `migrations/sqlite/NNNN_<name>.sql` and `migrations/postgres/NNNN_<name>.sql`
  (wrangler and the Node runner apply those). CI fails if the generated files are out of date, so they can't drift
  from the source.
- **For anyone using another database:**
  - `docs/schema.md`, generated: every table and column with its type and description, readable without the code.
  - `schema/schema.json`, generated: the same as data, for other tools (an ORM, a different migration tool, a
    generator someone writes for MySQL, SQL Server…).
  - `bongsu schema --dialect <sqlite|postgres>` prints the full DDL for a fresh database (the CLI, Phase 6).
  - Adding a dialect means one generator (a type map plus a few statement templates) and one `Db` adapter; the
    conformance suite says whether it works.
- **Portable queries:** the code's SQL stays in the common subset (`ON CONFLICT … DO UPDATE`, `RETURNING`, no
  `unixepoch()`, timestamps passed in by the app); the few dialect-specific bits (`json_each`, table listing) live in
  per-dialect helpers. A test fails on SQLite-only functions outside them.
- **Moving data between databases:** `bongsu export` / `bongsu import` in a neutral JSON format (per table, in
  dependency order), e.g. from D1 to Postgres.

### 2.10 Platforms and providers: more than Instagram and YouTube

Bongsu starts with Instagram and YouTube, but X, TikTok, Threads, Bluesky, LinkedIn… must plug in without touching the
core. Two layers:

- **Platform** (`packages/core/src/platforms/<id>.ts`): what the network allows, as data the rest of the code reads
  instead of `if (instagram)`:

  ```ts
  interface Platform {
    id: "instagram" | "youtube" | string;
    name: string;
    formats: ("video" | "image" | "carousel" | "story" | "text")[];
    limits: { mediaMax; videoSecondsMax; aspect?; captionMax; hashtagsMax?; altMax? };
    features: { firstComment; secondComment; altText; location; coverFrame; trial; comments; insights; nativeSchedule };
    options: OptionSpec[];      // platform-specific choices on a post (Instagram: trial, cover; TikTok: privacy…)
    lint(caption, post): Check[];  // the caption check's rules for this network
  }
  ```

- **Provider** (`packages/core/src/providers/<id>.ts`): one way to reach a platform (`instagram-graph`,
  `instagram-composio`, `youtube-data`, later `x-api`, `tiktok-content`…), chosen by the account's connection.
  Publishing is a resumable state machine, one step per cron run, so a slow network never blocks a run:

  ```ts
  interface Provider {
    id: string; platform: string;
    connect: { kind: "oauth2" | "token" | "composio"; authorizeUrl?; tokenUrl?; scopes?; refresh? };  // for 4b
    start(post, media, ctx): Promise<Step>;   // e.g. create a container / start an upload / post at once
    check(step, ctx): Promise<Step>;          // processing → ready | failed (polled each run)
    finish(step, ctx): Promise<Published>;    // publish; returns {mediaId, permalink, publishedAt}
    comment?(mediaId, text); reply?(commentId, text); comments?(mediaId); results?(mediaId, metrics);
    verify(): Promise<{ id; username; followers? }>;
    refresh?(credentials): Promise<credentials>;
  }
  ```

  Instagram fits it as container → status → publish; TikTok as upload → status → publish; X or Bluesky as a single
  `start` that is already `ready`. A provider registers itself in `providers/index.ts`; adding a network is a platform
  file, a provider file, its fake in the test world and a docs page (`docs/platforms.md` says how).

- **Content model.** A planned item is "a post to one account": `format` (one of the platform's formats), its media
  (store references, 2.4), its texts (caption, first and second comment, alt) and an `options` JSON validated against
  the platform's `OptionSpec`s. Instagram's `trial`, `cover_ms`, `location` and story format move into `options`; the
  platform comes from the account. Item keys are opaque ids (nothing parses them; existing keys stay). Approvals don't change: they fingerprint
  texts, media and time, which works for any network.
- **YouTube** becomes a platform whose provider can comment on existing posts: the Shorts comments are "a first
  comment on a post published elsewhere" (`comment` without `start`), not their own flow. Uploading Shorts can come
  later through the same `start`/`check`/`finish`.
- **Everything around it reads capabilities:** the tick (no Instagram steps in it), the app (cover frame, Trial Reel,
  location shown only when the platform has them; event kinds per platform), the calendar and digest, the agent API
  (`list_accounts` returns each account's platform and capabilities), the caption check (the platform's rules).
- **The database** stops hard-coding networks: `accounts.platform` and `connections.provider` are checked against the
  registry in code, not by a CHECK listing two names.
- **Realities per network** go in each provider's docs: TikTok's Content Posting API needs an app audit before posts
  can be public (until then they're private to the account); X's API is paid beyond a small free tier; Threads and
  Bluesky have free APIs. None of them are built before v1 (Phase 14).

---

## 3. Phases

Rough effort in working sessions (one session ≈ a few focused hours). Each phase ends with all tests green.

### Phase 1: Private repository and scrubbed import (1 session) — done locally 2026-10-27

- [x] Choose D1–D3 (Bongsu, MIT, private GitLab → public GitHub).
- [x] Copy the Worker, the app and `setup-secrets.sh` into the new repository (the Python tools are left out: Phase 6
      replaces them with the CLI).
- [x] Scrub before the first commit:
  - [x] `config.ts` keeps its shape with demo accounts (`demo_travel`, `demo_running`, `demo_cycling`, Composio
        connections `instagram_conn-a/b/c`, ids `178414000000000xx`); YouTube channels `main` / `vlogs`
        (`YT_MAIN_OAUTH`). Phase 3 replaces the file with the `accounts` table.
  - [x] `wrangler*.toml` with placeholders (`bongsu.example.com`, zero database id, VAPID placeholder,
        `owner@example.com`) and `DRY_RUN = "1"` by default. A real deployment keeps its own copy outside the repo.
  - [x] Golden fixtures (real queues and captions) and their test removed; the caption lint test now runs on 14
        synthetic and edge-case captions, with expected results produced by the original Python lint.
  - [x] The 18 migrations squashed into `migrations/0001_init.sql` (schema only: `0006` held real media ids).
  - [x] Personal strings replaced (handles, ids, connection names, URLs, emails, channel names, project and
        place names); the grep list finds nothing outside lockfiles' regenerated names.
  - [ ] Comments that reference the old plan's phases, dates and "(user)" notes: rewrite as plain
        explanations (moved to Phase 2, as each module moves).
- [ ] `gitleaks detect --no-git` (gitleaks isn't installed here; a regex scan for keys and tokens found only the test
      world's generated throwaway PEM). Run it before pushing.
- [x] First commit: the code (still Cloudflare-only), MIT license, a short README, `docs/` (overview, architecture,
      deploy, configuration, agents, security, development, this plan), `.gitignore`, `.editorconfig`.
      Author: NYT87 <nyt87@proton.me> (https://github.com/NYT87).
- [x] CI (`.gitlab-ci.yml`): typecheck, the vitest suite and the app build on every push.
- [x] Private GitLab project `nyt87/bongsu` created and pushed.

**Done when:** the private repo builds and its tests pass with fake config (103 tests), and the grep list finds nothing.

### Phase 2: Monorepo layout and ports (2 sessions) — done 2026-10-27

- [x] pnpm workspaces: `packages/core`, `packages/api`, `packages/web`, `apps/cloudflare`; `migrations/` at the root.
- [x] `Db` port (`core/src/db.ts`): the subset of D1 the code uses; every `D1Database` in core and api replaced by it.
- [x] Core modules (tick, inbox, cleanup, digest, results, comments, notify, lock, data, media, config, env, clients,
      formats, push, calendar) in `packages/core`, typechecked with web-standard libraries only (no Cloudflare types).
- [x] `packages/api`: `createApp(fetcher)` with `/health`, `/m/:file`, `agent/` (REST `/v1` + MCP `/mcp`), `owner/`
      (`/app-api`), and the static-files fallback.
- [x] `apps/cloudflare`: `src/index.ts` (fetch) and `src/cron.ts` (scheduled); the two-Worker split kept. Bundle sizes
      unchanged (cron Worker 87 KiB, 24 KiB gzipped).
- [x] Tests: the pure format tests in `packages/core/test` (plain vitest, 13); the integration tests in
      `apps/cloudflare/test` (Workers pool, 90). 103 in all, as before.
- [x] Dead GitLab fake removed from `test/world.ts`.
- [x] The old plan's references (phases, dates, "(user)" notes) stripped from code comments.
- [ ] The remaining hints in messages and the app (21) point at the old command-line scripts: replace them with
      dashboard or CLI wording in Phase 6.
- [x] Existing databases and the squashed schema: `0001_init.sql` is the squashed schema, so a database that already
      has it only gets the new migrations (0002+).
- [x] CI on pnpm (`pnpm typecheck`, `pnpm test`, `pnpm build`).

**Done when:** behaviour is unchanged (same tests pass), and nothing in `core` imports a Cloudflare type.

### Phase 3: Accounts, users and workspaces in the database (2–3 sessions) — done 2026-10-27 (branch `feat/phase-3`)

- [x] Migration `0002_accounts.sql`:
  - [x] `workspaces` (one default workspace), `users` (email, name; the first user is `owner`), `memberships` (user ×
        workspace, role owner/admin/approver/editor/viewer).
  - [x] `passkeys` replaces `owner_passkeys` (with `user_id`); `sessions` get `user_id` and `app` (`pwa`/`dashboard`);
        `setup_codes` get `user_id`.
  - [x] `accounts` and `connections` (provider, kind `composio`/`oauth`/`service`, encrypted `credentials` or a
        `secret_name`, status, expiry, last error), `workspace_settings` (time zone, digest hour, locale; a new instance
        starts on UTC).
  - [x] `workspace_id` on plan items, jobs, drafts, posted, trial posts, Shorts lists, post results, comments, agent
        keys, push subscriptions, audit, snapshots and reports. The Shorts list is rebuilt so its channel can be any
        YouTube account. An account's id is the key the plan data already uses (Instagram username, YouTube channel key),
        so no `account_id` rewrite was needed.
- [x] Agent operations and owner writes filtered by workspace; `getItem(db, key, workspaceId)` hides other workspaces'
      items. Isolation tests: `apps/cloudflare/test/workspaces.test.ts` (API, drafts, the scheduler across two
      workspaces in different zones).
- [x] Owner-side reads (the app's item page, queue) still assume the default workspace: they follow the signed-in
      user's workspace when sessions carry users (Phase 4b). (Done in Phase 4b: the dashboard and the app work as the
      session's user, in their membership's workspace (`core/workspaces.ts` `userWorkspace`, the default one first
      until Phase 13's picker); connect flows save to it, approvals record the user, a user in no workspace gets 403.
      OAuth apps stay instance-wide: the owner's Meta and Google apps serve every workspace.)
- [x] Approvals record the approving user; the audit log records user and workspace.
- [x] `core/accounts.ts` replaces `IG_QUEUES` and `SHORTS_CHANNELS` everywhere (tick, comments, results, inbox,
      calendar, APIs); the tick serves all workspaces with one shared job limit per run. An Instagram account without a
      Composio connection is skipped.
- [x] Credential encryption: AES-GCM with `ENCRYPTION_KEY` (`core/crypto.ts`, versioned `v1:` values for later key
      rotation).
- [x] Time zone per workspace (`core/workspaces.ts`, `formats/time.ts` on `Intl`, daylight saving included): tick,
      approvals, calendar, digest (per workspace, from its digest hour), agent API and the app. Tests in Seoul and
      Madrid, including the October change.
- [x] MCP/REST: `list_accounts` (`GET /v1/accounts`); generic tool descriptions and MCP instructions; `plan_add` checks
      the account belongs to the key's workspace; `shorts_add` needs no repo file.
- [x] `config.ts` deleted (limits in `core/constants.ts`). The legacy TSV mirror formats (queue, posts, Shorts lists,
      approved.tsv parsing) removed with their tests.
- [x] Portable SQL: no `unixepoch()` left in the server code; `packages/core/test/portable-sql.test.ts` allows only the
      remaining `json_each` (4) and `/health`'s `sqlite_master` (1) until Phase 5b.
- [x] No new UI (the app shows any number of YouTube channels and the workspace's zone).
- [x] Times in UTC (migration 0003): `plan_items.due_at`, `approvals.due_at` and `posted.published_at` replace the
      wall-time `date`/`time`/`due` columns. Zones apply only at the edges: input with `at` (ISO 8601 with its zone) or
      `date`/`time` on the caller's clock, output as both `due` (local) and `due_at` (UTC). Each user can pick their own
      zone (`users.timezone`, Settings → Time zone); agent keys, the digest and notifications use the workspace's.
- [x] Local testing: `scripts/dev-seed.sh` (local D1, demo accounts, agent key, first-passkey code) and
      `docs/development.md` → Local testing.

**Done when:** a fresh instance with zero accounts boots, accounts present in the database get scheduled, and the
isolation tests pass with two workspaces seeded. (103 Cloudflare tests + 12 core tests pass.)

### Phase 4: Providers, platforms and media stores (4 sessions) — done 2026-10-28 (branch `feat/phase-4`)

- [x] Define `SocialProvider` (2.3). Move today's Composio code behind `instagram-composio` without
      changing behaviour; the tick talks only to the interface. (`providers/instagram.ts`: `InstagramApi`, chosen per
      account by `instagramFor`; the tick, comments and results use only it.)
- [x] Implement `instagram-graph`: container create (image, carousel, Reel, story), status poll, publish, comment,
      insights, `trial_params`, token refresh job (weekly, in the inbox cron), and `verify` (username, followers →
      suggest `trialReels` capability).
- [x] `youtube` provider for Shorts comments (today's client, plus per-account credentials from Phase 3): on the 2.10
      `Provider` interface, the Shorts comments become first comments on posts published elsewhere.
- [x] Each provider declares how it connects (OAuth endpoints and scopes, or a Composio toolkit) and how its tokens
      are refreshed; the inbox cron refreshes tokens before they expire and marks a connection `expiring`/`broken`.
      (`registerProvider` takes `connect` and `keepAlive`; Instagram tokens are renewed, YouTube grants checked weekly;
      `/app-api/platforms` lists the connect specs.)
- [x] `MediaStore` (2.4): the interface, `MediaRef {store, id, checksum}` and the conformance suite (fake Drive and an
      in-memory store).
- [x] `drive` store: today's `clients/drive.ts` behind the interface; tick, media, inbox, cleanup, approve and uploads
      call only the interface (uploads through `createUpload`).
- [x] Migration: media references become `{store, id, checksum}` (`plan_items.media`, `approvals`, `drafts`);
      `inbox_seen` and `drive_cleanup` keyed by `(store, id)`. Existing rows map `driveId, md5` → `drive, id, md5`, so
      approvals stay valid.
- [x] `/m/` proxy generic over the store; `publicUrl` used when the store offers it.
- [x] `docs/media-stores.md`: how to write a store (interface, conformance tests, checklist).
- [x] Synthetic test world: extend today's `test/world.ts` fakes so every provider has a fake; write synthetic
      fixtures to replace the deleted golden ones. (Fakes: Composio, `graph.instagram.com`, YouTube, Drive, Google
      tokens; `test/fixtures/week.json` + `scenario.test.ts`: a made-up week through the real tick.)
- **Platforms (2.10):** make networks pluggable before more work lands on the Instagram-shaped code.
- [x] `Platform` registry with capabilities (formats, limits, features, option specs, lint rules); `instagram` and
      `youtube` declared.
- [x] `Provider` interface (resumable `start` / `check` / `finish`, comments, results, verify, refresh, connect
      metadata); `instagram-graph` and `instagram-composio` moved onto it; the tick drives any provider and has no
      Instagram steps left.
- [x] Content-model migration (0006): `plan_items.format` + `options` JSON (Instagram's trial, cover, location, story
      moved there), `jobs.kind` is the post's format (or `comment`), `accounts.platform` / `connections.provider`
      validated by the registries instead of a CHECK. Existing rows keep their approvals. **Item keys stay as they are
      and are opaque** (decided 2026-10-28: nothing parses them; new keys keep today's shape so existing
      scripts keep working).
- [x] The app, calendar, digest and agent API driven by capabilities (names from the platforms' `labels` through
      `/app-api/platforms`; the database keeps the neutral formats) (Instagram-only controls shown by feature; event
      kinds per platform; `list_accounts` with platform and capabilities).
- [x] Caption checks per platform (`Platform.lint`; Instagram's current rules move there).
- [x] A fake third platform in the tests (text + image posts, one-step publish) that plugs in without touching the
      core (`apps/cloudflare/test/fakenet.test.ts`); `docs/platforms.md`: how to add a platform and a provider.
- [x] Docs for each provider's setup (what to create where, which scopes, which limits): `instagram-graph.md`,
      `instagram-composio.md`, `youtube.md`, `drive.md`.

**Done when:** the full tick runs against either Instagram provider and the fake third platform in tests, with no
platform name in the tick, the app's logic or the schema's checks; and a real test account posts one Reel
through `instagram-graph` (manual check, with a throwaway account: done 2026-10-28, Reel, first comment and record); nothing outside `media/drive.ts` calls Drive, and
the media-store conformance suite passes for the fake Drive and the in-memory store.

### Phase 4b: The dashboard app (3–4 sessions)

A second app, `packages/dashboard`, for everything that's scripts or manual setup today (section 2.8). The PWA stays
as it is, minus its setup pages.

- [x] Scaffold `packages/dashboard` (React + Vite, desktop first, sharing the API client types and design tokens with
      `packages/web`); served at `/dashboard` by the same Worker. `packages/api` gets `dashboard/` routes at
      `/admin-api`; today's `owner/` becomes `pwa/`.
- [x] **Bootstrap:** a `SETUP_TOKEN` secret set once at deploy. The first visit to `/dashboard` asks for it, then for
      an email and a passkey: that's the first user, owner of the default workspace. The token is used up (replaces
      the SQL setup code in `site/docs/deploy-cloudflare.md`).
- [x] **Sign-in:** email, then the passkey (WebAuthn with the user's credentials as `allowCredentials`); recovery
      codes at sign-up; several passkeys per user.
- [x] **Setup wizard** after sign-up: time zone and digest hour, media store (Connect Google Drive), OAuth apps, first
      account, a phone, `DRY_RUN` explained. (**Get started** (`/dashboard/start`): the new owner lands there; each
      step's state is read from the data (`setup` in `/admin-api/overview`), so nothing stores progress; the overview
      shows "Finish setting up" until all four are done. The media-store step waits for Connect Google Drive.)
- [x] **OAuth apps (bring your own):** shows the exact redirect URLs to register
      (`<PUBLIC_URL>/admin-api/connect/<provider>/callback`) and stores the pasted client id and secret encrypted. One
      Google app covers YouTube and Drive; one Meta app covers Instagram.
- [x] **Connections:** Connect Instagram (Instagram Login), Connect YouTube, Connect Google Drive, or Connect through
      Composio (Composio's connect link; only the connection id is stored). OAuth `state` + PKCE, callback checks,
      token exchange, then account discovery (which Instagram accounts / YouTube channels came with the grant) and the
      account rows created from it. Status: ok, expiring, broken (with the provider's error); reconnect; remove
      (revokes the token where the provider allows it).
      (Done for Instagram Login and YouTube, plus a pasted Instagram token. Composio connects by pasting the
      connected-account id: its connect link needs Composio's project API, not the consumer key Bongsu has. **Connect
      Google Drive** waits for the media-store step: the inbox reads files the owner drops in Drive, which `drive.file`
      can't see, so Drive stays on the service account until then. Reconnect also adopts an account set up by hand
      without a platform id.)
- [x] **Accounts:** capabilities (posts, Reels, stories, Trial Reels after a follower check), Trial Reels default,
      caption-lint rules, display name; disable or remove. (Moves out of the PWA.)
      (What each account publishes, the Trial Reels default (gone from the PWA), rename, disable/enable, and remove: a
      disabled account with nothing left to publish; its published history stays. Per-account caption-lint rules are
      Phase 7's "rules configurable per account": the rules are per platform until then.)
- [x] **Phones and passkeys:** Add a phone (QR code + one-time code → passkey on the phone → signed in to the PWA);
      list of each user's passkeys and push subscriptions with last use; rename, revoke.
- [x] **Agent keys:** create with scopes (shown once), list with last use, revoke. Replaces the SQL in
      `site/docs/api-reference.md`.
- [x] **CLI tokens** (created with a fresh passkey check, scoped to the user's rights, revocable). (In `api_keys` with
      `user_id` and `expires_at` (migration 0009); rights from the person's role, read on every request
      (`agent/auth.ts` `ROLE_SCOPES`); 30/90/365 days; **Keys & tokens** → **Your CLI tokens**. Nothing on `/v1`
      needs `approve` or `resume` yet: the CLI's `approve` (Phase 6) is the first.)
- [x] **Audit:** who did what (approve, connect, revoke, key created, phone added…).
- [x] Optional `Mailer` port (no-op by default) for connection alerts; invites use it in Phase 13. (`core/mail.ts`:
      `MAILER = "resend"` with `MAIL_FROM` and the `RESEND_API_KEY` secret; alerts go to the workspace's owners and
      admins. An SMTP relay needs a socket: Phase 5, on Node.)
- [x] PWA: remove **Add another device** and the account page; its Settings keep this device's notifications and
      sign-out. Everything about items stays. (`/app-api/setup-code`, `/app-api/account` and `/account/trial` are
      gone; the app's account page keeps its followers and link.)
- [x] Tests: bootstrap (token once), sign-in, OAuth callback (good, bad state, denied), token refresh and expiry,
      revoke, phone registration, keys; the PWA session can't reach `/admin-api`; agent keys can't reach either.
      (`dashboard.test.ts`, `connect.test.ts`, `providers.test.ts`, `app.test.ts`, `workspaces.test.ts`; plus CLI
      tokens, Get started, account removal, the Mailer and per-workspace reads.)

**Done when:** a fresh instance goes from deploy to its first approved Reel without a terminal after the bootstrap
secret: the first user signs up in the dashboard, pastes the Google and Meta apps, connects accounts, adds a phone,
and approves the Reel in the PWA.

### Phase 5: Node runtime and Docker (1–2 sessions)

- [x] `apps/node`: `@hono/node-server`, the better-sqlite3 `Db` adapter (`batch` as a transaction), a migration
      runner, node-cron with the same three schedules, `serveStatic` for the PWA, graceful shutdown that releases locks.
      (The schedules moved to `core/schedules.ts`, shared with the cron Worker. Static files: `apps/node/src/assets.ts`,
      Workers-assets behaviour. Bundled with esbuild; better-sqlite3 is the only runtime package.)
- [x] Db conformance suite: the core tests run against both adapters in CI. (`core/db-conformance.ts`: numbered
      parameters, RETURNING, upserts, batch rollback, JSON functions; run on D1 and on better-sqlite3. The full
      scenario suite stays on the Workers pool; Node runs the schedules and `/health` on SQLite.)
- [x] `local` media store (a directory on the server, served by `/m/`), passing the media-store conformance suite.
- [x] `Dockerfile` (multi-stage, non-root, SQLite file on a volume), `docker-compose.yml` with an optional Caddy for
      HTTPS (passkeys and Instagram's media fetch both need a public HTTPS URL). (Profiles `https` (Caddy) and `mail`
      (Mailpit, with the Node `smtp` mailer); `.env.example`; `site/docs/self-hosting.md`.)
- [x] Health check endpoint wired into Docker `HEALTHCHECK`.
- [x] Backups: document `sqlite3 .backup` (Node) and `wrangler d1 export` (Cloudflare). (`node server.mjs backup
      <file>` in the image, which has no sqlite3 CLI.)

**Done when:** `docker compose up` on a VPS gives a working instance with the same test suite passing.

### Phase 5b: Neutral schema and Postgres (2 sessions)

- [x] `schema/tables.ts` and `schema/migrations/` (2.9) written from the current schema (`0001_init`, `0002_accounts`,
      the media-store migration); the generator for `sqlite` reproduces today's SQL (compared by introspection, so
      existing databases need no change). (`packages/schema`: the current schema is the frozen `0009_baseline`
      migration and `TABLES` is computed from the migrations, so the two can't disagree. All 37 tables match
      `migrations/sqlite/0001…0009` column by column, keys, indexes and checks.)
- [x] Generator for `postgres`; `migrations/sqlite/` and `migrations/postgres/` generated; CI checks they're current.
      (SQLite keeps 0001–0009 as written; Postgres starts at `0009_baseline.sql`; later neutral migrations are
      generated for both. A test fails when a generated file is stale.)
- [x] Generated `docs/schema.md` and `schema/schema.json`.
- [x] Remove the remaining SQLite-only SQL: the 5 `unixepoch()` calls and the 22 column defaults (the app passes
      timestamps), `json_each` (4) through a dialect helper, `/health`'s `sqlite_master` through `Db.tables()`.
      (`core/sql.ts`: `jsonList`, `tableNames`. The `unixepoch()` defaults stay: the neutral schema writes them per
      database (`NOW`). Also found running on Postgres: untyped `?n IS NULL` parameters (now `CAST`), ambiguous
      names in upserts, the reserved `window`; `portable-sql.test.ts` guards against them.)
- [x] `Db` gets `dialect` and `tables()`; the Postgres adapter (`postgres.js` on Node; on Cloudflare through
      Hyperdrive or an HTTP driver such as Neon's) translates `?1` placeholders to `$1`; `batch` = a transaction.
      (`core/postgres.ts` over any driver: `postgres.js` with `DATABASE_URL` on Node, PGlite in tests. `dialect` is
      optional (D1 unchanged); `tableNames()` in `sql.ts`. Cloudflare through Hyperdrive isn't done.)
- [x] Tests: the conformance suite on SQLite and on PGlite (Postgres in WebAssembly, no server) in CI. (On D1,
      SQLite, PGlite, and `postgres.js` over the network to PGlite; the Node app's main paths run on Postgres too.
      The Workers scenario suite stays on D1.)
- [x] `bongsu export` / `bongsu import` (neutral JSON) and a "D1 to Postgres" walkthrough. (`node server.mjs
      export|import|load-sql` until the CLI (Phase 6) wraps them; `packages/schema/src/transfer.ts`. Tested SQLite →
      Postgres → SQLite, and a local D1 dump → SQLite → JSON → Postgres → serving.)
- [x] `docs/databases.md`: choosing a database (D1 on Cloudflare; SQLite or Postgres with Docker; Postgres from
      Cloudflare via Hyperdrive), backups for each, how to add a dialect. (Hyperdrive is listed as not done yet.)

**Done when:** the same test suite passes on D1, SQLite and PGlite; a fresh Postgres gets its tables from the
generated migrations; and an instance moves from SQLite to Postgres with export/import.

### Phase 6: The CLI, for scripting (1–2 sessions) — done 2026-10-29

Setup, connections, devices and agent keys live in the dashboard (Phase 4b). The CLI covers what's better scripted.

- [x] `packages/cli` (`npx bongsu`), talking to the instance's HTTP API only (not to D1 directly), so it works with
      both runtimes (done 2026-10-29):
  - [x] `login` with a CLI token made in the dashboard (stored in the OS keychain or a 0600 file); `--workspace`. (A 0600 file
        in `~/.config/bongsu/`; no keychain.)
  - [x] `approve <item>` and `approve <item> --comments` (replaces the old approval script). (`--comments` is covered by
        `approve comment:<video id>`.)
  - [x] `texts get|set <item>` (replaces the old texts script).
  - [x] `status`, `queue`, `export --format json|csv`.
  - [x] `deploy-secrets` for the Cloudflare path: generates `SETUP_TOKEN`, `ENCRYPTION_KEY`, `MEDIA_SIGNING_KEY` and
        the VAPID pair and sets them with `wrangler secret put` (replaces `setup-secrets.sh`).
  - [x] `mcp`: a local stdio bridge to `/mcp`, for MCP clients without remote HTTP support.
  - [x] `schema --dialect <sqlite|postgres>`: the full DDL for a fresh database (2.9).
- [x] Replace the remaining hints at the old scripts in messages and the app with dashboard or CLI wording.
- [x] Agent keys still can't approve (test for it).

**Done when:** every everyday task the old scripts did is in the dashboard or the CLI, except the ones that stay out
of the project (2.6).

### Phase 7: Generalize the app and the agent API (1–2 sessions)

- [x] Remove the original wording and branding from the PWA; app name, icon and colours from `workspace_settings` or a build
      variable. Keep the current design. (Done 2026-10-31: `BONGSU_APP_NAME` and `BONGSU_THEME_COLOR` build inputs
      and generated icons, #75.)
- [x] i18n scaffold (English first; the Spanish/Korean caption checks stay as lint rules, not UI languages). (Done
      2026-10-31: `i18n.ts` with an English catalogue, `t()` and the workspace locale on `/app-api/me`, #76.)
- [x] i18n: the rest of the app's strings through t() (#144). (Done 2026-11-03, #37: every screen's text in
      `i18n.ts`, plurals as `{ one, other }`; `test/i18n.test.ts` fails on JSX text left in `App.tsx` and on unknown keys.)
- [x] Caption lint (`formats/caption-lint.ts`): rules configurable per account (hashtag cap, fold length, language
      checks on/off). (Done 2026-10-31: `LintRules` with the platform's defaults, `accounts.settings.captionRules`
      overrides, edited in the dashboard's Accounts page, #77.)
- [x] Empty states that point to the setup wizard and the provider docs. (Done 2026-10-31: `me.accounts` and the
      PWA's `SetupNote`, #78.)
- [x] MCP server name and instructions generic; add `list_accounts`, keep "approve and resume are owner-only".
      (Already generic: the server is `bongsu`, `list_accounts` exists, the instructions say approving and resuming
      are owner-only, #79.)
- [x] Notifications: web push + optional `NOTIFY_URL` (ntfy) as today; wording through one template file. (Done
      2026-10-31: every message is a builder in `core/texts/notifications.ts`, #80. 2026-11-04: the ntfy topic is a
      setting of each workspace, in the dashboard, and `NOTIFY_URL` is gone, #54.)
- [x] YouTube: move a scheduled Short or video's release date (private with `publishAt`, to a future time) from the
      PWA and the dashboard with the passkey, and from the API and MCP with the opt-in `reschedule` scope (#134).
      (Done 2026-10-31: `youtube_reschedule` with a 1-hour lead, the PWA and the dashboard's Videos page, #134.)
- [x] `pnpm brand <mark.svg>`: every PWA icon from one SVG, the site's brand folder from `BRAND_DIR`, so a fork
      rebrands in one step after #75's variables (#143). (Done 2026-11-03, #36: `build_icons.py --out`, the app build
      checks the seven icons, `BRAND_DIR` for `pnpm site`.)

### Phase 8: Documentation (1–2 sessions)

- [x] `README.md`: what it does, screenshots (from a demo instance with fake accounts), feature list, quick start for
      both runtimes, comparison with other schedulers. (Done 2026-10-31: screenshots from `pnpm screenshots`, quick
      starts, a comparison by category, #81.)
- [x] **Public docs** for people who run Bongsu, served with the project site at `/docs/`, apart from the internal
      `docs/` (architecture, development, media store interface, adding a network, brand, this plan). Each guide
      lives in one place: the user-facing ones move out of `docs/`, they aren't copied. (Done 2026-10-31.)
  - [x] Build and structure, moving the install, account and reference guides (#130). The Meta and Google app steps
        (redirect URLs, scopes, test users, publishing the Google app so tokens don't expire after 7 days) get
        screenshots there. (Done 2026-10-31: `site/docs/`, built by `scripts/build-docs.mjs`; the app-step
        screenshots come with #131; the console screenshots continue in #151.)
  - [x] Using Bongsu: the phone app, captions and checks, the dashboard (#131), after Phase 7. (Done 2026-10-31, #131.)
  - [x] Agents: Connect Claude (MCP), keys, tools and REST reference (#132), after Phase 7. (Done 2026-10-31, #132.)
  - [x] Updating, backups and restore, FAQ and troubleshooting (#133). (Done 2026-10-31, #133.)
  - [ ] The Meta and Google console screenshots, taken with the owner's accounts and blurred; the guides carry a
        comment per screenshot saying what to capture (#151, needs the owner).
- [x] `CONTRIBUTING.md`, `AGENTS.md`, Conventional Commits (commitlint, hook + CI), Biome formatting and lint (hook +
      CI), changelogs per package with Changesets: done 2026-10-27.
- [x] `CODE_OF_CONDUCT.md`, `SECURITY.md` (how to report), issue and merge request templates. (Done 2026-10-31, #84.)
- [x] A note on platform terms: posting through the official APIs, rate limits, no scraping. (Done 2026-10-31:
      `site/docs/platform-terms.md`, #85.)
- [x] The project site: a static landing page in `site/`, published on GitLab Pages by the `pages` CI job (#128):
      done 2026-10-29.

### Phase 9: Stats module (optional, 1–2 sessions; can follow v1)

- [x] Decide what to generalize from the original Stats: the `snapshots`/`reports` tables and the app's Stats page stay;
      a collector built on the providers' `results`/insights calls replaces the old Python collector. (Done 2026-10-31,
      #86: posts sampled by the built-in collector; the account side with #139.)
- [x] Snapshot upload API for people who collect elsewhere. (Done 2026-11-02, #87: `ingest_metrics`, samples into the
      series rather than snapshots.)
- [x] `labels`/`manual_stats` only if the collector needs them. (Done 2026-11-02, #88: not needed, dropped.)
- [x] A published item's page splits into **Results** and **Post** (a segmented control); the Trial Reel's results
      beside the Reel's; the 24 h notification opens Results (#136). (Done 2026-10-31, #136.)
- [x] Metrics history: a `post_metrics` time series sampled by the cron run (Instagram insights, YouTube
      `videos.list` statistics) and line charts of views, likes and the rest, total and per day, on the item's
      Results view and the YouTube video page (#137). (Done 2026-10-31, #137.)
- [x] Followers brought by a post or video: Instagram `follows` and `profile_visits`, YouTube `subscribersGained` per
      video (Analytics API, the `yt-analytics.readonly` scope), on the Results view and in the notification (#138).
      (Done 2026-11-01, #138.)
- [x] Channel page: an `account_metrics` series (the nightly snapshots backfill it), a followers line chart, views
      per day, and the posts and videos ranked by followers brought (#139). (Done 2026-11-02, #139.)
- [x] Stats for agents: `get_metrics`, `get_account_metrics` and `list_performance` as MCP tools and `/v1` routes
      (`read` scope), so an agent pulls the series and does the performance analysis itself (#140). (Done 2026-11-02,
      #140.)

### Phase 10: Pre-release review and publishing (1 session)

- [x] Security review: WebAuthn flow, session cookies, API key hashing, owner token scope, signed media links, the
      MCP endpoint, CORS, rate limiting on `/app-api` login. Run `/security-review`-style pass and fix findings.
  - [x] First pass (#135): approvals bound to their account, Shorts comments approved in the app, texts and the plan
        checked again before posting, dry run on running jobs, workspace and role gates, media id kept, symlinks in
        the local store.
  - [x] What the Phase 7 and 8 work found: passkey assertions not tied to the session's user (#145), the
        overview's approval count skipping re-approvals (#146), `withdraw_draft` reaching other keys' drafts
        (#147), failed jobs that re-approving doesn't reopen (#148), `deploy-secrets` hiding `SETUP_TOKEN` (#149),
        the PWA rows' missing space before the kind (#150). A key withdraws any open draft of its workspace (#147, by
        design); a failed job reopens on a passkey approval made after the failure, unless it may be live (#148).
  - [x] Last pass over the merged branch (Phase 9's stats tools and ingest included): stats reads and the ingest
        stay in the caller's workspace and are bounded; no CORS headers (same origin only); cookies HttpOnly, Secure,
        SameSite=Strict; keys and codes stored hashed. Fixed: recovery-code sign-in had no attempt limit (40-bit codes
        that last until used): five tries an email in 15 minutes.
- [x] `gitleaks` over the full history; `scripts/check-personal.sh` (list in the git-ignored `.personal-strings`); `npm audit`.
      gitleaks: two test fixtures, allowlisted in `.gitleaks.toml`. Personal strings: the old project's name in a few
      notes (reworded) and in early commit messages and GitLab merge commits (gone with the squash). Audit: clean after
      patch bumps and `pnpm.overrides` for the Workers test pool's undici, sharp and zod.
- [x] `PLAN.md`: a generic roadmap, with nothing about any one deployment.
- [x] Stats from what Bongsu collects only (#152): the Stats tab lists the accounts' followers (account series) and the
      last 7 days' posts, most viewed first (`list_performance`); the snapshot Performance page, the review pages and
      their routes removed, `reports` dropped (0015). `snapshots` stays for the one-time backfill.
- [x] Squash the private history into one "Initial public release" commit on a new branch (safety net for anything
      scrubbed late), push it to the public repository.
- [x] Releases on GitHub: Changesets' GitHub action (Version Packages pull request, tags, GitHub releases) with the
      built-in token, replacing the dormant GitLab release jobs and the manual steps; CI publishes the Docker image
      (GHCR) and the CLI (npm).
  - [x] The workflows (`.github/workflows/`: ci, pr-title, release, pages) and `.github/dependabot.yml`, pinned by
        commit; the release flow is in `docs/development.md`.
  - [x] The CLI publishable: `bongsu` public with provenance, its own README, no runtime dependencies (the bundle);
        `npm pack` installs and runs on its own. On npm since 2026-11-02 (0.1.0 by hand, to set up trusted publishing);
        the guides use `npx bongsu`.
  - [x] Turned on in the public repository (npm trusted publisher, Actions may open pull requests, Pages from Actions, GHCR
        visibility); the GitLab CI files removed at the switch. The CLI is published with npm itself
        (`scripts/release-publish.sh`: `pnpm publish` broke the OIDC exchange), and the trusted publisher's repository
        must be spelt as GitHub does (`NYT87/bongsu`). The release step marks the CLI's release as Latest.
  - [x] GitHub is the source (2026-11-03): issues and pull requests there, `main` mirrored to the private GitLab
        project (`mirror.yml`), whose `private-history` keeps the earlier history; `.gitlab-ci.yml`, `.gitlab/` and
        `changesets-gitlab` removed.
- [x] First public version tagged (the changesets gathered until then): 0.2.0 on 2026-11-03, `bongsu` on npm with
      provenance and `ghcr.io/nyt87/bongsu` (public; the Docker guide can use it through `BONGSU_IMAGE`). 0.1.0, the
      hand-published one, is deprecated.
- [x] Repository settings: branch protection, Dependabot/Renovate, topics, description. A ruleset on `main` (pull
      requests, squash only, `check` and `commitlint` required); Dependabot weekly, majors by hand; private vulnerability
      reporting, secret scanning with push protection, CodeQL.

### Phase 11: Updating a running instance (1–2 sessions)

- [x] `site/docs/updating.md` covers moving a running instance onto a release: a backup, the migrations, a rehearsal on
      a copy of the database with `DRY_RUN=1`, a quiet window, and the way back. (Done 2026-11-03: "The careful route";
      the rehearsal runs with no schedules (`SCHEDULES=off`, or the web Worker alone with `--persist-to .rehearsal`),
      since `DRY_RUN` alone still lets the other schedules act outside the copy. Both recipes were run end to end.)

---

### Phase 12: More media stores (after v1, 1 session each) — done 2026-11-03 (branch `feat/phase-12-media-stores`)

Design: `docs/superpowers/specs/2026-11-03-phase12-media-stores-design.md`.

- [x] R2 through the `s3` store's S3 API, with presigned uploads and presigned Instagram fetches. The Worker binding
      was dropped: it can't presign, and a listing is one request per 1,000 keys, so subrequests don't call for it.
- [x] `s3` store (S3-compatible, `aws4fetch`): AWS S3, R2, B2, MinIO; conformance against a fake and a real server.
- [x] The stores set up in the dashboard (Media) and kept in `media_store`, several side by side with a default; the
      environment variables (`MEDIA_STORE`, `DRIVE_SA_JSON`, `DRIVE_OWNER_OAUTH`) and the Drive service account gone.
- [x] Connect Google Drive with the owner's Google app (scope `drive`), and the store's step in Get started.
- [x] Setup docs for each (`drive.md`, `s3.md`), the stores' status in the app's Settings and `/health`, a weekly
      check of each store.

### Phase 13: Workspaces and members (after v1, 2–3 sessions)

Several separate sets of accounts in one deployment, each with its own people: managing other people's accounts
without a deployment per person. The data model is already there (Phase 3).

- [ ] Dashboard: create, rename and archive workspaces; a workspace switcher. (Part 1 delivered the Workspaces page,
      for instance admins: list, create, rename, add an admin, archive, restore, and open one to work in it, and a
      workspace's admins rename theirs in Settings. Left: the switcher, so someone in several workspaces still goes
      through that page or their session's first workspace; tick this with part 2.)
- [x] **Members and invites:** invite by email: a one-time link always shown in the dashboard with Copy, sent by
      the `Mailer` too when one is configured; the invitee signs up with email + passkey and only sees the
      workspaces they're in (#107).
- [x] **Roles** (table below) enforced in every route: dashboard, PWA, API, MCP: instance admin, admin, editor and
      creator; creators use the app and connect their own accounts there (the creators' part of #33); pause and resume
      per workspace; the first run makes an instance admin who creates the first workspace (#18, #19, #20).
- [ ] Per-workspace: connections, accounts, media store root (e.g. its own Drive folder), agent keys, time zone,
      notifications. The OAuth apps (D10) can be shared by the instance or set per workspace.
- [ ] PWA: a workspace picker when a user belongs to more than one; notifications say which workspace.
- [ ] Workspace icon, optional, set in the dashboard; the PWA header, the picker and the notifications show it;
      the installed app's icon stays the instance's (#141).
- [ ] Your name, edited in the dashboard, and a display name per workspace, used wherever a person is named
      (#142).
- [ ] Notifications per user and workspace (who gets what).
- [ ] Isolation tests across every surface, including the cron and the media links.

| Role | Can |
|---|---|
| instance admin | every workspace as its admin, and what is instance-wide: workspaces, media stores, OAuth apps |
| admin | connections, accounts, settings, agent keys, members; the plan, texts and drafts; approve, pause, resume |
| editor | edit the plan, texts and drafts; no approving, pausing or connecting; no dashboard settings |
| creator | the app only: the plan, texts and drafts, approve, pause, resume, connect their own accounts |

(Part 1 renamed the first draft's owner, approver and viewer: existing owners became admins and instance admins,
approvers creators, viewers editors. Deleting a workspace is left out; archiving stops one completely.)

### Phase 14: More platforms (after v1, about 1 session each)

New networks on the 2.10 interfaces: a platform file, a provider, its fake, a docs page each.

- [ ] **Threads** (`threads-graph`): text, image, video and carousel posts, replies, insights; free API, same Meta app
      model as Instagram.
- [ ] **Bluesky** (`bluesky-atproto`): text and image posts (app password or OAuth); free, no review.
- [ ] **TikTok** (`tiktok-content`): video posts through the Content Posting API (upload → status → publish). Posts stay
      private until the app passes TikTok's audit; document it.
- [ ] **X** (`x-api`): posts with media, threads as a second comment chain; needs a paid API tier beyond the free
      allowance; document the cost.
- [ ] **LinkedIn** (`linkedin-posts`): personal and page posts with images or video.
- [ ] **Cross-posting:** one draft planned to several accounts on different networks at once (each still its own item
      and approval, texts adapted per platform's limits).
- [ ] YouTube uploads (Shorts and videos) through `start` / `check` / `finish`, beside the existing comments.

---

## 4. Tests and CI

- Unit/integration: vitest. `core` + `apps/cloudflare` in the Workers pool (as today); `core` + `apps/node`
  in plain Node with better-sqlite3. Same test files, two adapters.
- The fake world (`test/world.ts`) generalized: fake Instagram Graph, fake Composio, fake YouTube, fake Drive.
- E2E (later): Playwright over the PWA against the Node runtime with fakes.
- CI (GitHub Actions): lint, typecheck, both test matrices, web build, Docker build; on tag, publish the image and
  the CLI. A manual "deploy demo" workflow for a demo instance with fake data (optional).
- Under load, keep today's flags documented (`--testTimeout 120000 --maxWorkers=2`).

## 5. Risks

| Risk | Mitigation |
|---|---|
| A release breaks a running instance's posting | rehearsal on a copy of its database; rollback plan (Phase 11) |
| Free-plan CPU limit (10 ms) after adding the account loading and abstraction layers | measure cron CPU in Phase 3/4 (Workers observability); keep the two-Worker split and per-tick job cap |
| Instagram Graph API app review for other users | document "use your own Meta app in development mode" for personal accounts; Composio as the no-review option |
| Google apps in "testing" status issue refresh tokens that expire after 7 days | the Google app guide covers publishing the app (unverified apps work for a few users, with a warning screen); the dashboard warns when a Google connection is about to expire |
| Meta app setup is the hardest step for new users | step-by-step guide; development mode with the owner's accounts as testers; Composio as the no-app alternative |
| Personal data leaking into the public repo | scrub before first commit, grep list in CI, gitleaks, squash before publishing |
| Maintenance load of an open-source project | clear scope in the README, issue templates, "PRs welcome for new providers" |

## 6. Effort summary

| Phase | Sessions |
|---|---|
| 1 Private repo, scrubbed import | 1 |
| 2 Monorepo and ports | 2 |
| 3 Accounts, users and workspaces in the DB | 2–3 |
| 4 Providers, platforms (2.10), media stores, Instagram Graph | 4 |
| 4b Dashboard app (sign-in, connections, phones, keys, wizard) | 3–4 |
| 5 Node runtime and Docker | 1–2 |
| 5b Neutral schema and Postgres | 2 |
| 6 CLI (scripting) | 1–2 |
| 7 App and agent API generalized | 1–2 |
| 8 Docs | 1–2 |
| 9 Stats (optional) | 1–2 |
| 10 Review and publish | 1 |
| 11 Updating a running instance | 1–2 |
| 12 More media stores (R2, S3; after v1) | 1 each |
| 13 Workspaces and members (after v1) | 2–3 |
| 14 More platforms (after v1) | about 1 each |
| **Total for v1 (without 9, 12, 13 and 14)** | **about 20–27** |

The order can shift: Phase 4's Instagram Graph provider and Phase 5's Node runtime are independent of each other once
Phase 3 is done, so they can run in parallel sessions. Phase 4b needs Phases 3 and 4 (the connections table and the
providers' connect methods).
