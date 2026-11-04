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

## 4. Accounts come later

Instagram accounts and YouTube channels are connected from the dashboard once it's running (step 8). A deployment
that prefers SQL and secrets can still add the rows by hand: see
[configuration.md](configuration.md#accounts-and-connections-database).

## 5. Create the tables

```sh
pnpm exec wrangler d1 migrations apply bongsu --remote
```

## 6. Set the secrets

See [configuration.md](configuration.md#secrets) for the list. Each one goes to **both** Workers.

The CLI generates and sets them all, `SETUP_TOKEN` included. If you'd rather choose `SETUP_TOKEN` yourself (a long
random string, `openssl rand -hex 32`), set it in both Workers first, still in `apps/cloudflare`; the CLI then keeps
it:

```sh
pnpm exec wrangler secret put SETUP_TOKEN
pnpm exec wrangler secret put SETUP_TOKEN --config wrangler.cron.toml
```

Build the repository (that builds the CLI too), then run the CLI from the repository root:

```sh
cd ../..
pnpm build               # the phone app, the dashboard and the CLI
node packages/cli/dist/cli.mjs deploy-secrets
```

`--config-dir` points it elsewhere; the default is `apps/cloudflare`. You must be logged in to Cloudflare for
wrangler. It sets, in `wrangler.toml` and `wrangler.cron.toml`, through `wrangler secret put`:

- `SETUP_TOKEN`: lets the first person sign up in the dashboard, once. The command prints it (and only when it
  generated it now, not when it kept one already set): copy it for step 8.
- `ENCRYPTION_KEY`: encrypts your OAuth apps' secrets and the accounts' tokens in the database. Keep a copy of it
  elsewhere: without it the stored tokens can't be read, and `--rotate` replaces it.
- `MEDIA_SIGNING_KEY`: signs the media links.
- `VAPID_PRIVATE_KEY`: the private half of the Web Push key pair.

Names already set in both Workers are kept (`kept SETUP_TOKEN in wrangler.toml`); a name set in only one stops the
command, since both Workers need the same value (`--rotate --only <NAME>` fixes it). `--rotate` replaces them and
`--only ENCRYPTION_KEY,SETUP_TOKEN` limits the run. The values are never written to disk, and the only one printed
is the `SETUP_TOKEN` it just generated, once. It also prints the public half of the VAPID pair, which is not secret:

```
VAPID_PUBLIC_KEY = "B…"
```

Paste it over `REPLACE_WITH_YOUR_VAPID_PUBLIC_KEY` in `[vars]` of **both** wrangler configs. Rotating
`VAPID_PRIVATE_KEY` makes existing push subscriptions stop working until the app is opened again.

## 7. Deploy

The app was built in step 6 (the phone app in `packages/web/dist`, the dashboard in `dashboard/` inside it). Deploy
both Workers from `apps/cloudflare`:

```sh
cd apps/cloudflare
pnpm run deploy          # both Workers
```

After a change to the app, run `pnpm build` again from the repository root first.

To give the app your own name, colour and icons, set them before `pnpm build`: [configuration.md](configuration.md#branding).

Check `https://<PUBLIC_URL>/health`: `ok: true`, all tables present, no missing secrets.

## 8. Sign up in the dashboard

1. Open `https://<PUBLIC_URL>/dashboard` on your computer. The first visit asks for the `SETUP_TOKEN` from step 6
   (printed by `deploy-secrets`, or the one you set), your name and email, and creates your passkey (the computer's fingerprint, face or PIN). Save the recovery
   codes it shows: one of them signs you in if you ever lose every passkey. You're the instance's admin; next the
   dashboard asks for your first workspace (a name, its time zone, and its first admin: you, preselected). Then
   **Get started** opens: a checklist of the steps below, each ticked as it's done (the overview links back to it until all four are).
2. **Time zone** and the daily digest's hour, right on Get started (or later in **Settings**).
3. **OAuth apps**: paste your Meta app (Instagram) and Google app (YouTube). Each card shows the redirect URL to
   register in the app; the guides walk through making them: [instagram-graph.md](instagram-graph.md),
   [youtube.md](youtube.md). Composio users skip this ([instagram-composio.md](instagram-composio.md)).
4. **Connections** → **Connect** for each Instagram account and YouTube channel.
5. **Devices & passkeys** → **Add a device**: scan the QR code with the phone or tablet, create its passkey, add the app to the
   home screen and turn on notifications in its Settings. That device approves the posts.
6. **Keys & tokens** → **Agent keys**, if an agent (Claude, a script) will plan posts: create a key with the scopes it needs.

## 9. Go live

When dry runs look right, set `DRY_RUN = "0"` in both wrangler files and deploy both Workers again.

## Updating

Pull, apply the migrations, build and deploy both Workers again: [Updating](updating.md#on-cloudflare).

## Backups

`pnpm exec wrangler d1 export bongsu --remote --output backup.sql`; restoring and the media are in [Backups and restore](backups.md).
