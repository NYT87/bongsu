# Google Drive (the drive media store)

Your Reels and photos stay on your Google Drive. Bongsu reads them with your Google account's permission, streams them
to Instagram through its signed links, picks up files dropped in an inbox folder, takes uploads from the app and moves
posted media aside. Nothing is ever deleted. Drive is one of the media stores: you can use it alone or next to a bucket
([S3-compatible buckets](s3.md)), and the admin dashboard's **Media** page sets each one up.

## 1. The Google app

Drive connects with the same Google OAuth app as YouTube: one app for both. Make it with
[The Google app](google-app.md): the **Google Drive API**, the scope `https://www.googleapis.com/auth/drive`, and the
redirect URI `<PUBLIC_URL>/admin-api/media-stores/drive/callback`. If you made it for YouTube already, add those three
to it (Library, Data Access, and the client's **Authorized redirect URIs**).

## 2. Pick a root folder and connect

Make a folder in your Drive for Bongsu, for example `bongsu` at the top of My Drive. Every workspace gets its own folder
inside it, and Bongsu makes them: you don't create them by hand.

Admin dashboard → **Media** → Google Drive: type the **Root folder** (its name, when it's at the top of My Drive, or paste
the folder's link from Drive), then **Connect Google Drive**. Sign in with the Google account whose Drive holds the
media and allow access; Google sends you back with Drive set up as a store (the first store you add is the default).
Before saving it, Bongsu makes each workspace's folder with its `inbox` in the root, so reading and writing both work.
The root folder is required: **Connect Google Drive** stays disabled until it's typed. (A Drive connected before root
folders existed keeps its folders at the top of My Drive until you save one.)

**Connect again** replaces the grant (for example after you revoked it in your Google account) and keeps the root.
**Save the root folder** moves to another root: the folders are made in the new one, and files already in the old one
stay where they are (move them yourself).

## 3. The folders

Each workspace has a media folder, named after the workspace's id (`w_…`) so renaming the workspace never changes it.
Its admins can give it another name in **Settings → Media**, and a workspace kept from before folders had names uses
**`UPLOADS`**. Bongsu makes the folder with its `inbox` when the Drive is connected and when a workspace is made.
Changing the name in Settings → Media **renames the folder in Drive**, files and all: their ids stay, so approved
posts, drafts and the inbox carry on. The new name must not be a folder that's already there (Bongsu never merges two
folders); pick another, or rename or remove that one in Drive first. The paths below use `UPLOADS`; read it as the workspace's folder, inside the root folder. A Drive
connected by the instance serves every workspace, each in its own folder, and a workspace's admins can also connect
their own Drive, with a root folder of its own, in **Settings → Media** (see [the dashboard](the-dashboard.md#settings)).

| Path | Use |
|---|---|
| `UPLOADS/<channel>/CONTENT/<project>/exports/shorts/instagram/<name>.mp4` | a planned Reel from a repo layout (its `folder` and `name`) |
| `UPLOADS/<channel>/CONTENT/<project>/posts/<post>/` | a planned photo, carousel or Story: the folder's images and videos, in name order |
| `UPLOADS/inbox/<project>/` | drop media here (with an optional `<name>.txt` caption) to get a draft in the app |
| `UPLOADS/_posted/` | where posted media moves a day after it went out; empty it by hand when you like |
| `UPLOADS/_uploads/` | files uploaded from the app: a folder Bongsu makes on first use |

Planned items given by path (the first two rows) are looked up in the **default** store; drafts from the inbox and
from the app remember the store their files are in. Each workspace's inbox
(`<its folder>/inbox`) drafts into that workspace, the one being scanned; nothing waits for a choice.

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
