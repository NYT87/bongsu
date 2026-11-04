# FAQ and troubleshooting

## A post didn't go out. Why?

Open the item in the app and read its state, then check in this order ([the phone app](the-app.md)):

1. **Needs approval** or **Re-approve**: nothing goes out until you approve it with your passkey, and any change to
   its texts or media needs a new approval.
2. **On hold**: you held it; it waits until you press **Release hold**.
3. **Publishing is paused.** (the red banner): approved items wait until you **Resume with passkey**.
4. **Missed by more than 6 hours** (`CATCH_UP_S`, for instance the instance was down): it isn't published late. The
   notification says `<key>: held`, "not published within 6 h of its time"; post it by hand, or move the date and
   approve again. After a pause, overdue items go out only within that window.
5. **Failed.** The notification's title is `<key>: failed` and its text says why: `<platform> reported: <error>`, or
   "<platform> didn't finish processing within 2 h". Bongsu tries a step three times (and waits for Instagram's
   processing up to 24 times) and then stops. Approving it again starts it over from a new upload (an approval made
   after the failure; nothing an agent does reopens it). The exception: once Bongsu has asked the platform to publish,
   the post may be live even though the call failed, so approving again doesn't reopen it, to never post twice. Check
   the account, then record it with `record_posted` ([API reference](api-reference.md)) or post it by hand.

## "A connection needs attention"

A token expired or was revoked, and nothing is posted for that account until it's reconnected. Instagram tokens last 60
days and Bongsu renews them every week; a renewal fails when the Instagram password changed or access was removed in
Instagram. YouTube's refresh token is checked weekly; if the Google app is still in *Testing*, Google expires it after
7 days, so publish the app. Go to the dashboard's **Connections** and **Reconnect**: [Instagram](instagram-graph.md#keeping-the-token-alive),
[YouTube](youtube.md#keeping-it-working). With a mailer set, the workspace's admins also get an email, "Bongsu: a connection needs
attention".

## Instagram refuses a post

- **Limit:** 100 published posts per account per 24 hours.
- **The file can't be fetched:** Instagram downloads the media from Bongsu's signed link, so `PUBLIC_URL` must be
  reachable from the internet over HTTPS (a local instance needs a tunnel: [Instagram](instagram-graph.md)).
- **Never finishes:** Bongsu waits for Instagram to process the video, checking every 5 minutes up to 24 times (2 h),
  then fails the item: "Instagram didn't finish processing within 2 h" (the platform's name is the one Bongsu shows). Check the format (MP4/MOV, H.264) and approve
  again: that starts it over with a new upload.

## YouTube says the quota is gone

The project gets 10,000 units a day; a comment or reply costs 50. Bongsu posts at most two Shorts comments per run, so
a few channels stay far below it; it resets daily ([YouTube](youtube.md#quota)).

## "No media in the store yet: it can't be approved until the file is there."

The item's files aren't where its path says, in the default media store (the dashboard's **Media** page shows which
one that is). On Drive, check the folder names against [Google Drive](drive.md) (a renamed folder loses its items'
media); in a bucket, the keys ([S3-compatible buckets](s3.md)); on the server's disk, the files must be under
`MEDIA_DIR` at the same paths (the `bongsu-media` volume on Docker). A replaced file changes its checksum and needs
approving again.

## The times are off

The database keeps UTC; the zone is only for showing and entering. The workspace's zone is the default, and
**Settings → Time zone** in the app sets yours; changing a zone moves nothing already planned. A new instance starts on
`UTC` ([Configuration](configuration.md#time-zones-and-digest)). An agent reads `due` (on its workspace's clock) and
`due_at` (UTC) ([API reference](api-reference.md)).

## The app says a newer version is deployed

The installed app is an older copy. **Settings → Version → Update now** reloads it ([Updating](updating.md#when-the-app-says-its-behind)).

## I got a new phone

Passkeys belong to a device. From the dashboard's **Devices & passkeys**, **Add a device**, scan the code on the new
phone and create its passkey. If you lost every passkey, a recovery code signs you in once; **Make new codes**
afterwards ([The dashboard](the-dashboard.md#devices--passkeys)).

## "SETUP_TOKEN isn't set on the Worker (site/docs/deploy-cloudflare.md)"

The first visit to the dashboard asks for `SETUP_TOKEN`, and the instance doesn't have one (on Docker the message still says Worker). Set it as a secret
(`bongsu deploy-secrets` generates it and prints it once, or `wrangler secret put SETUP_TOKEN`; in `.env` on Docker), deploy or restart, and try again ([Deploy on Cloudflare](deploy-cloudflare.md)).
