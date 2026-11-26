# Bluesky (bluesky-atproto)

Bongsu publishes text and image posts to Bluesky at the planned minute, after you approve them with your passkey. It
signs in with an **app password**: a password you create just for Bongsu, that can post but can't change your account,
and that you can revoke at any time. Nothing costs money and no review or developer account is needed.

## 1. Create an app password

1. In Bluesky: **Settings → Privacy and security → App passwords → Add App Password**.
2. Name it `bongsu` and create it. Copy the password (four groups of letters, like `aaaa-bbbb-cccc-dddd`): Bluesky
   shows it once.

## 2. Connect it

In the dashboard, **Connections → Bluesky (app password)**, paste the handle and the app password as
`handle:app-password`, for example:

```
demo_travel.bsky.social:aaaa-bbbb-cccc-dddd
```

Bongsu signs in once to check it and finds your account. Pasting it again for the same account updates the connection
instead of adding another. Once a week Bongsu signs in again to check the app password still works: if you revoke it,
the connection shows as broken and you get a note, and you reconnect with a new one.

## What it publishes

- **Text posts**, and **image posts** with up to 4 images and an alt text for each (one line of the item's alt text per
  image, in order).
- The **first and second comment** are posted as replies to the post, from your account.
- Links and `#hashtags` in the text are clickable.

## Limits

- **300 characters**, counted the way people see them (an emoji or a family emoji counts as one). The text also can't be over 3,000 bytes (a few hundred emoji). A longer text can't be
  approved.
- **1 MB per image.** Bluesky refuses a bigger image and Bongsu doesn't resize your files, so approval stops and tells
  you which image is too large: export a smaller one and approve again.
- A post needs a caption, as everywhere in Bongsu.
- Videos aren't supported yet: an item with a video can't be approved.
