---
"@bongsu/core": patch
---

On Postgres, a post whose metrics sampling failed (one deleted on Instagram, say) stopped every later sampling run:
its failure stamp was refused, so it stayed first in line. The stamp is now written and sampling goes on past it.
