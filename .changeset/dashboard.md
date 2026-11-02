---
"@bongsu/core": minor
"@bongsu/api": minor
"@bongsu/web": minor
"@bongsu/cloudflare": minor
"@bongsu/dashboard": minor
---

The dashboard at `/dashboard`, for setting up and managing an instance without a terminal. The first person signs up with the `SETUP_TOKEN` secret and a passkey (and gets recovery codes); after that, sign-in is an email and a passkey. Its sections: an overview of what needs attention, connections, OAuth apps, accounts (Trial Reels default, rename, disable), phones and passkeys (add a phone with a QR code), agent keys (created with scopes, shown once) and an audit log. Changes to who can do what ask for the passkey again after 10 minutes.

Accounts are connected from it: bring your own Meta and Google apps (the page shows the redirect URLs to register; their secrets are stored encrypted), then **Connect** Instagram (Instagram Login) or YouTube (Google, with PKCE). Bongsu finds which accounts the grant reaches and creates them, or takes over the ones it has, so a reconnect keeps each account's plan. An Instagram token or a Composio connected-account id can be pasted instead. Removing a connection revokes Google's grant and keeps the accounts.
