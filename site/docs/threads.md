# Threads (threads-graph)

Bongsu publishes to Threads at the planned minute, after you approve each post with your passkey: text posts, images,
videos and carousels. It uses Threads' own API with your profile's token, through a Threads app you make once on Meta
for Developers. It's free, and an app in development mode needs no review for profiles you own.

## What you need

- A Threads profile, and a Facebook account to sign in to Meta for Developers with.
- A Bongsu that Threads can reach: Threads downloads each image or video from Bongsu's signed `/m/` link, as Instagram
  does (see [Instagram](instagram-graph.md) for a tunnel to a local instance).
- `ENCRYPTION_KEY` set, so Bongsu can keep the token and renew it.

## 1. Create the Threads app

1. At [developers.facebook.com/apps](https://developers.facebook.com/apps), **Create app**, and pick the use case
   **Access the Threads API**.
2. In the app, **Use cases → Access the Threads API → Customize**: add the permissions `threads_basic`,
   `threads_content_publish`, `threads_manage_replies`, `threads_read_replies` and `threads_manage_insights`.
3. In the same use case's **Settings**, add the **redirect callback URL** the dashboard shows under **OAuth apps →
   Threads app**: `https://<your Bongsu>/admin-api/connect/threads/callback`. The uninstall and delete callback URLs
   are required too; your instance's address is fine for both.
4. Copy the **Threads app ID** and **Threads app secret** from that page. They are not the app's Meta App ID: Threads
   has its own pair.

The app stays in **Development** mode: that's enough for profiles with a role on it.

## 2. Give your profile a role on the app

1. **App roles → Roles → Add people → Threads Tester**, and enter your Threads username.
2. Accept it in Threads: **Settings → Account → Website permissions → Invites**.

## 3. Connect it

1. In the dashboard, **OAuth apps → Threads app**: paste the Threads app ID and secret.
2. **Connections → Threads → Connect**, sign in to Threads and allow the permissions. The profile appears in
   **Accounts**.

You can also paste a long-lived token you made elsewhere (**Connections → Threads → paste a token**). A token lasts 60
days; Bongsu renews it every week. If it can't (you removed the app's access, or the token ran out), the connection
shows as broken, you get a note, and you connect again.

## What it publishes

- **Text posts**, **image** and **video posts**, and **carousels** of 2 to 20 images and videos.
- An **alt text** for each image (one line of the item's alt text per image, in order).
- The **first and second comment** are posted as replies to the post, from your profile.
- The post's **replies** show in the app's comments, and you can answer them from there.
- **Results:** views, likes, replies and shares, on the same schedule as Instagram's.

## Limits

- **500 characters**, counted the way people see them (an emoji counts as one). A longer text can't be approved.
- **8 MB per image.** Bongsu doesn't resize your files, so approval stops and tells you which image is too large.
- Videos up to **5 minutes**.
- Threads allows 250 posts a day per profile through its API.
- Followers aren't recorded for Threads profiles yet.
