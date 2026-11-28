---
"@bongsu/node": patch
---

A second process with `SCHEDULES=off` (a replica) no longer frees the main process's locks when it starts or stops, so the main process's runs can't overlap.
