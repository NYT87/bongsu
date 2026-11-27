# Deploy on Cloudflare

What you need: a Cloudflare account (the free plan is enough), Node 22 with pnpm (`corepack enable`), a place for the
media (Google Drive, [drive.md](drive.md), or an S3-compatible bucket such as R2, [s3.md](s3.md)), a way to reach each Instagram account (a
Meta app and a token per account, [instagram-graph.md](instagram-graph.md), or Composio,
[instagram-composio.md](instagram-composio.md)), and for Shorts comments a YouTube OAuth client
([youtube.md](youtube.md)).

> Some of this setup is still manual. After deploying, you connect accounts, storage and devices from the dashboard.

## 1. Install and log in

```sh
pnpm install
cd apps/cloudflare
pnpm exec wrangler login
```

The commands below run in `apps/cloudflare`.

## 2. Create the database

```sh
pnpm exec wrangler d1 create bongsu
```

Put the printed `database_id` into both `apps/cloudflare/wrangler.toml` and `apps/cloudflare/wrangler.cron.toml`. Keep your edited copies
out of any public fork (they hold your ids and URLs).

## 3. Set the variables

In both wrangler files:

| Variable | Value |
|---|---|
| `PUBLIC_URL` | the `bongsu` Worker's URL, e.g. `https://bongsu.<your-subdomain>.workers.dev` or your own domain |
| `RP_ID` | that URL's hostname (passkeys are tied to it: changing it later means registering passkeys again) |
| `VAPID_PUBLIC_KEY` | the public half of a VAPID key pair (e.g. `pnpm dlx web-push generate-vapid-keys`) |
| `VAPID_SUBJECT` | `mailto:` plus your email |
| `DRY_RUN` | keep `"1"` until you trust the setup: every step logs and notifies instead of publishing |

Optional, in `wrangler.cron.toml` only (the Worker that runs the schedules):

| Variable | Default | Value |
|---|---|---|
| `RUN_SUBREQUESTS` | `50` | the outgoing calls one run may make: `50` on the free plan; on the paid plan `10000` (Cloudflare's default there, up to 10 million with the Worker's `limits` setting) |
| `CRON_INSTAGRAM`, `CRON_SHORTS`, `CRON_UPKEEP` | `*/5 * * * *`, `2,32 * * * *`, `7,22,37,52 * * * *` | when each run happens (cron, UTC) |

