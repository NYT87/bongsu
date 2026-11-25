---
"@bongsu/core": patch
---

A Trial Reel copy no longer inherits its Reel's publishing state. When the Reel's publish had to be retried, the copy
counted as possibly live before it had published, so removing its item while the copy was processing refused it with
a wrong "it may already be public" warning.
