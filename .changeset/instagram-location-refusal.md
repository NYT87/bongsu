---
"@bongsu/core": patch
---

A temporary Instagram error (a rate limit, a server error, a file Instagram couldn't fetch yet) no longer posts without
the location, and the published notice no longer says Instagram refused it: only Instagram refusing the place drops it.
Any other error retries the post, location and all, on the next run; one that lasts three runs fails the post with a
notice. A post that takes a while to process (a carousel's items, a Reel, a YouTube upload) no longer
loses its three tries to the waiting.
