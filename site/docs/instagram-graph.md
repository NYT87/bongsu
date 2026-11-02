# Instagram through its own API (instagram-graph)

Bongsu can post to Instagram in two ways. Each account uses one, set by its connection:

| | `instagram-graph` (recommended) | `instagram-composio` |
|---|---|---|
| How | Instagram's API ("Instagram API with Instagram Login"), with the account's own token | Composio's Instagram tools, through a Composio connected account |
| You need | a Meta developer app (free, 15 minutes, below), connected from the dashboard | a Composio account and its consumer key |
| Trial Reels | every account (a plain `trial_params` field) | only Composio's default Instagram connection (a workaround through its workbench) |
| Token upkeep | renewed by Bongsu every week (needs `ENCRYPTION_KEY`) | Composio's |

Both do the same things: Reels, photos, carousels, Stories, Trial Reels, comments and replies, 24 h results.

## What you need

- An Instagram **professional** account (Business or Creator). A personal account can switch in the Instagram app:
  Settings → Account type and tools → Switch to professional account. No Facebook Page is needed.
- A Facebook account to sign in to Meta for Developers with (it doesn't have to be linked to the Instagram account).
- A Bongsu that Instagram can reach: Instagram downloads each Reel or photo from Bongsu's signed `/m/` link, so a
  local `wrangler dev` can't publish (it can do everything else). Use your deployed instance, or a quick tunnel to
  the local one (`cloudflared tunnel --url http://localhost:8787`, then set `PUBLIC_URL` to the tunnel's address).

## 1. Create the Meta app

1. Go to [developers.facebook.com/apps](https://developers.facebook.com/apps) and sign in. The first time, it asks you
   to register as a developer (accept the terms, confirm a phone or email).

   <!-- screenshot: developers.facebook.com/apps, signed in: the My Apps list with the Create app button; blur the account name and photo and any other apps' names
   ![Meta for Developers: the apps list with Create app](assets/meta/1-apps.png) -->

2. **Create app**.
   - **App details:** a name (e.g. "Bongsu for <you>"; it can't contain "Instagram" or "IG"), your contact email.
   - **Use cases:** pick **Manage messaging & content on Instagram**.
   - **Business:** "I don't want to connect a business portfolio yet" is fine.
   - Finish and open the app's dashboard.

   <!-- screenshot: the Create app flow on the Use cases step with Manage messaging & content on Instagram selected; blur the contact email
   ![Create app: the use case Manage messaging & content on Instagram](assets/meta/2-create-app.png) -->

3. The app stays in **Development** mode. That's all Bongsu needs for accounts you own or manage: App Review and
   "Live" mode are only for apps other people log in to.

   <!-- screenshot: the new app's dashboard with the Development mode switch at the top; blur the app id and the app name if it's personal
   ![The app's dashboard in Development mode](assets/meta/3-development-mode.png) -->

## 2. Give the Instagram account a role on the app

In development mode, only Instagram accounts with a role on the app can be connected.

1. App dashboard → **App roles** → **Roles** → **Add people** → **Instagram Tester**, and enter the Instagram username.

   <!-- screenshot: App roles → Roles → Add people dialog with Instagram Tester chosen and demo_travel typed as the username; blur the other people listed
   ![App roles: adding an Instagram Tester](assets/meta/4-instagram-tester.png) -->

2. Accept it from Instagram: on the web, [instagram.com/accounts/manage_access](https://www.instagram.com/accounts/manage_access/)
   → **Tester invites** → Accept (in the app: Settings → Website permissions → Apps and websites → Tester invites).

   <!-- screenshot: instagram.com/accounts/manage_access, Tester invites tab, with the app's invite and its Accept button; blur the Instagram username and photo
   ![Instagram: accepting the tester invite](assets/meta/5-tester-invite.png) -->

(Some dashboards skip this and let you add the account directly in the next step; if "Add account" works, go on.)

## 3. Connect from the dashboard

1. App dashboard → **Use cases** → **Manage messaging & content on Instagram** → **Customize** → **API setup with
   Instagram login** (not "with Facebook login").

   <!-- screenshot: Use cases → Manage messaging & content on Instagram → Customize, the API setup with Instagram login page showing its numbered steps; blur the app id
   ![Use cases: API setup with Instagram login](assets/meta/6-api-setup.png) -->

2. Check that the permissions include **instagram_business_basic**, **instagram_business_content_publish**,
   **instagram_business_manage_comments** and **instagram_business_manage_insights** (add any that's missing under
   Permissions).

   <!-- screenshot: the Permissions list of the same use case with the four instagram_business_* permissions marked Ready for testing; nothing to blur
   ![The four instagram_business permissions](assets/meta/7-permissions.png) -->

3. In Bongsu's dashboard, open **OAuth apps**: the Meta app card shows the redirect URL to register,
   `<PUBLIC_URL>/admin-api/connect/instagram/callback`. Copy it.
4. Back on the Meta page, **Set up Instagram business login** (step 3 of that page) → **Business login settings** →
   **OAuth redirect URIs**: paste the URL, **Save**. It must match exactly (`https`, no trailing slash).

   <!-- screenshot: Set up Instagram business login → Business login settings dialog with https://bongsu.example.com/admin-api/connect/instagram/callback in OAuth redirect URIs (type that demo URL in, not your own)
   ![Business login settings: the OAuth redirect URI](assets/meta/8-redirect-uri.png) -->

5. The same page shows the **Instagram app ID** and **Instagram app secret** (not the Facebook app's id and secret on
   Settings → Basic). Paste both into the Meta app card in the dashboard and **Save**: the secret is stored encrypted
   (the Worker needs `ENCRYPTION_KEY`: any long random string, `openssl rand -base64 32`, set once per instance with
   `pnpm exec wrangler secret put ENCRYPTION_KEY`).

   <!-- screenshot: the API setup page's Instagram app ID and Instagram app secret fields, the secret hidden; blur the app id
   ![The Instagram app ID and app secret](assets/meta/9-app-id-secret.png) -->

6. Dashboard → **Connections** → Instagram (Instagram Login) → **Connect**. Instagram asks you to log in with the
   account and allow the permissions, then sends you back to the dashboard with the account connected.

What Bongsu does with it: it exchanges the code for a long-lived token (60 days), asks Instagram which account it
belongs to, and creates the account (or finds the one it already has, by its Instagram user id: an account posting
through Composio switches to the new connection and keeps its plan, approvals and history). Trial Reels are switched
on for accounts with 1,000 followers or more. The token is renewed every week; **Reconnect** on the Connections page
makes a new one if it's ever refused.

### Or paste a token

When the redirect can't be set up (a local instance without a tunnel, say), generate a token on the Meta page instead:

1. **Generate access tokens** → **Add account** → log in.
2. **Generate token** next to the account (a long-lived token, valid 60 days).

   <!-- screenshot: API setup with Instagram login → Generate access tokens, one account added with its Generate token button; blur the username, photo and user id, and never capture a token
   ![Generate access tokens: an added account with Generate token](assets/meta/10-generate-token.png) -->

3. Dashboard → Connections → Instagram (Instagram Login) → **Paste a token**.

Check a token from a terminal:

```sh
curl -s "https://graph.instagram.com/v23.0/me?fields=user_id,username,followers_count&access_token=$TOKEN"
# {"user_id":"1784…","username":"your_account","followers_count":…,"id":"…"}
```

## 4. Without the dashboard (secrets)

A deployment that keeps tokens as Worker secrets can name the secret in the connection instead (Bongsu then renews the
token into the database, encrypted, so `ENCRYPTION_KEY` is still needed):

```sh
cd apps/cloudflare
pnpm exec wrangler secret put IG_TOKEN_YOURACCOUNT          # paste the token
```

```sql
INSERT INTO connections (id, workspace_id, provider, kind, label, secret_name, created_at, updated_at)
  VALUES ('ig_youraccount', 'default', 'instagram', 'oauth', '@your_account', 'IG_TOKEN_YOURACCOUNT',
          unixepoch(), unixepoch());
INSERT INTO accounts (id, workspace_id, platform, handle, external_id, connection_id, capabilities, created_at, updated_at)
  VALUES ('your_account', 'default', 'instagram', 'your_account', '<user_id>', 'ig_youraccount',
          '{"trialReels": true}', unixepoch(), unixepoch());
```

Run it with `pnpm exec wrangler d1 execute bongsu --remote --command "…"` (or `--local`, with the token in
`apps/cloudflare/.dev.vars`).

## 5. Try it

- `GET /v1/accounts` (or `list_accounts` over MCP) lists the account as connected.
- Plan a Reel for it, approve it in the app, and watch the job in the app's Activity (or `GET /v1/jobs`). With
  `DRY_RUN = "1"` every step runs except the publishing itself; set it to `"0"` for a real post.

What a first post looks like (a 6 s test Reel, checked on 2026-10-28 with a local instance behind a quick tunnel):
the container is created at the planned minute, Instagram has processed it about a minute later, the next run
publishes it and the one after posts the first comment and records the post. Instagram's comment list
(`GET /<media>/comments`) may not show the account's own comments yet while they're already visible on the post, so
check the post itself.

## Keeping the token alive

- Every week the inbox cron renews each instagram-graph token (Instagram allows it once a token is a day old) and
  stores the new one encrypted (`connections.credentials`, `expires_at`). A token first given as a secret moves into
  the database on its first renewal; the secret is then unused.
- If a renewal fails, the connection turns `expiring` and you get one notification. If the token runs out (60 days
  without a renewal), it turns `broken` and nothing is posted for that account until it has a new token: generate one
  again (step 3), put it in the secret, and set the connection back:
  `UPDATE connections SET credentials = NULL, status = 'ok', expires_at = NULL, last_error = NULL WHERE id = 'ig_youraccount'`.
- A token stops working at once if the Instagram password changes or the app's access is removed in Instagram.

## Limits

- 100 published posts per account per 24 hours (Instagram's limit for API publishing; Stories and carousels count as
  one each).
- Reels: MP4/MOV, H.264, up to 15 minutes for Reels shared to the feed; photos: JPEG. Instagram fetches the file
  from Bongsu's link and processes it; Bongsu waits for "FINISHED" before publishing (up to 2 hours).
- Comments, replies and insights use the same token; insights need `instagram_business_manage_insights` (it also
  covers the `follows` and `profile_visits` metrics behind the followers a post brought).

Meta's reference: [Instagram API with Instagram Login](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login),
[content publishing](https://developers.facebook.com/docs/instagram-platform/content-publishing),
[changelog](https://developers.facebook.com/docs/instagram-platform/changelog) (Trial Reels in the publishing API).
