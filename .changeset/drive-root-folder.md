---
"@bongsu/core": minor
"@bongsu/api": minor
"@bongsu/dashboard": minor
"@bongsu/cloudflare": minor
---

Google Drive gets a root folder: type a folder's name or paste its link on the Media page (or a workspace's Settings → Media) before Connect Google Drive, and every workspace's folder, with its inbox, is made inside it; Save the root folder moves to another later. Bongsu now makes a workspace's folder itself in each store when the store is connected, the workspace is made or its folder changes, instead of failing when it's missing. A new workspace's folder is named after its id, so renaming the workspace never changes it. Run the migrations (0026 adds `oauth_states.flow_settings`).
