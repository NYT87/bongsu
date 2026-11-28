---
"@bongsu/node": patch
---

The server's disk store is one for the process, so it remembers where files are and their checksums between requests: a video is no longer read in full and hashed again on every media link request and every inbox run.
