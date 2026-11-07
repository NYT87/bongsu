# YouTube (youtube-data)

Bongsu uploads your Shorts and videos and makes them public at the planned minute ([uploading
videos](#uploading-videos)), and comments on videos published anywhere: the **Shorts comments**. Add a Short's id and
the comment's text (the app, `shorts_add` over MCP, or `POST /v1/shorts`), approve the text with your passkey on the
Short's page in the app (as with a post: a changed text waits for you again), and Bongsu posts the comment as your
channel once the video is public, then shows new comments in the app's inbox and replies from there.

Each channel is connected with your own Google OAuth app (one app for every channel), from the dashboard.

## 1. The Google Cloud project

1. [console.cloud.google.com](https://console.cloud.google.com): create a project (or reuse the one for Drive,
   [drive.md](drive.md)).

   <!-- screenshot: console.cloud.google.com, the project picker's New project form with a demo name (bongsu-demo); blur the organisation and billing account
   ![Google Cloud: creating a project](assets/google/1-project.png) -->

2. **APIs & Services → Library**: enable **YouTube Data API v3**.

   <!-- screenshot: APIs & Services → Library → YouTube Data API v3, its page with the Enable button (or Manage once enabled); blur the project id in the header
   ![The YouTube Data API v3 in the API Library](assets/google/2-youtube-api.png) -->

3. **APIs & Services → OAuth consent screen**: user type **External**, an app name and your email. Add two scopes:
   `https://www.googleapis.com/auth/youtube.force-ssl` (manage your YouTube account: needed to post comments) and
   `https://www.googleapis.com/auth/yt-analytics.readonly` (view your YouTube Analytics reports: the subscribers a
   video brought). Enable the **YouTube Analytics API** in the Library too, next to the Data API.

   <!-- screenshot: OAuth consent screen, the Data access / scopes list showing .../auth/youtube.force-ssl added; blur the support email and the project id
   ![OAuth consent screen: the youtube.force-ssl scope](assets/google/3-consent-scope.png) -->

4. **Publish the app** (Publishing status → In production). While it stays in *Testing*, Google expires its refresh
   tokens after 7 days and Bongsu loses the channel every week. An unverified app in production works for your own
   channels; Google only shows an "unverified app" warning on the consent screen (Advanced → continue).

   <!-- screenshot: OAuth consent screen → Audience, Publishing status In production, user type External; blur the project id
   ![OAuth consent screen: publishing status In production](assets/google/4-in-production.png) -->

5. **Credentials → Create credentials → OAuth client ID**, type **Web application**. Under **Authorized redirect URIs**
   add the URL the dashboard's **OAuth apps** page shows on the Google app card,
   `<PUBLIC_URL>/admin-api/connect/youtube/callback` (exactly: `https`, no trailing slash). Create it and copy the
   client id and secret.

   <!-- screenshot: Credentials → Create OAuth client ID, type Web application, Authorized redirect URIs with https://bongsu.example.com/admin-api/connect/youtube/callback (type that demo URL in); never capture the client secret dialog
   ![OAuth client ID: Web application with the redirect URI](assets/google/5-oauth-client.png) -->

## 2. Connect the channel from the dashboard

1. Dashboard → **OAuth apps** → Google app: paste the client id and secret, **Save** (the secret is stored encrypted:
   the Worker needs `ENCRYPTION_KEY`, any long random string set once with `pnpm exec wrangler secret put
   ENCRYPTION_KEY`).
2. **Connections** → YouTube channel → **Connect**. Sign in with the Google account that owns the channel (for a brand
   channel, pick it when Google asks) and allow access. Google sends you back with the channel connected.

Bongsu asks for offline access (a refresh token) with PKCE, reads which channel the grant is for and creates its
account: the account's id comes from the channel's handle (`@ourchannel` → `ourchannel`), and it's what Shorts comments
name as their channel (`shorts_add` with `channel: "ourchannel"`). Repeat per channel; the same Google app serves them
all.

A channel already set up from a secret (below) moves to the dashboard with **Reconnect** on its connection: the account
keeps its id, plan and history, and the refresh token is stored encrypted in the database from then on.

**Reconnect for subscriber numbers.** A channel connected before the analytics scope was asked for has no
subscribers-gained numbers: its video pages say "not available until the channel is reconnected with analytics".
Add the scope to the consent screen if it isn't there, then **Reconnect** the channel from the dashboard; the new
grant carries both scopes and the next samples bring the numbers.

## 3. Without the dashboard (secrets)

A deployment that keeps credentials as Worker secrets can name the secret in the connection instead. Get a refresh
token with the [OAuth Playground](https://developers.google.com/oauthplayground) (gear → **Use your own OAuth
credentials**; add `https://developers.google.com/oauthplayground` to the client's redirect URIs; the scopes
`https://www.googleapis.com/auth/youtube.force-ssl` and `https://www.googleapis.com/auth/yt-analytics.readonly`;
**Exchange authorization code for tokens**), then store one JSON value per channel. Its `scope` lists what the token
was granted: Bongsu asks YouTube Analytics for the subscribers a video brought only when it holds the analytics
scope, so a value without it keeps the video pages on "not available" until you store a new one:

```json
{"client_id": "…", "client_secret": "…", "refresh_token": "…", "token_uri": "https://oauth2.googleapis.com/token",
 "scope": "https://www.googleapis.com/auth/youtube.force-ssl https://www.googleapis.com/auth/yt-analytics.readonly"}
```

```sh
cd apps/cloudflare
pnpm exec wrangler secret put YT_MAIN_OAUTH                   # paste the JSON
pnpm exec wrangler secret put YT_MAIN_OAUTH -c wrangler.cron.toml
```

```sql
INSERT INTO connections (id, workspace_id, provider, kind, label, secret_name, created_at, updated_at)
  VALUES ('c_main', 'default', 'youtube', 'oauth', 'Main channel', 'YT_MAIN_OAUTH', unixepoch(), unixepoch());
INSERT INTO accounts (id, workspace_id, platform, handle, display_name, external_id, connection_id, created_at, updated_at)
  VALUES ('main', 'default', 'youtube', 'main', 'Main channel', '<channel id, UC…>', 'c_main', unixepoch(), unixepoch());
```

## Uploading videos

A video is a plan item on a YouTube channel, planned like a Reel and approved with your passkey in the app. Its **title**
is 1 to 100 characters (it may be empty while you edit, but approval needs it), and its **description** is the caption
(at most 5000 characters; a description is required, as every caption is). It can also have a language, the audio
language, tags (500 characters as YouTube counts them), **translations** (a title and a description per language, at
most 5 read from the inbox; YouTube takes them only with the video's language set), **subtitles** and a **thumbnail**. Instagram posts have no title or translations, and a
video draft with subtitle or thumbnail files can't be scheduled on an Instagram account.

Edit them on the item's page in the app, with `plan_add` / `plan_update` / `create_draft` (`texts`), or with
`bongsu texts set --title` and `--translation` ([the CLI](cli.md)). Subtitles and a thumbnail only come with a draft
(the app's upload, the inbox or `create_draft`): a video planned with `plan_add` from a repository is the single file.
A short vertical video of at most 180 seconds gets a Shorts link.

### The 6 h lead and the waiting

Bongsu uploads **6 hours before** the planned time, so processing is finished when the time comes. The upload goes up
private, then Bongsu adds the subtitles and the thumbnail and waits for YouTube to process the video. The app shows
where it is: "Uploading, 40%", "Adding subtitles", "YouTube is processing", "Ready: goes public at 18:00". The video
stays private while it waits; at the planned time Bongsu makes it public, unless the approval no longer matches (a
changed title, time, made for kids or visibility: the video stays private and waits for you). A video planned less than 6 hours ahead starts at
the next run and goes public at its time if processing is done by then, else as soon as it is. A paused workspace's
ready video stays private past its time and goes out after you resume, within the 6 hour catch-up.

Approving again during the lead (a new title, new subtitles, a new thumbnail) **revises the same video in place**: only
what changed is sent. A different video file replaces the upload instead: the old private video is deleted and the new
one goes up. So does removing the thumbnail, since YouTube can't take a custom thumbnail off a video. Instagram posts at the same time are never held up by a long upload: each run advances them first.

A **dry run** sends its note at the upload time, 6 hours before the planned one, and uploads nothing.

### Removing and failing

Removing the item (or withdrawing the draft) **deletes its private video** at the next run. It doesn't in dry run, and
not while the workspace is paused or archived: the delete waits until it isn't. A job that **fails for good** keeps its
private video, and the note says it is there to look at or publish by hand. A video Bongsu was making public when its
answer got lost may already be public: removing or holding its item, editing it before the retry, or the retry missing
its catch-up window then keeps it as it is, never deleted or made private again, and the note asks you to check it on
the channel.

### The audit lock

A Google project that hasn't passed [YouTube's API audit](https://developers.google.com/youtube/v3/guides/quota_and_compliance_audits)
has every video uploaded through the API locked to private: YouTube refuses to publish it. Bongsu notices when it reads
the video back, keeps it and shows **Private: needs YouTube's audit**, with the note "YouTube keeps this video private
until your Google project passes YouTube's audit (see the YouTube guide)". Apply for the audit with Google for your
project; the videos already uploaded stay, and you can publish them from YouTube Studio meanwhile.

### Files for the inbox

A video's folder in the inbox (`inbox/<project>/<post>/`) holds the video plus any of:

- `title.txt` and `caption.txt`;
- `caption.<lang>.txt` and `title.<lang>.txt`: a translation needs both, and at most 5 are read. The files don't say
  the video's own language, which YouTube needs with translations: the draft says so, and you set it before scheduling;
- `<lang>.srt` or `<lang>.vtt`: a subtitle track, one per language (`es.srt` beside `es.vtt` is refused);
- `thumbnail.jpg` or `thumbnail.png`: at most one, up to 50 MB;
- for a lone `<name>.mp4`: `<name>.title.txt`.

Any other file stops the check: "<name> isn't a video, a subtitle file (<lang>.srt or .vtt) or thumbnail.jpg/png".
A channel without YouTube's verified features gets YouTube's refusal of the thumbnail as a note; the video still goes
out.

### Channel defaults

Whether a channel's videos are **made for kids** and their **category** (a number, `22` by default) are set per channel
in the dashboard's **Accounts** page; a video's own options win. Privacy is `public` unless the video says `unlisted`.
Your approval covers **made for kids** and **visibility** as the video would go out: changing either on the video, or
changing the channel's made-for-kids default for a video that follows it, needs a new approval. The category doesn't.

### Uploads on Cloudflare

Bongsu streams the file from the media store into YouTube's resumable upload; a run that is cut off (about 3 minutes
after it started, for all its uploads together) resumes from the offset YouTube kept. Streaming's CPU cost on the Workers free plan **was not measured** (the check
needs a deploy). If an upload fails on the CPU limit, set the variable `YOUTUBE_UPLOAD_MODE` to `chunk` on the cron
Worker (a `[vars]` entry in `wrangler.cron.toml`, then deploy): the file then goes in 8 MiB pieces, as many as the
run's 50 subrequests allow (about 20, so some 160 MiB a run); the next run goes on from there. Node doesn't need it.

**Watch the first real upload.** The streamed upload sends the file as a stream with its length set by hand, which hasn't
been tried on Cloudflare yet. Schedule a first video you can watch going up
(`pnpm exec wrangler tail --config wrangler.cron.toml` in `apps/cloudflare`). If YouTube answers the upload with **400**
or **411**, or the run stops on the **CPU limit**, set `YOUTUBE_UPLOAD_MODE = "chunk"` as above and deploy the cron Worker
again.

## Moving a release date

A video uploaded as private with a release time elsewhere can have that time moved (for a video Bongsu uploaded, move the
item's time in the app instead: it needs a new approval). Only a scheduled video qualifies: private,
with a release time in the future. Bongsu changes the time and nothing else, so it never makes a video public.

- **App:** the video's page has a **Release date** card. **Change date**, pick the day and time in your zone, **Save new
  date**, then confirm with your passkey.
- **Dashboard:** the **Videos** page lists each channel's videos. **Change date** on a scheduled row, confirmed with a
  passkey check from the last 10 minutes. **Check YouTube now** re-reads the channel.
- **API and MCP:** `youtube_reschedule` (`POST /v1/youtube/reschedule`) with the `reschedule` scope. A key must leave at
  least an hour; the owner has no minimum beyond "in the future". A public video gets 409, and so does a past time for
  the owner. A key's time under an hour ahead (a past time included) gets 400.

Each move is audited (`release_move`) and you get a "Release moved" notification saying who did it.

## Keeping it working

Every week the inbox cron checks each channel's refresh token with Google. If Google refuses it (access removed in
the Google account, the password changed, or the app left in Testing), the channel turns `broken`, you get one
notification, and no comment is posted for it until it's reconnected: **Reconnect** on the dashboard's Connections
page. **Remove** there also revokes Bongsu's access at Google; the account stays (with its Shorts comments) until it's
connected again.

## Quota

The YouTube Data API gives a project 10,000 units a day. An upload costs 1,600 units, each subtitle track 400, and the
thumbnail, a revision and a delete 50 each: with the default quota that is a handful of uploads a day, fewer with
subtitles. When YouTube says the quota or the upload limit is used up, the job waits without counting an attempt until
midnight Pacific time (when the quota resets) and you get one note a day in Problems: "YouTube's daily quota is used up:
uploads continue after midnight Pacific time". Ask Google for a higher quota if you upload more. A comment costs 50, a reply 50, reading a video's comments 1
and checking up to 50 videos' privacy 1. Moving a release date costs 51 (1 to read the video, 50 to update it). Bongsu posts at most two Shorts comments per cron run and reads comments for
recent posts only, which stays far below the quota for a few channels.

The [results series](how-it-works.md#results-and-comments) reads public uploads' statistics with `videos.list`: 1
unit for up to 50 videos, at most one call per channel per cron run, covering every video of that channel due for a
sample. A video costs at most 4 calls a day in its first 3 days (a sample every 6 hours), one a day until day 30,
one a week until day 90, then none, and videos due in the same run share a call: a channel with a handful of recent
uploads adds a few dozen units a day at most. To know which videos to sample, the series also refreshes each
channel's list of uploads once it is an hour old: 3 units a refresh (the channel, its uploads playlist, the videos'
details), at most two channels per cron run. That is roughly 72 units a day per channel in the worst case, plus the
statistics calls.

The subscribers a video brought come from the **YouTube Analytics API**, which has its own quota, separate from the
Data API's: one `reports.query` per channel per cron run for the videos due a sample (one more for every 50 beyond
the first 50, which few runs reach), only for a channel connected with the analytics scope.

The channel's own subscriber count, for the Stats page, is one `channels.list` a day: 1 unit. YouTube rounds it
(three significant figures above 1,000).
