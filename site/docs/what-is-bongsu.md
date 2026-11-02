# What is Bongsu

Bongsu publishes your planned content to your accounts at the planned time, after you have approved it with a passkey.
It posts Instagram Reels, photos, carousels, Stories and Trial Reels, and comments on YouTube Shorts.

## Main ideas

- **Plan item.** One thing to publish for one account: a Reel, or a photo, carousel or Story. It has a date and time,
  its texts (caption, a comment from your own account, an optional second comment, alt texts) and its media, which stay
  on your own storage, for example Google Drive.
- **Approval.** You approve an item with a passkey in the app. The approval covers the exact texts and media: change
  either and the item needs your approval again. An item you haven't approved is never published.
- **Drafts and the inbox.** Files you drop in the inbox folder on Drive, and drafts that an agent proposes, wait in
  the app's Drafts page. You schedule or refuse each one.
- **Shorts comments.** A list of your YouTube Shorts that get your comment once they are public. Each text is approved
  like a post.
- **Trial Reels.** For accounts that qualify, a Reel can be shared as a Trial Reel, shown to people who don't follow
  you first. Each account has a default and each Reel its own switch.
- **Notifications.** A push to the installed app and, if you like, a webhook such as ntfy, plus a daily digest.
- **Results and comments.** A day after a post goes out, its first results are stored. New comments appear in the
  app, where you can reply.

## What Bongsu isn't

- Not a hosted service. You run it yourself, on Cloudflare or in Docker, with one workspace per instance for now.
- Not set up by hand alone: the dashboard connects your accounts, storage and devices.
- Not tied to one way of reaching Instagram: it uses Instagram's own API, or Composio.

How a post goes from your plan to your account: [how-it-works.md](how-it-works.md).
