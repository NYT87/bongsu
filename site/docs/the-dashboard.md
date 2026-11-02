# The dashboard

The dashboard is where you set up and look after an instance: connect accounts, add devices, make keys for agents.
You use it rarely and on a computer. The daily work, approving and watching, happens in the [phone app](the-app.md).
It lives at `https://<your instance>/dashboard` and signs you in with a passkey. Anything that changes who can do what
(connecting, making a key, adding a device, removing something) asks for a fresh passkey check if your last one is
older than 10 minutes. While the instance is in dry run, an amber banner says "Dry run: nothing is published."

![The overview](assets/app/overview-light.png)

The sidebar lists, in order: Overview, Connections, OAuth apps, Accounts, Videos, Devices & passkeys, Keys & tokens,
Audit and Settings. This guide follows it.

## Overview and Get started

**Overview** counts your accounts, connections, posts **Waiting for approval** (approve those in the app) and agent
keys. Under **Needs you** it lists what to fix: no connection yet, connections that are expiring or broken, fewer than
two passkeys, fewer than three recovery codes left.

Until setup is done, a banner reads "Finish setting up: 2 of 4 done." and **Continue** opens **Get started**. Its four
steps can each be done later from their own page: your time zone and daily digest hour, your OAuth apps, an account to
connect, and the device you approve on. A last card, **Then: dry run, and going live**, points to Settings.

## Connections

A connection is how Bongsu reaches a platform: a login or a token. One connection can reach several accounts. **Connected**
lists each with its **Status** (Connected, Expiring or Broken), its **Accounts** and when it **Expires**. **Reconnect**
signs in again; **Remove** keeps the accounts and their plans but publishes nothing to them until they are connected
again, and revokes Bongsu's access where the platform allows it.

![Connections](assets/app/connections-light.png)

**Add a connection** offers three kinds, each with a **Setup guide** link:

- **Instagram (Instagram Login)**: **Connect** signs in with the account, or **Paste a token** takes a long-lived one,
  which Bongsu renews before its 60 days run out. See [Instagram](instagram-graph.md).
- **Instagram (through Composio)**: **Paste the id** takes the connected-account id from Composio. See
  [Instagram through Composio](instagram-composio.md).
- **YouTube channel**: **Connect** signs in with the Google account that owns the channel. See [YouTube](youtube.md).

Google Drive is not a connection here: it is set up with the instance's own settings, see [Google Drive](drive.md).

## OAuth apps

Bongsu signs in to Instagram and YouTube through apps you own: the **Meta app (Instagram)** and the **Google app
(YouTube)**. Each card shows the redirect URL to register in that app, with **Copy**, and takes its ID and secret
(the secret is stored encrypted and isn't shown again). **Replace** changes them; **Remove** stops new connections and
reconnects, but connections already made keep working. Make each app once. If a notice says `ENCRYPTION_KEY` isn't set,
set it first, as the [deploy guide](deploy-cloudflare.md) says.

## Accounts

Each connected Instagram account or YouTube channel is a row:

- **Publishes** says what Bongsu can do with it: Reels, posts and so on for Instagram, and **Trial Reels** when the
  account is set up for them.
- **Trial Reels by default** says whether the account's Reels start as Trial Reels, shown to non-followers first; each
  item can still change it. It reads "Not available yet" for an account that can't post them. See
  [Instagram through Composio](instagram-composio.md) for the limit.
- **Caption checks** holds the account's own rules: **Hashtags max**, **First line chars** and **Language checks**. See
  [Captions and checks](captions-and-checks.md).
- **Rename** changes the display name. **Disable** stops all publishing to the account and keeps its plan, and **Enable**
  undoes it. **Remove** is only offered for a disabled account with nothing left to publish, and what was already
  published stays in the history.

![Accounts](assets/app/accounts-light.png)

## Videos

Each YouTube channel's uploads, with the title, **Kind** (Short or Video), **State** and **When**. **Check YouTube now**
reads the channel at once instead of waiting for the hourly refresh. A scheduled video has **Change date**: pick the date and time,
then **Save**. It moves the release time only; it never makes a video public.

![Videos](assets/app/videos-light.png)

## Devices & passkeys

Your devices approve posts in the app; your passkeys sign you in here and there.

- **Add a device** shows a QR code and a code that works once. Scan it with the phone, create its passkey and add the
  app to the home screen. The page says **Connected** when the device is done, and "The code expired before the device
  used it." if it wasn't.
- **Passkeys** lists each with when it was added and last used. **Add a passkey here** adds one on this computer.
  **Remove** is refused for your only passkey: add another first.
- **Recovery codes**: **Make new codes** shows a fresh set once and cancels the old ones. Each signs you in once when
  every passkey is lost (five tries in 15 minutes). Keep them somewhere safe.

Keep two passkeys and a few recovery codes, so losing a phone doesn't lock you out: Overview reminds you until you have
two passkeys and at least three codes.

## Keys & tokens

![Keys and tokens](assets/app/keys-light.png)

**Agent keys** let an agent or script use Bongsu's API and MCP. **Create a key** asks for a name and what it can do:
`read` (the plan, jobs and notifications), `draft`, `plan` (add, reschedule, hold and remove items), `pause`, and
`reschedule` (move a YouTube release date; not given by default) and `metrics` (upload metrics samples collected
elsewhere; not given by default). Start with `read`, `draft` and `plan`. The key is
shown once; copy it then. A key can't approve or resume, whatever its scopes, and **Revoke** stops it at once. See
[Security](security.md).

**Your CLI tokens** are for the `bongsu` command on your computer. A token acts as you, so keep it like a password:
**Create a token**, name the computer and choose how many days it lasts, and **Revoke** it when the computer goes.

## Audit

Every change to the instance, newest first: when, who, what and the detail. **Load older** shows the next 50.

## Settings

**Workspace** holds the **Time zone**, the default for everyone (each person can choose their own in the app), and the
**Daily digest** hour, in that zone. **Instance** shows the address and whether publishing is **Live** or in **Dry
run**. To go live, change `DRY_RUN` where the instance is configured and deploy again; see
[Configuration](configuration.md). The instance's name and colour are set when the app is built, see
[Branding](configuration.md#branding).
