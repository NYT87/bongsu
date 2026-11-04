# Google Drive (the drive media store)

Your Reels and photos stay on your Google Drive. Bongsu reads them with your Google account's permission, streams them
to Instagram through its signed links, picks up files dropped in an inbox folder, takes uploads from the app and moves
posted media aside. Nothing is ever deleted. Drive is one of the media stores: you can use it alone or next to a bucket
([S3-compatible buckets](s3.md)), and the dashboard's **Media** page sets each one up.

## 1. The Google app

Drive connects with the same Google OAuth app as YouTube: one app for both. If you made it for YouTube already, only
steps 2 and 4 are new.

1. [console.cloud.google.com](https://console.cloud.google.com): create a project (or reuse it), then **APIs &
   Services → Library**: enable the **Google Drive API**.
2. **APIs & Services → OAuth consent screen → Data access**: add the scope `https://www.googleapis.com/auth/drive`
   (see, edit, create and delete your Drive files). It's the scope that lets Bongsu see the files you drop in by hand
   and move them; a narrower one (`drive.file`) only sees what Bongsu made itself.
3. **Publish the app** (Publishing status → In production), as for [YouTube](youtube.md#1-the-google-cloud-project):
   while it stays in *Testing*, Google expires its refresh tokens after 7 days. An unverified app of your own works;
   Google shows an "unverified app" warning when you connect (Advanced → continue).
4. **Credentials → your OAuth client → Authorized redirect URIs**: add the Drive URL the dashboard's **OAuth apps**
   page lists on the Google app card, `<PUBLIC_URL>/admin-api/media-stores/drive/callback` (exactly: `https`, no
   trailing slash), next to YouTube's.
5. Dashboard → **OAuth apps** → Google app: paste the client id and secret if they aren't there yet (stored encrypted:
   the instance needs `ENCRYPTION_KEY`, [Configuration](configuration.md)).

## 2. Connect it

Dashboard → **Media** → **Connect Google Drive**. Sign in with the Google account whose Drive holds the media and allow
access; Google sends you back with Drive set up as a store (the first store you add is the default). Bongsu tests it
first: it finds or makes `UPLOADS/inbox`, so reading and writing both work. **Connect again** replaces the grant, for
example after you revoked it in your Google account.

## 3. The folders

Make a top-level folder named **`UPLOADS`** in that Drive. Bongsu finds it by name, so keep only one folder with that
name at the top of your Drive.

| Path | Use |
|---|---|
| `UPLOADS/<channel>/CONTENT/<project>/exports/shorts/instagram/<name>.mp4` | a planned Reel from a repo layout (its `folder` and `name`) |
| `UPLOADS/<channel>/CONTENT/<project>/posts/<post>/` | a planned photo, carousel or Story: the folder's images and videos, in name order |
| `UPLOADS/inbox/<project>/` | drop media here (with an optional `<name>.txt` caption) to get a draft in the app |
| `UPLOADS/_posted/` | where posted media moves a day after it went out; empty it by hand when you like |
| `Bongsu app uploads/` | files uploaded from the app: a top-level folder Bongsu makes on first use |

Planned items given by path (the first two rows) are looked up in the **default** store; drafts from the inbox and
from the app remember the store their files are in. An inbox draft goes to the workspace whose plan has its project;
a project no plan has yet goes to the workspace the store's **Inbox feeds** names (dashboard → Media), or waits
until one is chosen.

## Uploads from the app

The app's Drafts page uploads files from the phone straight to Drive (a resumable upload, up to 1 GB a file; the bytes
never pass through Bongsu). With several stores that take uploads, the page asks which one; the default comes first.

## Good to know

- **Checksums:** an approval records each file's Drive md5. Replacing a file (even with the same name) changes it, so
  the post needs approving again; Drive computes the md5 a moment after an upload, and the app waits for it.
- **Moving files:** Bongsu keeps working when a file moves inside Drive (it uses ids), but a repo-layout item finds its
  media by path, so a renamed folder means its items can't find their media until they're approved again.
- **A revoked grant:** Bongsu checks every store weekly. If Google refuses the grant, the store shows as needing
  attention in the dashboard and the app, and you get one notification: **Connect again** on the Media page.
- **Quotas:** reads and streams count against the Drive API's generous per-project limits; a cron run uses a handful
  of calls (folder ids are remembered for 10 minutes).
