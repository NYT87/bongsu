---
"@bongsu/core": minor
"@bongsu/api": minor
"@bongsu/dashboard": minor
"@bongsu/node": minor
---

Changing a workspace's media folder renames it in place in Google Drive and on the server's disk, files and all, instead of starting an empty folder beside the old one: the files keep their ids, so approved posts, drafts and the inbox carry on. A name a store already has a folder for is refused (folders are never merged), and a rename that fails in one store is put back in the others. A bucket still gets a new folder, and the dashboard says so.
