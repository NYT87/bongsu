# Google Drive (the drive media store)

Your Reels and photos stay on your Google Drive; Bongsu reads them with a service account, streams them to Instagram
through its signed links, picks up files dropped in an inbox folder, and moves posted media aside. Nothing is ever
deleted. How stores work in general: [media-stores.md](../../docs/media-stores.md).

| Piece | What it's for | Needed |
|---|---|---|
| A service account (`DRIVE_SA_JSON`) | reading the media, the inbox, moving posted files to `_posted/` | yes |
| The owner's OAuth (`DRIVE_OWNER_OAUTH`, scope `drive.file`) | uploads from the app (the phone) | only for uploads |

## 1. The service account

1. [console.cloud.google.com](https://console.cloud.google.com): create a project (or reuse one), then **APIs &
   Services → Library**: enable the **Google Drive API**.
2. **IAM & Admin → Service accounts → Create service account** (a name like `bongsu-drive`; no roles needed).
3. Open it → **Keys → Add key → Create new key → JSON**. The downloaded file is the secret: keep it out of git.
4. Note its email (`…@….iam.gserviceaccount.com`).

## 2. The folders

In your Drive, make a top-level folder named **`UPLOADS`** and share it with the service account's email as
**Editor** (Editor, not Viewer: moving posted media into `UPLOADS/_posted/` needs it). Bongsu finds `UPLOADS` by name
among the folders shared with the service account, so share only one folder with that name.

| Path | Use |
|---|---|
| `UPLOADS/<channel>/CONTENT/<project>/exports/shorts/instagram/<name>.mp4` | a planned Reel from a repo layout (its `folder` and `name`) |
| `UPLOADS/<channel>/CONTENT/<project>/posts/<post>/` | a planned photo, carousel or Story: the folder's images and videos, in name order |
| `UPLOADS/inbox/<project>/` | drop media here (with an optional `<name>.txt` caption) to get a draft in the app |
| `UPLOADS/_posted/` | where posted media moves a day after it went out; empty it by hand when you like |

## 3. Give it to Bongsu

```sh
cd apps/cloudflare
pnpm exec wrangler secret put DRIVE_SA_JSON < ~/Downloads/<the key file>.json
pnpm exec wrangler secret put DRIVE_SA_JSON -c wrangler.cron.toml < ~/Downloads/<the key file>.json
```

`MEDIA_SIGNING_KEY` (any long random string, `openssl rand -hex 32`) signs the links Instagram downloads the media
from; set it the same way. `/health` lists either if it's missing.

## 4. Uploads from the app (optional)

With the owner's OAuth, the app's Drafts page uploads files from the phone straight to Drive (resumable, up to 1 GB a
file; the bytes never pass through the Worker). The scope `drive.file` only lets Bongsu write into folders it created
itself, so uploads land in a top-level folder **"Bongsu app uploads"** that Bongsu creates on first use and shares with
the service account.

1. In the same Google Cloud project: an **OAuth consent screen** (External, published to production, as for
   [YouTube](youtube.md#1-the-google-cloud-project)) with the scope `https://www.googleapis.com/auth/drive.file`, and an
   **OAuth client** (Web application, redirect URI `https://developers.google.com/oauthplayground`).
2. Get a refresh token for your Google account in the [OAuth Playground](https://developers.google.com/oauthplayground)
   with your own credentials and the scope `https://www.googleapis.com/auth/drive.file` (the same steps as for
   [YouTube](youtube.md#3-without-the-dashboard-secrets)).
3. Set `DRIVE_OWNER_OAUTH` on both Workers to
   `{"client_id": "…", "client_secret": "…", "refresh_token": "…", "token_uri": "https://oauth2.googleapis.com/token"}`.

Without it, the app hides the upload button; everything else works.

## Good to know

- **Checksums:** an approval records each file's Drive md5. Replacing a file (even with the same name) changes it, so the
  post needs approving again; Drive computes the md5 a moment after an upload, and the app waits for it.
- **Moving files:** Bongsu keeps working when a file moves inside Drive (it uses ids), but a repo-layout item finds its
  media by path, so a renamed folder means its items can't find their media until they're approved again.
- **Quotas:** reads and streams count against the Drive API's generous per-project limits; a cron run uses a handful of
  calls (folder ids are remembered for 10 minutes).
