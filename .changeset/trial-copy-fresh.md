---
"@bongsu/core": patch
---

A Trial Reel copy no longer inherits its Reel's publishing state. When the Reel's publish had to be retried, the copy
counted as possibly live before it had done anything, so removing its item sent "it may already be public" and kept
it; and a Reel that waited on Instagram shortened its copy's own processing wait.