The cron Worker has one trigger, `* * * * *`: every minute it starts the runs whose schedule matches, so changing a
schedule never touches the trigger. Cloudflare's free plan allows 5 cron triggers per account, and Bongsu uses 1.
More in [When the runs happen](configuration.md#when-the-runs-happen) and
[How much a run does](configuration.md#how-much-a-run-does).

## 4. Accounts come later

Instagram accounts and YouTube channels are connected from the dashboard once it's running (step 8). A deployment
that prefers SQL and secrets can still add the rows by hand: see
[configuration.md](configuration.md#accounts-and-connections-database).

## 5. Create the tables

```sh
pnpm exec wrangler d1 migrations apply bongsu --remote
```

## 6. Deploy

Build the repository (the phone app, the dashboard inside it, and the CLI), then deploy both Workers from
`apps/cloudflare`. Keep `DRY_RUN = "1"` for now: without secrets the Workers can't do anything yet, but the secrets
can only be set on Workers that exist.

```sh
cd ../..
pnpm build
cd apps/cloudflare
pnpm run deploy          # both Workers
```

To give the app your own name, colour and icons, set them before `pnpm build`: [configuration.md](configuration.md#branding).

## 7. Set the secrets

See [configuration.md](configuration.md#secrets) for the list. Each one goes to **both** Workers.

**Keep a copy of `ENCRYPTION_KEY` first.** It encrypts your OAuth apps' secrets and the accounts' tokens in the
database: without it they can't be read again, and the CLI below never prints it. Set your own before running it, and
the CLI keeps it:

```sh
openssl rand -hex 32 > encryption-key.txt     # outside the repository; then into your password manager
pnpm exec wrangler secret put ENCRYPTION_KEY < encryption-key.txt
pnpm exec wrangler secret put ENCRYPTION_KEY --config wrangler.cron.toml < encryption-key.txt
```

The same works for `SETUP_TOKEN` if you'd rather choose it. Then, from the repository root:

```sh
cd ../..
node packages/cli/dist/cli.mjs deploy-secrets
```

`--config-dir` points it elsewhere; the default is `apps/cloudflare`. You must be logged in to Cloudflare for
wrangler. It sets, in `wrangler.toml` and `wrangler.cron.toml`, through `wrangler secret put`:

- `SETUP_TOKEN`: lets the first person sign up in the dashboard, once. The command prints it (and only when it
  generated it now, not when it kept one already set): copy it for step 8.
- `ENCRYPTION_KEY`: as above. `--rotate` replaces it, which makes everything already encrypted unreadable.
- `MEDIA_SIGNING_KEY`: signs the media links.
- `VAPID_PRIVATE_KEY`: the private half of the Web Push key pair.

Names already set in both Workers are kept (`kept SETUP_TOKEN in wrangler.toml`); a name set in only one stops the
command, since both Workers need the same value (`--rotate --only <NAME>` fixes it). `--rotate` replaces them and
`--only ENCRYPTION_KEY,SETUP_TOKEN` limits the run. The values are never written to disk, and the only one printed
is the `SETUP_TOKEN` it just generated, once. It also prints the public half of the VAPID pair, which is not secret:

```
VAPID_PUBLIC_KEY = "B…"
```

Paste it over `REPLACE_WITH_YOUR_VAPID_PUBLIC_KEY` in `[vars]` of **both** wrangler configs and deploy again
(`pnpm run deploy` in `apps/cloudflare`). Rotating `VAPID_PRIVATE_KEY` makes existing push subscriptions stop working
until the app is opened again.

Check `https://<PUBLIC_URL>/health`: all tables present and no missing secrets. It says `ok: false` until a media
store is connected (step 8).

## 8. Sign up in the dashboard

1. Open `https://<PUBLIC_URL>/dashboard` on your computer. The first visit asks for the `SETUP_TOKEN` from step 7
   (printed by `deploy-secrets`, or the one you set), your name and email, and creates your passkey (the computer's
   fingerprint, face or PIN). Save the recovery codes it shows: one of them signs you in if you ever lose every passkey.
   You're the instance's admin; next the dashboard asks for your first workspace (a name, its time zone, and its first
   admin: you, preselected). Then **Get started** opens: a checklist of the steps below, each ticked as it's done (the
   overview links back to it until all four are).
2. **Time zone** and the daily digest's hour, right on Get started (or later in **Settings**).
3. **OAuth apps**: paste your Meta app (Instagram) and Google app (Drive and YouTube). Each card shows the redirect
   URLs to register in the app; the guides walk through making them: [instagram-graph.md](instagram-graph.md),
   [The Google app](google-app.md). Composio users skip the Meta app ([instagram-composio.md](instagram-composio.md)).
4. **Media**: where the Reels and photos live. Google Drive: type its root folder and **Connect Google Drive**; Bongsu
   makes each workspace's folder in it ([Google Drive](drive.md)). Or a bucket ([S3-compatible buckets](s3.md)).
   `/health` says `ok: true` once one is connected.
5. **Connections** → **Connect** for each Instagram account and YouTube channel.
6. **Devices & passkeys** → **Add a device**: scan the QR code with the phone or tablet, create its passkey, add the app to the
   home screen and turn on notifications in its Settings. That device approves the posts.
7. **Keys & tokens** → **Agent keys**, if an agent (Claude, a script) will plan posts: create a key with the scopes it needs.

## 9. Go live

When dry runs look right, set `DRY_RUN = "0"` in both wrangler files and deploy both Workers again.

Publishing YouTube videos? Watch the first real upload: if YouTube answers it with 400 or 411, or the run hits the CPU
limit, set `YOUTUBE_UPLOAD_MODE = "chunk"` on the cron Worker
([YouTube: uploads on Cloudflare](youtube.md#uploads-on-cloudflare)).

## Updating

Pull, apply the migrations, build and deploy both Workers again: [Updating](updating.md#on-cloudflare).

## Deploy every release with GitHub Actions

A fork on GitHub can deploy itself whenever its release workflow (`.github/workflows/release.yml`) publishes a new
version of the app: the `deploy-cloudflare` job checks out the released commit, builds it, writes both wrangler
configs from the templates with your values, applies the migrations, deploys `bongsu` and then `bongsu-cron`, and
checks `/health`. It runs only where you turn it on; nothing of yours is in the repository.

1. A Cloudflare API token (**My Profile → API Tokens → Create Token → Custom token**) with the account permissions
   **Workers Scripts: Edit** and **D1: Edit**, for your account only.
2. GitHub → your repository → **Settings → Environments → New environment** `production`. Add **Required reviewers**
   (you) if each deploy should wait for your approval: the job then pauses until you approve it on the run's page.
3. In that environment, **Environment secrets** (secrets, so their values show as `***` in the run's logs, which are
   public on a public repository):

   | Secret | Value |
   |---|---|
   | `CLOUDFLARE_API_TOKEN` | the token from step 1 |
   | `CLOUDFLARE_ACCOUNT_ID` | your account id (`wrangler whoami`) |
   | `D1_DATABASE_ID` | the database's id (step 2 above) |
   | `PUBLIC_URL` | `https://…`, as in your wrangler files |
   | `VAPID_PUBLIC_KEY` | as in your wrangler files |
   | `VAPID_SUBJECT` | as in your wrangler files |

   and the **environment variable** `DRY_RUN` (`1` or `0`).
4. **Settings → Secrets and variables → Actions → Variables**: the repository variable `CLOUDFLARE_DEPLOY` = `true`
   turns the job on.

The Workers' own secrets (`ENCRYPTION_KEY` and the rest from step 7) stay in Cloudflare: a deploy keeps them. The job
writes only the variables above; anything else you set in your wrangler files (the optional ones in step 3) needs a
line in the job too. The database is named `bongsu`, as in step 2.

## Backups

`pnpm exec wrangler d1 export bongsu --remote --output backup.sql`; restoring and the media are in [Backups and restore](backups.md).
