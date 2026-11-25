---
"@bongsu/core": patch
---

A temporary Instagram error (a rate limit, a server error, a file Instagram couldn't fetch yet) no longer posts without
the location: only Instagram refusing the place drops it, and any other error retries the post, location and all, on
the next run.
