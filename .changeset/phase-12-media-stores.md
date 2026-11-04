---
"@bongsu/core": minor
"@bongsu/api": minor
"@bongsu/web": minor
"@bongsu/dashboard": minor
"@bongsu/cloudflare": minor
"@bongsu/node": minor
"@bongsu/schema": minor
---

Media stores are set up in the dashboard (**Media**), and there can be several side by side.

- **S3-compatible buckets**: AWS S3, Cloudflare R2, Backblaze B2, MinIO. Instagram fetches the files from the bucket
  through presigned links and the app uploads straight to it ([S3-compatible buckets](site/docs/s3.md)).
- **Connect Google Drive** with your Google app (the one YouTube uses): no service account any more
  ([Google Drive](site/docs/drive.md)).
- One store of each kind, one of them the default; each file is read from the store it's in, the inbox is read in
  every store, and the app's upload page lets you pick the store. A weekly check marks a store that stopped answering.
- Get started has a fifth step for it; the app's Settings and `/health` list the stores.

To update: the `MEDIA_STORE`, `DRIVE_SA_JSON` and `DRIVE_OWNER_OAUTH` variables are gone. Set the store up again on the
dashboard's Media page (Drive with **Connect Google Drive**; on Docker, **This server's disk** for the `local` store),
and remove those secrets. Migration `0017` adds the `media_store` table. Signed media links now name their store
(`/m/<store>/<id>`), so links made before the update stop working; they only last a few hours.
